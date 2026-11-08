import type { Socket } from "node:net";
import { PiscesError } from "@pisces/core";
import { createActiveTurnStore } from "../gateway/active-turn.js";
import { bootstrapGateway } from "../gateway/bootstrap.js";
import type { Gateway, GatewayDeps } from "../gateway/gateway.js";
import { createConcurrency } from "../runtime/concurrency.js";
import { createEventBus } from "../runtime/event-bus.js";
import type { RecoveryIssue } from "../session-store/session-store.js";
import { createSessionStore } from "../session-store/session-store.js";
import { type Connection, createConnection } from "../transport/connection.js";
import {
  assertLinuxPlatform,
  assertUnambiguousProcessIdentity,
  createUnixTransport,
  probePeerCredentials,
  type UnixTransport,
} from "../transport/unix-transport.js";
import { acquireDaemonLock } from "./lock.js";
import { clearStaleSocket, prepareRuntimePaths } from "./runtime-paths.js";

/**
 * Programmatic daemon composition for one data directory.
 *
 * Startup is ordered so that no client byte can be accepted before the store is
 * initialized, committed-turn markers are recovered and the public socket is
 * verified: platform/identity → private runtime paths → single-instance lock →
 * native peer-credential self-probe → stale socket handling → Gateway
 * bootstrap/recovery → bind/serve. Every failure releases only resources this
 * attempt acquired; another instance's live socket and lock inode are never
 * unlinked.
 *
 * Stop is ordered so no admitted work can outlive the lock: synchronously gate
 * new frames on every connection → stop accepting → wait every admitted request
 * (including work whose client disconnected) → cancel registered turns and wait
 * for marker cleanup and unregistration → close/detach connections → close
 * the listener and inode-checked unlink → release the lock → dispose the
 * Gateway handler → `stopped`. A pending timeout, a surviving registered turn,
 * a failed marker cleanup or a failed teardown/release all throw the normalized
 * `daemon.stop_incomplete` error and retain the lock, socket, Gateway and
 * quiescing state where they are still held; a retry re-runs the same sequence
 * instead of reporting a stopped daemon. Gateway disposal is last so a
 * listener-unlink or lock-release failure cannot leave a retryable daemon
 * without its event handler; this is not transactional restoration of an
 * already-closed socket.
 */

/** Public stop deadlines: admitted-request drain and turn-cancellation cleanup. */
const STOP_DRAIN_TIMEOUT_MS = 5000;
const STOP_CANCEL_TIMEOUT_MS = 5000;

const START_CODES = new Set([
  "daemon.unsupported_platform",
  "daemon.native_unavailable",
  "daemon.peercred_probe_failed",
  "daemon.lock_busy",
  "daemon.lock_failed",
  "daemon.insecure_directory",
  "daemon.socket_live",
  "daemon.socket_path_too_long",
  "daemon.start_failed",
]);

export type StartDaemonOptions = { dataDir: string } & Pick<
  GatewayDeps,
  | "providers"
  | "providerHost"
  | "defaults"
  | "createTools"
  | "entries"
  | "skills"
  | "sources"
  | "validateWorkspace"
  | "newSessionId"
  | "newTurnId"
  | "newQueueEntryId"
  | "newNodeId"
  | "now"
>;

export interface DaemonHostStatus {
  state: "running" | "quiescing" | "stopped";
  activeTurns: number;
}

export interface DaemonHost {
  socketPath: string;
  initializationIssues: RecoveryIssue[];
  recoveryIssues: RecoveryIssue[];
  status(): DaemonHostStatus;
  stop(): Promise<void>;
}

/**
 * Internal seams for host-ordering tests. Deliberately not re-exported from the
 * package index: public `startDaemon` always runs the real native self-probe,
 * never exposes an authentication bypass, and always uses the 5 s stop deadlines.
 */
export interface DaemonStopDeadlines {
  /** How long admitted requests may take to settle before stop fails closed. */
  pendingDrainMs?: number;
  /** How long cancelled turns may take to finish marker cleanup and unregister. */
  cancelAllMs?: number;
}

export interface DaemonHostSeams {
  probePeerCredentials?: (runDir: string) => Promise<void>;
  /** Test-only shortened deadlines; production stop always uses 5000 ms. */
  stopDeadlines?: DaemonStopDeadlines;
}

const startFailed = (): PiscesError =>
  new PiscesError("daemon.start_failed", "daemon could not start");

const stopIncomplete = (): PiscesError =>
  new PiscesError("daemon.stop_incomplete", "daemon stop did not complete");

/** Accept a positive test deadline only; anything else keeps the public default. */
const stopDeadline = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;

/** Preserve only documented safe startup codes; drop every raw internal failure. */
const normalizeStartError = (error: unknown): PiscesError => {
  if (error instanceof PiscesError) {
    if (error.code === "daemon.peer_credentials_unavailable") {
      return new PiscesError("daemon.native_unavailable", "native binding is unavailable");
    }
    if (START_CODES.has(error.code)) return error;
  }
  return startFailed();
};

const drainWithin = async (waits: Promise<void>[], timeoutMs: number): Promise<boolean> => {
  if (waits.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([Promise.all(waits).then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export function startDaemon(options: StartDaemonOptions): Promise<DaemonHost> {
  return startDaemonWithSeams(options, {});
}

// Module-internal entry point (not exported from the package index) used only to
// verify startup ordering with a rejecting probe.
export async function startDaemonWithSeams(
  options: StartDaemonOptions,
  seams: DaemonHostSeams,
): Promise<DaemonHost> {
  const probe = seams.probePeerCredentials ?? probePeerCredentials;
  const pendingDrainMs = stopDeadline(seams.stopDeadlines?.pendingDrainMs, STOP_DRAIN_TIMEOUT_MS);
  const cancelAllMs = stopDeadline(seams.stopDeadlines?.cancelAllMs, STOP_CANCEL_TIMEOUT_MS);
  // Platform and process identity are checked before the deferred native import runs.
  assertLinuxPlatform();
  assertUnambiguousProcessIdentity(process.getuid?.(), process.geteuid?.());

  let paths: Awaited<ReturnType<typeof prepareRuntimePaths>>;
  try {
    paths = await prepareRuntimePaths(options.dataDir);
  } catch (error) {
    throw normalizeStartError(error);
  }

  let lock: Awaited<ReturnType<typeof acquireDaemonLock>>;
  try {
    lock = await acquireDaemonLock(paths.lockPath);
  } catch (error) {
    throw normalizeStartError(error);
  }

  const connections = new Set<Connection>();
  const retiring = new Set<Promise<void>>();
  let transport: UnixTransport | undefined;
  let gateway: Gateway | undefined;
  let state: DaemonHostStatus["state"] = "running";
  let stopPromise: Promise<void> | undefined;

  try {
    await probe(paths.runDir);
    await clearStaleSocket(paths.socketPath);

    const store = createSessionStore({ dataDir: options.dataDir });
    const markers = createActiveTurnStore({ dataDir: options.dataDir });
    const events = createEventBus();
    const concurrency = createConcurrency();
    const bootstrapped = await bootstrapGateway({
      store,
      markers,
      events,
      concurrency,
      providers: options.providers,
      providerHost: options.providerHost,
      ...(options.defaults !== undefined ? { defaults: options.defaults } : {}),
      ...(options.createTools !== undefined ? { createTools: options.createTools } : {}),
      ...(options.entries !== undefined ? { entries: options.entries } : {}),
      ...(options.skills !== undefined ? { skills: options.skills } : {}),
      ...(options.sources !== undefined ? { sources: options.sources } : {}),
      ...(options.validateWorkspace !== undefined
        ? { validateWorkspace: options.validateWorkspace }
        : {}),
      ...(options.newSessionId !== undefined ? { newSessionId: options.newSessionId } : {}),
      ...(options.newTurnId !== undefined ? { newTurnId: options.newTurnId } : {}),
      ...(options.newQueueEntryId !== undefined
        ? { newQueueEntryId: options.newQueueEntryId }
        : {}),
      ...(options.newNodeId !== undefined ? { newNodeId: options.newNodeId } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    gateway = bootstrapped.gateway;
    const activeGateway = gateway;

    function accept(socket: Socket): void {
      const connection = createConnection(socket, activeGateway);
      if (state !== "running") {
        // Stop already began; a socket accepted in that window is never admitted.
        connection.quiesce();
        connection.close();
        return;
      }
      connections.add(connection);
      socket.once("close", () => {
        connections.delete(connection);
        // Admitted operations outlive the socket; keep tracking them until settled so a
        // stop can wait for every accepted request, even after its client disconnected.
        const pending = connection.pending().then(() => {
          retiring.delete(pending);
        });
        retiring.add(pending);
      });
    }

    const listener = createUnixTransport({
      socketPath: paths.socketPath,
      onAuthenticatedSocket: accept,
    });
    transport = listener;
    await listener.start();

    const host: DaemonHost = {
      socketPath: paths.socketPath,
      initializationIssues: bootstrapped.initializationIssues,
      recoveryIssues: bootstrapped.recoveryIssues,
      status() {
        return { state, activeTurns: concurrency.activeTurns().length };
      },
      stop() {
        if (state === "stopped") return Promise.resolve();
        stopPromise ??= (async () => {
          // 1. Synchronously gate new frames before any await: a `turn.start`
          //    admitted after this point could otherwise register behind the
          //    cancelAll snapshot and escape cancellation.
          state = "quiescing";
          for (const connection of connections) connection.quiesce();

          // 2. Stop accepting new connections.
          listener.stopAccepting();

          // 3. Wait for every already-admitted request, including operations
          //    whose client disconnected while they were in flight.
          const waits: Promise<void>[] = [];
          for (const connection of connections) waits.push(connection.pending());
          for (const pending of retiring) waits.push(pending);
          if (!(await drainWithin(waits, pendingDrainMs))) throw stopIncomplete();

          // 4. Cancel registered turns and wait for marker cleanup plus
          //    unregistration. `cancelAll` can resolve on timeout, so abort is
          //    never treated as completion: a surviving registration (including
          //    a retained cleanup_failed marker) fails the stop closed.
          await concurrency.cancelAll(cancelAllMs);
          if (concurrency.activeTurns().length > 0) throw stopIncomplete();

          // 5. Tear down only after no admitted request or turn can still be live.
          for (const connection of [...connections]) connection.close();
          connections.clear();
          await listener.close();
          await lock.release();
          activeGateway.dispose();
          state = "stopped";
        })()
          .catch(() => {
            // Every stop failure is the documented incomplete-stop error: raw
            // close/transport messages never escape and a retry stays possible.
            throw stopIncomplete();
          })
          .finally(() => {
            stopPromise = undefined;
          });
        return stopPromise;
      },
    };
    return host;
  } catch (error) {
    await transport?.close().catch(() => {});
    gateway?.dispose();
    await lock.release().catch(() => {});
    throw normalizeStartError(error);
  }
}

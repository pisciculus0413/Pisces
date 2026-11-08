import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import { chmod, lstat } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { PiscesError } from "@pisces/core";
import { removeOwnedSocket, type SocketIdentity } from "../host/runtime-paths.js";

/**
 * Linux authenticated Unix-domain listener.
 *
 * A production listener never hands a socket to the application until the
 * kernel peer UID matches the daemon effective UID. Sockets are accepted
 * paused, so no client byte can be read before the native credential check.
 * Credential failures close only that connection; startup failures abort the
 * bind. There is no chmod-only or unauthenticated fallback.
 *
 * `peerUidFor` and `platform` are internal seams used by tests. Production
 * `startDaemon` must never pass them.
 */

export type PeerUidReader = (socket: Socket) => number;

export const DEFAULT_MAX_CONNECTIONS = 64;
const PROBE_TIMEOUT_MS = 1000;
const MAX_SOCKET_PATH_BYTES = 107;
const PROBE_PREFIX = "pisces-probe-";

const unsupportedPlatform = (): PiscesError =>
  new PiscesError("daemon.unsupported_platform", "platform is not supported");

const startFailed = (): PiscesError =>
  new PiscesError("daemon.start_failed", "daemon listener could not start");

const probeFailed = (): PiscesError =>
  new PiscesError("daemon.peercred_probe_failed", "peer credential probe failed");

const nativeUnavailable = (): PiscesError =>
  new PiscesError("daemon.native_unavailable", "native peer credential binding is unavailable");

export function assertLinuxPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux") throw unsupportedPlatform();
}

/**
 * A setuid binary would make the kernel peer UID and the application identity
 * disagree about who the daemon is, so startup refuses the ambiguity instead
 * of choosing one of them.
 */
export function assertUnambiguousProcessIdentity(
  uid: number | undefined,
  euid: number | undefined,
): void {
  if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 0) throw startFailed();
  if (typeof euid !== "number" || !Number.isInteger(euid) || euid < 0) throw startFailed();
  if (uid !== euid) throw startFailed();
}

export interface ProbePeerCredentialsOptions {
  peerUidFor?: PeerUidReader;
  expectedUid?: number;
  timeoutMs?: number;
}

export interface UnixTransportOptions {
  socketPath: string;
  onAuthenticatedSocket: (socket: Socket) => void;
  peerUidFor?: PeerUidReader;
  expectedUid?: number;
  maxConnections?: number;
  /** Test-only seam; production always uses `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface UnixTransport {
  start(): Promise<SocketIdentity>;
  stopAccepting(): void;
  close(): Promise<void>;
}

const normalizeProbeError = (error: unknown): PiscesError => {
  if (error instanceof PiscesError) {
    if (
      error.code === "daemon.native_unavailable" ||
      error.code === "daemon.peer_credentials_unavailable"
    ) {
      return nativeUnavailable();
    }
    if (error.code === "daemon.peercred_probe_failed") return error;
  }
  return probeFailed();
};

/**
 * Load the real adapter lazily so that unsupported platforms can be rejected
 * by the host before the native addon is imported.
 */
const loadPeerUidReader = async (): Promise<PeerUidReader> => {
  try {
    const module = await import("./peer-credentials.js");
    return module.peerUidFor;
  } catch (error) {
    throw normalizeProbeError(error);
  }
};

const loadBindUnixListener = async (): Promise<(path: string) => number> => {
  try {
    const module = await import("./peer-credentials.js");
    return module.bindUnixListener;
  } catch (error) {
    throw normalizeProbeError(error);
  }
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const serverHandle = (server: Server): unknown =>
  (server as unknown as { _handle?: unknown })._handle;

/**
 * Adopt an already-listening native Unix socket descriptor. Node then has no
 * pathname association for the handle, so `server.close()` cannot unlink a
 * replacement pathname; Task 3 remains the sole path cleanup owner.
 *
 * The caller owns descriptor cleanup on rejection: an existing handle means
 * closing the server releases the descriptor, otherwise it must be closed
 * directly and exactly once.
 */
const listenOnFd = (server: Server, fd: number): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      server.removeListener("error", fail);
      reject(startFailed());
    };
    server.once("error", fail);
    try {
      server.listen({ fd }, () => {
        if (settled) return;
        settled = true;
        server.removeListener("error", fail);
        resolve();
      });
    } catch {
      fail();
    }
  });

const sameIdentity = (a: SocketIdentity, b: SocketIdentity): boolean =>
  a.dev.toString() === b.dev.toString() && a.ino.toString() === b.ino.toString();

/**
 * Startup cleanup still routed through Task 3 removal. Only an identity captured
 * from the pathname this instance bound is eligible; failures are contained so
 * the original startup error remains the reported cause.
 */
const removeBoundPath = async (
  path: string,
  identity: SocketIdentity | undefined,
): Promise<void> => {
  if (identity === undefined) return;
  await removeOwnedSocket(path, identity).catch(() => {});
};

const readProbeUid = (
  server: Server,
  path: string,
  reader: PeerUidReader,
  expectedUid: number,
  timeoutMs: number,
  onAccepted: (socket: Socket) => void,
  onClient: (socket: Socket) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: PiscesError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => finish(probeFailed()), Math.max(1, timeoutMs));

    server.once("connection", (socket) => {
      onAccepted(socket);
      let uid: number;
      try {
        uid = reader(socket);
      } catch (error) {
        finish(normalizeProbeError(error));
        return;
      }
      if (typeof uid !== "number" || !Number.isInteger(uid) || uid !== expectedUid) {
        finish(probeFailed());
        return;
      }
      finish();
    });
    server.once("error", () => finish(probeFailed()));

    const client = connect(path);
    onClient(client);
    client.once("error", () => finish(probeFailed()));
  });

/**
 * Verify the native peer-credential path with a real, bounded, private
 * ephemeral socket below the already-secured run directory. This must run
 * before the public socket is bound.
 */
export async function probePeerCredentials(
  runDir: string,
  options: ProbePeerCredentialsOptions = {},
): Promise<void> {
  assertLinuxPlatform();

  let reader: PeerUidReader;
  try {
    reader = options.peerUidFor ?? (await loadPeerUidReader());
  } catch (error) {
    throw normalizeProbeError(error);
  }

  const euid = process.geteuid?.();
  try {
    assertUnambiguousProcessIdentity(process.getuid?.(), euid);
  } catch {
    throw probeFailed();
  }
  if (typeof euid !== "number") throw probeFailed();

  const expectedUid = options.expectedUid ?? euid;
  if (typeof expectedUid !== "number" || !Number.isInteger(expectedUid) || expectedUid < 0) {
    throw probeFailed();
  }
  if (!isAbsolute(runDir)) throw probeFailed();

  const probePath = join(runDir, `${PROBE_PREFIX}${process.pid}-${randomUUID()}.sock`);
  if (Buffer.byteLength(probePath, "utf8") > MAX_SOCKET_PATH_BYTES) throw probeFailed();

  let fd: number | undefined;
  try {
    const bindUnixListener = await loadBindUnixListener();
    fd = bindUnixListener(probePath);
  } catch (error) {
    throw normalizeProbeError(error);
  }

  const server = createServer({ pauseOnConnect: true });
  let identity: SocketIdentity | undefined;
  let accepted: Socket | undefined;
  let client: Socket | undefined;
  let failure: PiscesError | undefined;
  let cleanupFailed = false;
  // Errors outside the adoption promise must not crash the process.
  server.on("error", () => {});

  try {
    const initial = await lstat(probePath);
    identity = { dev: initial.dev, ino: initial.ino };
    if (!initial.isSocket() || initial.isSymbolicLink() || initial.uid !== euid) {
      throw probeFailed();
    }

    await listenOnFd(server, fd);
    fd = undefined;

    await chmod(probePath, 0o600);
    const stat = await lstat(probePath);
    if (!sameIdentity(stat, identity) || (stat.mode & 0o777) !== 0o600) {
      throw probeFailed();
    }

    await readProbeUid(
      server,
      probePath,
      reader,
      expectedUid,
      options.timeoutMs ?? PROBE_TIMEOUT_MS,
      (socket) => {
        accepted = socket;
      },
      (socket) => {
        client = socket;
      },
    );
  } catch (error) {
    failure = normalizeProbeError(error);
  }

  const handleExisted = serverHandle(server) != null;
  accepted?.destroy();
  client?.destroy();
  try {
    await closeServer(server);
  } catch {
    cleanupFailed = true;
  }
  if (!handleExisted && fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await removeBoundPath(probePath, identity);
  } catch {
    cleanupFailed = true;
  }

  if (failure !== undefined) throw failure;
  if (cleanupFailed) throw probeFailed();
}

export function createUnixTransport(options: UnixTransportOptions): UnixTransport {
  assertLinuxPlatform(options.platform);

  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  if (!Number.isInteger(maxConnections) || maxConnections < 1) throw startFailed();

  let server: Server | undefined;
  let identity: SocketIdentity | undefined;
  let reader: PeerUidReader | undefined;
  let expectedUid: number | undefined;
  let accepting = false;
  let starting = false;
  let stopRequested = false;
  let closePromise: Promise<void> | undefined;
  const connections = new Set<Socket>();

  const onConnection = (socket: Socket): void => {
    if (!accepting || connections.size >= maxConnections) {
      socket.destroy();
      return;
    }

    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    // A credential failure must never surface as an unhandled socket error.
    socket.on("error", () => socket.destroy());

    let uid: number;
    try {
      uid = (reader as PeerUidReader)(socket);
    } catch {
      socket.destroy();
      return;
    }
    if (typeof uid !== "number" || !Number.isInteger(uid) || uid !== expectedUid) {
      socket.destroy();
      return;
    }

    try {
      options.onAuthenticatedSocket(socket);
      // `pauseOnConnect` sockets stay paused even after a data listener is
      // attached; only resume after authentication and handler setup.
      if (!socket.destroyed) socket.resume();
    } catch {
      socket.destroy();
    }
  };

  const stopAccepting = (): void => {
    accepting = false;
    stopRequested = true;
    if (server === undefined || closePromise !== undefined) return;
    closePromise = closeServer(server);
  };

  const start = async (): Promise<SocketIdentity> => {
    if (server !== undefined || starting) throw startFailed();
    starting = true;
    let fd: number | undefined;
    let boundPathCreated = false;

    try {
      stopRequested = false;
      assertLinuxPlatform(options.platform);
      assertUnambiguousProcessIdentity(process.getuid?.(), process.geteuid?.());
      if (!isAbsolute(options.socketPath)) throw startFailed();

      const euid = process.geteuid?.();
      if (typeof euid !== "number") throw startFailed();
      expectedUid = options.expectedUid ?? euid;
      if (!Number.isInteger(expectedUid) || expectedUid < 0) throw startFailed();

      reader = options.peerUidFor ?? (await loadPeerUidReader());
      const bindUnixListener = await loadBindUnixListener();

      await probePeerCredentials(dirname(options.socketPath), { expectedUid });

      fd = bindUnixListener(options.socketPath);
      boundPathCreated = true;

      const initial = await lstat(options.socketPath);
      identity = { dev: initial.dev, ino: initial.ino };
      if (!initial.isSocket() || initial.isSymbolicLink() || initial.uid !== expectedUid) {
        throw startFailed();
      }

      const bound = createServer({ pauseOnConnect: true });
      bound.on("connection", onConnection);
      // Errors outside the adoption promise must not crash the process.
      bound.on("error", () => {});
      server = bound;
      await listenOnFd(bound, fd);
      fd = undefined;

      await chmod(options.socketPath, 0o600);
      const stat = await lstat(options.socketPath);
      const boundIdentity: SocketIdentity = { dev: stat.dev, ino: stat.ino };
      if (
        !stat.isSocket() ||
        stat.isSymbolicLink() ||
        stat.uid !== expectedUid ||
        (stat.mode & 0o777) !== 0o600 ||
        !sameIdentity(stat, identity)
      ) {
        throw startFailed();
      }
      identity = boundIdentity;

      accepting = !stopRequested;
      return boundIdentity;
    } catch (error) {
      accepting = false;
      const bound = server;
      const handleExisted = bound !== undefined && serverHandle(bound) != null;
      server = undefined;
      if (bound !== undefined) {
        closePromise ??= closeServer(bound);
        await closePromise.catch(() => {});
        closePromise = undefined;
      }
      if (!handleExisted && fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The descriptor is already gone.
        }
      }
      if (boundPathCreated) await removeBoundPath(options.socketPath, identity);
      identity = undefined;
      if (error instanceof PiscesError) throw error;
      throw startFailed();
    } finally {
      starting = false;
    }
  };

  const close = async (): Promise<void> => {
    const bound = server;
    if (bound === undefined) return;
    accepting = false;
    stopAccepting();
    for (const socket of connections) socket.destroy();
    connections.clear();
    await closePromise;
    if (identity !== undefined) {
      await removeOwnedSocket(options.socketPath, identity);
      identity = undefined;
    }
    server = undefined;
    closePromise = undefined;
  };

  return { start, stopAccepting, close };
}

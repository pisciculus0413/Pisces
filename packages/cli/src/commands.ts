import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PiscesError } from "@pisces/core";
import { type CliConfig, loadConfig } from "./config.js";
import {
  clearPidRecord,
  createPidRecord,
  ensureDataDir,
  isProcessAlive,
  pidRecordExists,
  probeDaemon,
  readPidRecord,
  removePidRecord,
  socketPathFor,
  waitForExit,
} from "./lifecycle.js";

/**
 * User-facing lifecycle commands: `start`, `status` and `stop`.
 *
 * The commands never touch a process directly. Every side effect goes through
 * `CommandDeps`, so tests drive the exact ordering without spawning anything.
 * Only fixed codes and messages are printed; keys, config values and raw
 * errors never reach the terminal.
 */

export const LOG_FILE = "daemon.log";
export const READINESS_POLL_MS = 50;
export const START_TIMEOUT_MS = 10_000;
export const STOP_TIMEOUT_MS = 10_000;
/** Upper bound for one readiness probe; the remaining start budget caps it further. */
export const PROBE_TIMEOUT_MS = 500;
/** How long cleanup waits for a signalled child before abandoning it. */
export const CLEANUP_WAIT_MS = 1_000;

const CHILD_ENTRY = fileURLToPath(new URL("./daemon-child.js", import.meta.url));

const MESSAGES: Readonly<Record<string, string>> = {
  "config.invalid": "Invalid configuration",
  "config.missing_api_key": "Missing API key environment variable",
  "daemon.already_running": "A daemon is already running",
  "daemon.unknown_owner": "A process owns the runtime but did not answer; check manually",
  "daemon.start_failed": "Daemon could not start; see the log",
  "daemon.stop_timeout": "Daemon did not stop in time",
  "daemon.insecure_directory": "Data directory is not private",
  "daemon.unmanaged": "unmanaged daemon",
  "storage.io": "Daemon pid file could not be written",
};

const FALLBACK_CODE = "daemon.start_failed";

export interface ChildHandle {
  pid: number;
  exitCode: number | null;
  kill(signal: NodeJS.Signals): void;
  unref(): void;
}

/** The slice of `ChildProcess` the wrapper needs, so tests can drive a fake handle. */
export interface SpawnedChild {
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): unknown;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

/**
 * Wraps a spawned child so a libuv `'error'` (EAGAIN/EMFILE/ENOMEM and friends)
 * can never crash the CLI with an unhandled event: the first `'error'` or
 * `'exit'` marks the handle as exited, so `waitForReady` fails fast with
 * `daemon.start_failed` instead of burning the start budget. The raw error is
 * never printed.
 */
export function wrapChild(spawned: SpawnedChild, pid: number): ChildHandle {
  let exited = false;
  const markExited = (): void => {
    exited = true;
  };
  spawned.once("error", markExited);
  spawned.once("exit", markExited);

  return {
    pid,
    get exitCode() {
      return exited ? (spawned.exitCode ?? -1) : spawned.exitCode;
    },
    kill(signal) {
      spawned.kill(signal);
    },
    unref() {
      spawned.unref();
    },
  };
}

export interface CommandDeps {
  spawnChild(entry: string, args: string[], logPath: string): ChildHandle;
  probe(socketPath: string, timeoutMs?: number): Promise<boolean>;
  isAlive(pid: number): boolean;
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  clock(): number;
  now(): string;
  signal(pid: number, signal: NodeJS.Signals): void;
}

export interface CommandIo {
  out(line: string): void;
  err(line: string): void;
  /** Raw stdout write without an implied newline, for streamed turn deltas. */
  write?(text: string): void;
}

export interface CommandOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
}

export interface StatusOptions extends CommandOptions {
  json?: boolean;
}

export type StatusState = "running" | "stopped" | "stale" | "unresponsive" | "unmanaged";

export const processIo: CommandIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  write: (text) => {
    process.stdout.write(text);
  },
};

const failureMessage = (code: string): string => MESSAGES[code] ?? MESSAGES[FALLBACK_CODE] ?? "";

function fail(io: CommandIo, code: string): void {
  io.err(`error: ${code}: ${failureMessage(code)}`);
}

/** Every provider must have a non-empty key in the environment; the name is never printed. */
function hasEveryKey(config: CliConfig, env: NodeJS.ProcessEnv): boolean {
  return config.providers.every((provider) => {
    const key = env[provider.apiKeyEnv];
    return typeof key === "string" && key !== "";
  });
}

/**
 * Removes the record only when it still names `pid`, so a launcher can never
 * delete a winner's record that appeared while it was cleaning up.
 */
async function discardRecord(dataDir: string, pid: number): Promise<void> {
  try {
    await removePidRecord(dataDir, pid);
  } catch {
    // A record that cannot be removed is reported by the next status/stop.
  }
}

function stopChild(child: ChildHandle): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may already be gone.
  }
}

/**
 * Abandons a child that cannot become the daemon: SIGTERM, wait a bounded time
 * for it to exit, then always unref so the parent never hangs on the handle.
 */
async function abortChild(child: ChildHandle, deps: CommandDeps): Promise<void> {
  stopChild(child);
  try {
    await deps.waitForExit(child.pid, CLEANUP_WAIT_MS);
  } catch {
    // An unwaitable child is still released below.
  }
  try {
    child.unref();
  } catch {
    // Already released.
  }
}

interface Resolved {
  dataDir: string;
  config: CliConfig;
}

/** Loads the config and applies the CLI override; `undefined` means the fixed error was printed. */
async function resolve(options: CommandOptions, io: CommandIo): Promise<Resolved | undefined> {
  let config: CliConfig;
  try {
    config = await loadConfig(options.configPath);
  } catch {
    fail(io, "config.invalid");
    return undefined;
  }
  return { config, dataDir: options.dataDir ?? config.dataDir };
}

/**
 * Polls until the child answers, exits, or loses the pid record.
 *
 * A ready daemon is only reported when the child is still alive, the record
 * still names the child, and this dataDir's socket completes a handshake. The
 * budget is wall-clock bounded, and each probe is capped by what is left, so a
 * slow probe can never stretch the total start time.
 */
async function waitForReady(
  child: ChildHandle,
  socketPath: string,
  dataDir: string,
  deadline: number,
  deps: CommandDeps,
): Promise<boolean> {
  for (;;) {
    if (child.exitCode !== null || !deps.isAlive(child.pid)) return false;
    const record = await readPidRecord(dataDir);
    if (record === undefined || record.pid !== child.pid) return false;

    const remaining = deadline - deps.clock();
    if (remaining <= 0) return false;
    if (await deps.probe(socketPath, Math.min(PROBE_TIMEOUT_MS, remaining))) return true;

    const left = deadline - deps.clock();
    if (left <= 0) return false;
    await deps.sleep(Math.min(READINESS_POLL_MS, left));
  }
}

export async function startCommand(
  options: CommandOptions,
  deps: CommandDeps = productionDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  const resolved = await resolve(options, io);
  if (resolved === undefined) return 2;

  if (!hasEveryKey(resolved.config, process.env)) {
    fail(io, "config.missing_api_key");
    return 2;
  }

  const { dataDir } = resolved;
  try {
    await ensureDataDir(dataDir);
  } catch {
    fail(io, "daemon.insecure_directory");
    return 2;
  }

  const socketPath = socketPathFor(dataDir);
  const logPath = join(dataDir, LOG_FILE);
  // The whole start, including the preflight probe, shares one 10 s budget.
  const deadline = deps.clock() + START_TIMEOUT_MS;

  if (await deps.probe(socketPath)) {
    fail(io, "daemon.already_running");
    return 1;
  }

  const existing = await readPidRecord(dataDir);
  if (existing !== undefined) {
    if (deps.isAlive(existing.pid)) {
      fail(io, "daemon.unknown_owner");
      return 1;
    }
    await discardRecord(dataDir, existing.pid);
  } else if (await pidRecordExists(dataDir)) {
    // The socket did not answer and the record names no owner, so no process can
    // be reclaimed through it. Dropping it is the only way out of the wedge: the
    // exclusive create below would otherwise fail on EEXIST forever.
    try {
      await clearPidRecord(dataDir);
    } catch {
      fail(io, "storage.io");
      return 1;
    }
  }

  // The template directory travels as an explicit argv element, like the data
  // directory override, so the child never has to guess how it was resolved.
  const childArgs = [options.configPath, dataDir];
  if (resolved.config.templatesDir !== undefined) childArgs.push(resolved.config.templatesDir);

  let child: ChildHandle;
  try {
    child = deps.spawnChild(CHILD_ENTRY, childArgs, logPath);
  } catch (error) {
    // Only an unopenable log is a directory problem; everything else is a
    // failed spawn (EACCES, ENOMEM, EAGAIN) and points at the log.
    if (error instanceof PiscesError && error.code === "daemon.insecure_directory") {
      fail(io, "daemon.insecure_directory");
      return 2;
    }
    fail(io, "daemon.start_failed");
    io.err(`log: ${logPath}`);
    return 1;
  }

  let created: boolean;
  try {
    created = await createPidRecord(dataDir, {
      pid: child.pid,
      socketPath,
      startedAt: deps.now(),
    });
  } catch {
    await abortChild(child, deps);
    fail(io, "storage.io");
    return 1;
  }

  if (!created) {
    await abortChild(child, deps);
    fail(io, "daemon.already_running");
    return 1;
  }

  if (!(await waitForReady(child, socketPath, dataDir, deadline, deps))) {
    await abortChild(child, deps);
    await discardRecord(dataDir, child.pid);
    fail(io, "daemon.start_failed");
    io.err(`log: ${logPath}`);
    return 1;
  }

  child.unref();
  io.out(`running (pid ${child.pid}, socket ${socketPath})`);
  return 0;
}

export async function statusCommand(
  options: StatusOptions,
  deps: CommandDeps = productionDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  const resolved = await resolve(options, io);
  if (resolved === undefined) return 2;

  const { dataDir } = resolved;
  // Identity is always this dataDir's socket; a record naming any other path
  // proves nothing about who owns the runtime.
  const socketPath = socketPathFor(dataDir);
  const record = await readPidRecord(dataDir);

  let state: StatusState;
  let code: number;
  let pid: number | undefined;
  let line: string;

  if (record !== undefined && record.socketPath !== socketPath) {
    fail(io, "daemon.unknown_owner");
    return 1;
  }

  if (record === undefined) {
    state = (await deps.probe(socketPath)) ? "unmanaged" : "stopped";
    code = 1;
    line = state === "unmanaged" ? `unmanaged (socket ${socketPath})` : "stopped";
  } else if (!deps.isAlive(record.pid)) {
    await discardRecord(dataDir, record.pid);
    state = "stale";
    code = 1;
    line = "stopped (stale pid file)";
  } else if (await deps.probe(socketPath)) {
    state = "running";
    code = 0;
    pid = record.pid;
    line = `running (pid ${record.pid}, socket ${socketPath})`;
  } else {
    state = "unresponsive";
    code = 1;
    pid = record.pid;
    line = `unresponsive (pid ${record.pid})`;
  }

  if (options.json === true) {
    io.out(JSON.stringify({ state, ...(pid !== undefined ? { pid } : {}), socketPath, dataDir }));
    return code;
  }

  io.out(line);
  return code;
}

export async function stopCommand(
  options: CommandOptions,
  deps: CommandDeps = productionDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  const resolved = await resolve(options, io);
  if (resolved === undefined) return 2;

  const { dataDir } = resolved;
  const socketPath = socketPathFor(dataDir);
  const record = await readPidRecord(dataDir);

  if (record === undefined) {
    if (await deps.probe(socketPath)) {
      fail(io, "daemon.unmanaged");
      return 1;
    }
    io.out("not running");
    return 0;
  }

  // A record pointing at another socket names an owner this CLI cannot prove;
  // never signal it and never remove the file.
  if (record.socketPath !== socketPath) {
    fail(io, "daemon.unknown_owner");
    return 1;
  }

  if (!deps.isAlive(record.pid)) {
    await discardRecord(dataDir, record.pid);
    io.out("not running");
    return 0;
  }

  // Never signal a pid until this dataDir's socket proves it is our daemon.
  if (!(await deps.probe(socketPath))) {
    fail(io, "daemon.unknown_owner");
    return 1;
  }

  try {
    deps.signal(record.pid, "SIGTERM");
  } catch {
    // A vanishing process is reported by the wait below.
  }

  if (!(await deps.waitForExit(record.pid, STOP_TIMEOUT_MS))) {
    fail(io, "daemon.stop_timeout");
    return 1;
  }

  await discardRecord(dataDir, record.pid);
  io.out(`stopped (pid ${record.pid}, socket ${socketPath})`);
  return 0;
}

/** Production seams; the only place that opens a log and spawns a real child. */
export const productionDeps: CommandDeps = {
  spawnChild(entry, args, logPath) {
    let fd: number;
    try {
      fd = openSync(logPath, "a", 0o600);
    } catch (error) {
      throw new PiscesError("daemon.insecure_directory", "Data directory is not private", {
        cause: error,
      });
    }

    try {
      const spawned = spawn(process.execPath, [entry, ...args], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      if (spawned.pid === undefined) {
        throw new PiscesError("daemon.start_failed", "Daemon could not start; see the log");
      }
      const pid = spawned.pid;
      // The wrapper owns the `'error'` listener, so a failed spawn is a fast
      // `daemon.start_failed` rather than an unhandled-event crash.
      return wrapChild(spawned, pid);
    } finally {
      closeSync(fd);
    }
  },
  probe: (socketPath, timeoutMs) => probeDaemon(socketPath, timeoutMs),
  isAlive: isProcessAlive,
  waitForExit: (pid, timeoutMs) => waitForExit(pid, timeoutMs),
  sleep: (ms) => delay(ms),
  clock: () => Date.now(),
  now: () => new Date().toISOString(),
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
};

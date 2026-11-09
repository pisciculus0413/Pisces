import type { Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PiscesError } from "@pisces/core";
import { PROTOCOL_VERSION } from "@pisces/protocol";

/**
 * Filesystem, pid and socket primitives shared by the CLI lifecycle commands.
 *
 * The data directory policy mirrors the daemon's: an absolute, owned directory
 * that is not a symlink and grants no group or world write permission. The pid
 * file is created exclusively so two launchers can never believe they own the
 * same daemon.
 */

const RUN_DIRECTORY = "run";
const SOCKET_FILE = "pisces.sock";
const PID_FILE = "daemon.pid";
const WAIT_POLL_MS = 50;
const PROBE_ID = "cli-probe";

export interface PidRecord {
  pid: number;
  socketPath: string;
  startedAt: string;
}

const insecureDirectory = (): PiscesError =>
  new PiscesError("daemon.insecure_directory", "Data directory is not private");

const storageFailure = (cause: unknown): PiscesError =>
  new PiscesError("storage.io", "Daemon pid file could not be written", { cause });

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const pidPathFor = (dataDir: string): string => join(dataDir, PID_FILE);

export function socketPathFor(dataDir: string): string {
  return join(dataDir, RUN_DIRECTORY, SOCKET_FILE);
}

/**
 * Create the data directory when missing, then verify it is private.
 *
 * Existing directories are never chmodded or followed through a symlink; the
 * only accepted state is a real directory owned by the effective uid without
 * group or world write bits.
 */
export async function ensureDataDir(dataDir: string): Promise<void> {
  if (!isAbsolute(dataDir)) throw insecureDirectory();
  const root = resolve(dataDir);

  let stat: Stats | undefined;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw insecureDirectory();
  }

  if (stat === undefined) {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
    } catch {
      throw insecureDirectory();
    }
    try {
      stat = await lstat(root);
    } catch {
      throw insecureDirectory();
    }
  }

  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw insecureDirectory();
  }
}

function parsePidRecord(text: string): PidRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { pid, socketPath, startedAt } = value as Record<string, unknown>;
  if (!isPositiveInteger(pid)) return undefined;
  if (typeof socketPath !== "string" || socketPath.length === 0) return undefined;
  if (typeof startedAt !== "string") return undefined;
  return { pid, socketPath, startedAt };
}

/** Missing, unreadable, malformed or wrongly typed records count as absent. */
export async function readPidRecord(dataDir: string): Promise<PidRecord | undefined> {
  let text: string;
  try {
    text = await readFile(pidPathFor(dataDir), "utf8");
  } catch {
    return undefined;
  }
  return parsePidRecord(text);
}

/** Returns `false` when another owner already holds the record. */
export async function createPidRecord(dataDir: string, record: PidRecord): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(pidPathFor(dataDir), "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw storageFailure(error);
  }

  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    // Never leave a half-written record that would block the next launcher.
    await handle.close().catch(() => {});
    await unlink(pidPathFor(dataDir)).catch(() => {});
    throw storageFailure(error);
  }
  try {
    await handle.close();
  } catch (error) {
    throw storageFailure(error);
  }
  return true;
}

/** Removes the record only when it still belongs to `pid`. */
export async function removePidRecord(dataDir: string, pid: number): Promise<void> {
  const record = await readPidRecord(dataDir);
  if (record !== undefined && record.pid !== pid) return;
  try {
    await unlink(pidPathFor(dataDir));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw storageFailure(error);
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!isPositiveInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process owned by another user is alive but not signalable.
    return errorCode(error) === "EPERM";
  }
}

const isCompatibleResponse = (line: string): boolean => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null) return false;
  const result = (value as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return false;
  return (result as { compatible?: unknown }).compatible === true;
};

/**
 * Connect, send one protocol hello and resolve `true` only for a compatible
 * reply. Every failure mode (timeout, refusal, early close, malformed frame)
 * resolves `false`; the socket and timer are always released.
 */
export async function probeDaemon(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolveProbe) => {
    let socket: Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (socket !== undefined) {
        socket.removeAllListeners();
        socket.on("error", () => {});
        socket.destroy();
      }
      resolveProbe(value);
    };

    timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));

    try {
      socket = connect(socketPath);
    } catch {
      finish(false);
      return;
    }

    let buffer = "";
    socket.once("connect", () => {
      socket?.write(
        `${JSON.stringify({
          id: PROBE_ID,
          method: "protocol.hello",
          params: { versions: [PROTOCOL_VERSION] },
        })}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      finish(isCompatibleResponse(buffer.slice(0, newline)));
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

/** Polls `50 ms` until the pid disappears or the deadline passes. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (isProcessAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(WAIT_POLL_MS, remaining));
  }
  return true;
}

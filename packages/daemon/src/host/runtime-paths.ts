import type { Stats } from "node:fs";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { PiscesError } from "@pisces/core";

/**
 * Private runtime directory policy for the local daemon.
 *
 * The data directory must be an absolute, owned, non-group/world-writable
 * directory. Its `run` child is created (or verified) with the exact mode
 * `0700`; existing paths are never chmodded or followed through symlinks.
 */

const MAX_SOCKET_PATH_BYTES = 107;
const RUN_DIRECTORY = "run";
const SOCKET_FILE = "pisces.sock";
const LOCK_FILE = "pisces.lock";

/**
 * Narrow filesystem seam used by tests to simulate a foreign owner or an inode
 * replacement between the stale probe and unlink. It never bypasses the
 * ownership and identity checks themselves.
 */
export const runtimePathsFs: { lstat(path: string): Promise<Stats> } = {
  lstat: (path) => lstat(path),
};

const insecureDirectory = (): PiscesError =>
  new PiscesError("daemon.insecure_directory", "runtime directory is not private");

const unsafeSocket = (): PiscesError =>
  new PiscesError("daemon.socket_live", "socket path is not safely removable");

const socketPathTooLong = (): PiscesError =>
  new PiscesError("daemon.socket_path_too_long", "socket path exceeds the platform limit");

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

const effectiveUid = (): number | undefined => process.geteuid?.();

const directoryStat = async (path: string): Promise<Stats | undefined> => {
  try {
    return await runtimePathsFs.lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw insecureDirectory();
  }
};

const ensureDataDirectory = async (path: string, uid: number): Promise<void> => {
  let stat = await directoryStat(path);
  if (stat === undefined) {
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
    } catch {
      throw insecureDirectory();
    }
    stat = await directoryStat(path);
  }
  if (
    stat === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw insecureDirectory();
  }
};

const ensureRunDirectory = async (path: string, uid: number): Promise<void> => {
  let stat = await directoryStat(path);
  if (stat === undefined) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch {
      throw insecureDirectory();
    }
    stat = await directoryStat(path);
  }
  if (
    stat === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== 0o700
  ) {
    throw insecureDirectory();
  }
};

export interface RuntimePaths {
  socketPath: string;
  lockPath: string;
  runDir: string;
}

export async function prepareRuntimePaths(dataDir: string): Promise<RuntimePaths> {
  if (!isAbsolute(dataDir)) throw insecureDirectory();

  const root = resolve(dataDir);
  const runDir = join(root, RUN_DIRECTORY);
  const socketPath = join(runDir, SOCKET_FILE);
  if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw socketPathTooLong();
  }

  const uid = effectiveUid();
  if (uid === undefined) throw insecureDirectory();
  await ensureDataDirectory(root, uid);
  await ensureRunDirectory(runDir, uid);

  return { socketPath, lockPath: join(runDir, LOCK_FILE), runDir };
}

const socketStat = async (path: string): Promise<Stats | undefined> => {
  try {
    return await runtimePathsFs.lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw unsafeSocket();
  }
};

const isOwnedSocket = (stat: Stats, uid: number): boolean =>
  stat.isSocket() && !stat.isSymbolicLink() && stat.uid === uid;

const sameIdentity = (stat: Stats, identity: { dev: number | bigint; ino: number | bigint }) =>
  stat.dev.toString() === identity.dev.toString() &&
  stat.ino.toString() === identity.ino.toString();

const probeStaleSocket = (path: string, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = connect(path);
    } catch {
      reject(unsafeSocket());
      return;
    }

    let settled = false;
    const finish = (error?: PiscesError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => finish(unsafeSocket()), Math.max(1, timeoutMs));

    socket.once("connect", () => finish(unsafeSocket()));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish();
      else finish(unsafeSocket());
    });
  });

export async function clearStaleSocket(socketPath: string, timeoutMs = 1000): Promise<void> {
  if (!isAbsolute(socketPath)) throw unsafeSocket();
  const uid = effectiveUid();
  if (uid === undefined) throw unsafeSocket();

  const initial = await socketStat(socketPath);
  if (initial === undefined) return;
  if (!isOwnedSocket(initial, uid)) throw unsafeSocket();

  await probeStaleSocket(socketPath, timeoutMs);

  const current = await socketStat(socketPath);
  if (current === undefined) return;
  if (!isOwnedSocket(current, uid) || !sameIdentity(current, initial)) {
    throw unsafeSocket();
  }

  try {
    await unlink(socketPath);
  } catch (error) {
    if (!isNotFound(error)) throw unsafeSocket();
  }
}

export interface SocketIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

export async function removeOwnedSocket(
  socketPath: string,
  identity: SocketIdentity,
): Promise<void> {
  if (!isAbsolute(socketPath)) return;
  const uid = effectiveUid();
  if (uid === undefined) return;

  const stat = await socketStat(socketPath);
  if (stat === undefined || !isOwnedSocket(stat, uid) || !sameIdentity(stat, identity)) {
    return;
  }

  try {
    await unlink(socketPath);
  } catch (error) {
    if (!isNotFound(error)) return;
  }
}

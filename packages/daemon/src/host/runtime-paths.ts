import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { PiscesError } from "@pisces/core";

/**
 * Private runtime directory policy for the local daemon.
 *
 * The data directory must be an absolute, owned, non-group/world-writable
 * directory. Its `run` child is created (or verified) with the exact mode
 * `0700`; existing paths are never chmodded or followed through symlinks.
 *
 * Socket cleanup never unlinks a pathname that has not been verified after it
 * was atomically moved into a unique quarantine name inside the same private
 * directory. POSIX offers no conditional unlink-by-inode, so this removes the
 * check/unlink race for all users outside the trusted same-UID boundary.
 */

const MAX_SOCKET_PATH_BYTES = 107;
const RUN_DIRECTORY = "run";
const SOCKET_FILE = "pisces.sock";
const LOCK_FILE = "pisces.lock";

/**
 * Narrow filesystem seam used by tests to trigger real path replacements at
 * the check/rename boundary or to inject unlink failures. It only replaces the
 * filesystem primitives; ownership and identity checks always run on real
 * stat results.
 */
export const runtimePathsFs: {
  lstat(path: string): Promise<Stats>;
  unlink(path: string): Promise<void>;
} = {
  lstat: (path) => lstat(path),
  unlink: (path) => unlink(path),
};

const insecureDirectory = (): PiscesError =>
  new PiscesError("daemon.insecure_directory", "runtime directory is not private");

const unsafeSocket = (): PiscesError =>
  new PiscesError("daemon.socket_live", "socket path is not safely removable");

const socketPathTooLong = (): PiscesError =>
  new PiscesError("daemon.socket_path_too_long", "socket path exceeds the platform limit");

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";

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
    } catch (error) {
      // EEXIST only means a concurrent preparer reached the path after our
      // absence observation; safety is decided by the fresh stat below. Any
      // other mkdir failure remains closed.
      if (!isAlreadyExists(error)) throw insecureDirectory();
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

type ProbeOutcome = "stale" | "missing";
type ProbeDecision = ProbeOutcome | "refuse";

const probeStaleSocket = (path: string, timeoutMs: number): Promise<ProbeOutcome> =>
  new Promise((resolve, reject) => {
    let socket: Socket;
    try {
      socket = connect(path);
    } catch {
      reject(unsafeSocket());
      return;
    }

    let settled = false;
    const finish = (decision: ProbeDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      if (decision === "refuse") reject(unsafeSocket());
      else resolve(decision);
    };
    const timer = setTimeout(() => finish("refuse"), Math.max(1, timeoutMs));

    socket.once("connect", () => finish("refuse"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish("stale");
      else if (error.code === "ENOENT") finish("missing");
      else finish("refuse");
    });
  });

const quarantinePathFor = (socketPath: string): string =>
  `${socketPath}.stale-${process.pid}-${randomUUID()}`;

const moveToQuarantine = async (socketPath: string): Promise<string | undefined> => {
  const quarantinePath = quarantinePathFor(socketPath);
  try {
    await rename(socketPath, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw unsafeSocket();
  }
};

/**
 * Put a quarantined inode back at its original path without overwriting a path
 * that appeared in the meantime. `link` fails with `EEXIST` instead of
 * replacing; if that happens the quarantine entry is deliberately kept and the
 * caller surfaces the failure.
 */
const restoreQuarantined = async (quarantinePath: string, socketPath: string): Promise<void> => {
  try {
    await link(quarantinePath, socketPath);
  } catch {
    return;
  }
  try {
    await runtimePathsFs.unlink(quarantinePath);
  } catch {
    // The inode is linked back at the original path; an extra private link is harmless.
  }
};

const discardQuarantined = async (quarantinePath: string): Promise<void> => {
  try {
    await runtimePathsFs.unlink(quarantinePath);
  } catch (error) {
    if (!isNotFound(error)) throw unsafeSocket();
  }
};

const matchesQuarantined = async (
  quarantinePath: string,
  uid: number,
  identity: { dev: number | bigint; ino: number | bigint },
): Promise<boolean> => {
  let moved: Stats | undefined;
  try {
    moved = await socketStat(quarantinePath);
  } catch {
    return false;
  }
  return moved !== undefined && isOwnedSocket(moved, uid) && sameIdentity(moved, identity);
};

export async function clearStaleSocket(socketPath: string, timeoutMs = 1000): Promise<void> {
  if (!isAbsolute(socketPath)) throw unsafeSocket();
  const uid = effectiveUid();
  if (uid === undefined) throw unsafeSocket();

  const initial = await socketStat(socketPath);
  if (initial === undefined) return;
  if (!isOwnedSocket(initial, uid)) throw unsafeSocket();

  const outcome = await probeStaleSocket(socketPath, timeoutMs);
  if (outcome === "missing") {
    // An ENOENT probe is not evidence of staleness: the path may have been
    // moved away and restored. Removal is only authorized while it is absent.
    const reappeared = await socketStat(socketPath);
    if (reappeared === undefined) return;
    throw unsafeSocket();
  }

  const current = await socketStat(socketPath);
  if (current === undefined) return;
  if (!isOwnedSocket(current, uid) || !sameIdentity(current, initial)) {
    throw unsafeSocket();
  }

  const quarantinePath = await moveToQuarantine(socketPath);
  if (quarantinePath === undefined) return;
  if (!(await matchesQuarantined(quarantinePath, uid, initial))) {
    await restoreQuarantined(quarantinePath, socketPath);
    throw unsafeSocket();
  }
  await discardQuarantined(quarantinePath);
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

  const current = await socketStat(socketPath);
  if (current === undefined) return;
  if (!isOwnedSocket(current, uid) || !sameIdentity(current, identity)) return;

  const quarantinePath = await moveToQuarantine(socketPath);
  if (quarantinePath === undefined) return;
  if (!(await matchesQuarantined(quarantinePath, uid, identity))) {
    await restoreQuarantined(quarantinePath, socketPath);
    throw unsafeSocket();
  }
  await discardQuarantined(quarantinePath);
}

import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { PiscesError } from "@pisces/core";

/**
 * Daemon single-instance lock.
 *
 * The flock is owned by a live file descriptor. The caller must hold the
 * returned handle for the daemon lifetime; release closes the descriptor and
 * deliberately leaves the lock file in place so a concurrent owner can never
 * end up locking a different inode.
 */

export interface DaemonLock {
  release(): Promise<void>;
}

const lockFailed = (): PiscesError =>
  new PiscesError("daemon.lock_failed", "lock file could not be acquired");

export async function acquireDaemonLock(lockPath: string): Promise<DaemonLock> {
  let handle: FileHandle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw lockFailed();
  }

  try {
    const stat = await handle.stat();
    const uid = process.geteuid?.();
    if (typeof uid !== "number" || !stat.isFile() || stat.uid !== uid) {
      throw lockFailed();
    }
    // Defer the native import so module loading never touches the addon before the
    // host platform guard; a missing addon fails closed at lock acquisition.
    const { acquireLock } = await import("../transport/peer-credentials.js");
    acquireLock(handle.fd);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error instanceof PiscesError ? error : lockFailed();
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await handle.close();
    },
  };
}

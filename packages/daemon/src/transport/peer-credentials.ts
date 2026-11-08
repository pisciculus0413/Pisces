import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { PiscesError } from "@pisces/core";

/**
 * Linux peer authentication and advisory locking for the daemon transport.
 *
 * The compiled addon lives next to the native sources so that both the
 * TypeScript sources (src/transport) and the compiled output (dist/transport)
 * resolve the same `native/peercred.node` file.
 */

export interface NativeBinding {
  readPeerUid(fd: number): number;
  lockFile(fd: number): void;
}

const BINDING_PATH = fileURLToPath(new URL("../../native/peercred.node", import.meta.url));
const MAX_FD = 2 ** 31 - 1;
const LOCK_BUSY_ERRNO = constants.errno.EAGAIN;

const unavailable = (): PiscesError =>
  new PiscesError(
    "daemon.peer_credentials_unavailable",
    "native peer credential binding is unavailable",
  );

const invalidFd = (): PiscesError =>
  new PiscesError("daemon.peer_credentials_invalid", "file descriptor is invalid");

const credentialsFailed = (): PiscesError =>
  new PiscesError("daemon.peer_credentials_failed", "peer credentials could not be read");

export function loadNativeBinding(path: string): NativeBinding {
  let loaded: unknown;
  try {
    loaded = createRequire(import.meta.url)(path);
  } catch {
    throw unavailable();
  }
  if (typeof loaded !== "object" || loaded === null) {
    throw unavailable();
  }
  const candidate = loaded as Partial<NativeBinding>;
  if (typeof candidate.readPeerUid !== "function" || typeof candidate.lockFile !== "function") {
    throw unavailable();
  }
  return candidate as NativeBinding;
}

const binding: NativeBinding = loadNativeBinding(BINDING_PATH);

const assertFd = (fd: number): void => {
  if (!Number.isInteger(fd) || fd < 0 || fd > MAX_FD) {
    throw invalidFd();
  }
};

const nativeErrno = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const errno = (error as { errno?: unknown }).errno;
  return typeof errno === "number" ? errno : undefined;
};

export function readPeerUid(fd: number): number {
  assertFd(fd);
  try {
    return binding.readPeerUid(fd);
  } catch {
    throw credentialsFailed();
  }
}

export function lockFile(fd: number): void {
  assertFd(fd);
  try {
    binding.lockFile(fd);
  } catch (error) {
    if (nativeErrno(error) === LOCK_BUSY_ERRNO) {
      throw new PiscesError("daemon.lock_busy", "lock is held by another process");
    }
    throw new PiscesError("daemon.lock_failed", "lock could not be acquired");
  }
}

const socketFd = (socket: Socket): number => {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  const fd = handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0 || fd > MAX_FD) {
    throw invalidFd();
  }
  return fd;
};

export function peerUidFor(socket: Socket): number {
  return readPeerUid(socketFd(socket));
}

export function acquireLock(fd: number): void {
  lockFile(fd);
}

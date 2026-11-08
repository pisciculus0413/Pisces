import { closeSync, fstatSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  acquireLock,
  loadNativeBinding,
  type NativeBinding,
  peerUidFor,
  readPeerUid,
} from "../src/transport/peer-credentials.js";

const UNAVAILABLE = "daemon.peer_credentials_unavailable";
const INVALID_FD = "daemon.peer_credentials_invalid";
const CREDENTIALS_FAILED = "daemon.peer_credentials_failed";
const LOCK_BUSY = "daemon.lock_busy";

const errorCode = (code: string) => expect.objectContaining({ code });

const native: NativeBinding = loadNativeBinding(
  fileURLToPath(new URL("../native/peercred.node", import.meta.url)),
);

const MALFORMED_FDS = [
  -1,
  0.5,
  -0.25,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  2 ** 31,
];

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pisces-peercred-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const listen = (server: ReturnType<typeof createServer>, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

test("reads the uid of the same-process peer of an accepted unix socket", async () => {
  const path = join(dir, "daemon.sock");
  const server = createServer();
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  await listen(server, path);
  const client = connect(path);
  const socket = await accepted;
  const uid = process.getuid?.();
  try {
    expect(typeof uid).toBe("number");
    expect(peerUidFor(socket)).toBe(uid);
  } finally {
    socket.destroy();
    client.destroy();
    await closeServer(server);
  }
});

test("rejects a socket whose handle exposes no usable integer descriptor", () => {
  expect(() => peerUidFor({} as unknown as Socket)).toThrowError(errorCode(INVALID_FD));
  expect(() => peerUidFor({ _handle: { fd: "3" } } as unknown as Socket)).toThrowError(
    errorCode(INVALID_FD),
  );
});

test("rejects missing and malformed descriptors", () => {
  expect(() => readPeerUid(undefined as unknown as number)).toThrowError(errorCode(INVALID_FD));
  expect(() => readPeerUid(-1)).toThrowError(errorCode(INVALID_FD));
  expect(() => readPeerUid(2 ** 31)).toThrowError(errorCode(INVALID_FD));
  expect(() => readPeerUid(1.5)).toThrowError(errorCode(INVALID_FD));
  expect(() => readPeerUid(Number.NaN)).toThrowError(errorCode(INVALID_FD));
  expect(() => readPeerUid(Number.POSITIVE_INFINITY)).toThrowError(errorCode(INVALID_FD));
  expect(() => acquireLock(undefined as unknown as number)).toThrowError(errorCode(INVALID_FD));
  expect(() => acquireLock(1.5)).toThrowError(errorCode(INVALID_FD));
});

test("native binding rejects fractional descriptors instead of truncating them", async () => {
  const path = join(dir, "daemon.sock");
  const server = createServer();
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  await listen(server, path);
  const client = connect(path);
  const socket = await accepted;
  const fd = (socket as unknown as { _handle: { fd: number } })._handle.fd;
  try {
    expect(() => native.readPeerUid(fd + 0.5)).toThrowError(TypeError);
    expect(native.readPeerUid(fd)).toBe(process.getuid?.());
  } finally {
    socket.destroy();
    client.destroy();
    await closeServer(server);
  }
});

test("native binding rejects fractional descriptors without locking the truncated fd", () => {
  const path = join(dir, "native.lock");
  const first = openSync(path, "w");
  const second = openSync(path, "w");
  try {
    expect(() => native.lockFile(first + 0.5)).toThrowError(TypeError);
    expect(() => acquireLock(second)).not.toThrow();
  } finally {
    closeSync(first);
    closeSync(second);
  }
});

test("native binding rejects non-finite and out-of-range descriptors", () => {
  for (const fd of MALFORMED_FDS) {
    expect(() => native.readPeerUid(fd), `readPeerUid(${fd})`).toThrowError(TypeError);
    expect(() => native.lockFile(fd), `lockFile(${fd})`).toThrowError(TypeError);
  }
});

test("normalizes syscall failures for a closed descriptor", () => {
  const fd = openSync(join(dir, "closed"), "w");
  closeSync(fd);
  expect(() => readPeerUid(fd)).toThrowError(errorCode(CREDENTIALS_FAILED));
});

test("normalizes syscall failures for a descriptor that is not a socket", () => {
  const fd = openSync(join(dir, "plain"), "w");
  try {
    expect(() => readPeerUid(fd)).toThrowError(errorCode(CREDENTIALS_FAILED));
  } finally {
    closeSync(fd);
  }
});

test("second descriptor stays locked out until the first one closes", () => {
  const path = join(dir, "daemon.lock");
  const first = openSync(path, "w");
  const second = openSync(path, "w");
  try {
    acquireLock(first);
    expect(fstatSync(first).isFile()).toBe(true);
    expect(() => acquireLock(second)).toThrowError(errorCode(LOCK_BUSY));
    closeSync(first);
    expect(() => acquireLock(second)).not.toThrow();
  } finally {
    try {
      closeSync(first);
    } catch {}
    try {
      closeSync(second);
    } catch {}
  }
});

test("fails closed when the compiled addon is missing", () => {
  expect(() => loadNativeBinding(join(dir, "missing", "peercred.node"))).toThrowError(
    errorCode(UNAVAILABLE),
  );
});

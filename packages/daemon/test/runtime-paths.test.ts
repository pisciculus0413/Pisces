import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { acquireDaemonLock } from "../src/host/lock.js";
import {
  clearStaleSocket,
  prepareRuntimePaths,
  removeOwnedSocket,
  runtimePathsFs,
} from "../src/host/runtime-paths.js";

const INSECURE = "daemon.insecure_directory";
const LOCK_BUSY = "daemon.lock_busy";
const SOCKET_LIVE = "daemon.socket_live";
const PATH_TOO_LONG = "daemon.socket_path_too_long";

const SOCKET_TAIL = "/run/pisces.sock";
const MAX_SOCKET_BYTES = 107;

let base = "";
const servers: Server[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pisces-runtime-"));
});

afterEach(async () => {
  runtimePathsFs.lstat = (path) => lstat(path);
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(base, { recursive: true, force: true });
});

const listen = async (path: string): Promise<Server> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  servers.push(server);
  return server;
};

/**
 * Node unlinks a listening socket when `server.close()` finishes, so the only
 * way to obtain a genuinely crash-stale socket path is an abruptly exiting
 * child that bound it.
 */
const makeStaleSocket = (path: string): void => {
  const script = `const net = require("node:net"); const server = net.createServer(); server.listen(${JSON.stringify(path)}, () => process.exit(0));`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`stale socket fixture failed: ${result.stderr}`);
  }
};

const assertMissing = async (path: string): Promise<void> => {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
};

test("creates private data and run directories below a world-writable ancestor", async () => {
  const dataDir = join(base, "data");
  const paths = await prepareRuntimePaths(dataDir);

  expect(paths.runDir).toBe(join(dataDir, "run"));
  expect(paths.socketPath).toBe(join(paths.runDir, "pisces.sock"));
  expect(paths.lockPath).toBe(join(paths.runDir, "pisces.lock"));
  expect(Buffer.byteLength(paths.socketPath, "utf8")).toBeLessThanOrEqual(MAX_SOCKET_BYTES);

  const dataStat = await lstat(dataDir);
  const runStat = await lstat(paths.runDir);
  expect(dataStat.isSymbolicLink()).toBe(false);
  expect(dataStat.isDirectory()).toBe(true);
  expect(dataStat.uid).toBe(process.geteuid?.());
  expect(dataStat.mode & 0o022).toBe(0);
  expect(runStat.isSymbolicLink()).toBe(false);
  expect(runStat.isDirectory()).toBe(true);
  expect(runStat.uid).toBe(process.geteuid?.());
  expect(runStat.mode & 0o777).toBe(0o700);

  const again = await prepareRuntimePaths(dataDir);
  expect(again).toEqual(paths);
});

test("rejects relative, symlinked, non-directory and group/world-writable data directories", async () => {
  await expect(prepareRuntimePaths("relative/data")).rejects.toMatchObject({ code: INSECURE });

  const real = join(base, "real");
  await mkdir(real, { mode: 0o700 });
  const link = join(base, "link");
  await symlink(real, link);
  await expect(prepareRuntimePaths(link)).rejects.toMatchObject({ code: INSECURE });

  const file = join(base, "file");
  await writeFile(file, "not a directory");
  await expect(prepareRuntimePaths(file)).rejects.toMatchObject({ code: INSECURE });

  const writable = join(base, "writable");
  await mkdir(writable, { mode: 0o755 });
  await chmod(writable, 0o777);
  await expect(prepareRuntimePaths(writable)).rejects.toMatchObject({ code: INSECURE });
});

test("rejects a symlinked run directory and does not follow it", async () => {
  const dataDir = join(base, "data");
  await mkdir(dataDir, { mode: 0o700, recursive: true });
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, join(dataDir, "run"));

  await expect(prepareRuntimePaths(dataDir)).rejects.toMatchObject({ code: INSECURE });
  expect((await lstat(join(dataDir, "run"))).isSymbolicLink()).toBe(true);
});

test("rejects a run directory whose mode is not exactly 0700 without changing it", async () => {
  for (const mode of [0o750, 0o2700]) {
    const dataDir = join(base, `data-${mode.toString(8)}`);
    const runDir = join(dataDir, "run");
    await mkdir(runDir, { mode: 0o700, recursive: true });
    await chmod(runDir, mode);

    await expect(prepareRuntimePaths(dataDir)).rejects.toMatchObject({ code: INSECURE });
    expect((await lstat(runDir)).mode & 0o7777).toBe(mode);
  }
});

test("accepts a socket path of 107 bytes and refuses 108 bytes before creating it", async () => {
  const nameLength =
    MAX_SOCKET_BYTES - Buffer.byteLength(base) - 1 - Buffer.byteLength(SOCKET_TAIL);
  expect(nameLength).toBeGreaterThan(0);

  const exact = join(base, "a".repeat(nameLength));
  expect(Buffer.byteLength(join(exact, "run", "pisces.sock"), "utf8")).toBe(MAX_SOCKET_BYTES);
  const paths = await prepareRuntimePaths(exact);
  expect(paths.socketPath).toBe(join(exact, "run", "pisces.sock"));

  const tooLong = join(base, "a".repeat(nameLength + 1));
  expect(Buffer.byteLength(join(tooLong, "run", "pisces.sock"), "utf8")).toBe(MAX_SOCKET_BYTES + 1);
  await expect(prepareRuntimePaths(tooLong)).rejects.toMatchObject({ code: PATH_TOO_LONG });
  await assertMissing(tooLong);
});

test("keeps the lock held until release and leaves the lock file in place", async () => {
  const { lockPath } = await prepareRuntimePaths(join(base, "data"));

  const first = await acquireDaemonLock(lockPath);
  const lockStat = await lstat(lockPath);
  expect(lockStat.isFile()).toBe(true);
  expect(lockStat.uid).toBe(process.geteuid?.());
  expect(lockStat.mode & 0o777).toBe(0o600);
  await expect(acquireDaemonLock(lockPath)).rejects.toMatchObject({ code: LOCK_BUSY });

  await first.release();
  await first.release();
  expect((await lstat(lockPath)).isFile()).toBe(true);

  const second = await acquireDaemonLock(lockPath);
  await second.release();
  expect((await lstat(lockPath)).isFile()).toBe(true);
});

test("removes a crash-stale same-owner socket", async () => {
  const socketPath = join(base, "stale.sock");
  makeStaleSocket(socketPath);
  expect((await lstat(socketPath)).isSocket()).toBe(true);

  await clearStaleSocket(socketPath);
  await assertMissing(socketPath);
});

test("refuses a live socket without unlinking it", async () => {
  const socketPath = join(base, "live.sock");
  const server = await listen(socketPath);

  await expect(clearStaleSocket(socketPath, 250)).rejects.toMatchObject({ code: SOCKET_LIVE });
  expect((await lstat(socketPath)).isSocket()).toBe(true);
  expect(server.listening).toBe(true);

  const accepted = new Promise<void>((resolve) => server.once("connection", () => resolve()));
  const client = connect(socketPath);
  await accepted;
  client.destroy();
});

test("refuses symlinks and non-socket paths without unlinking them", async () => {
  const regular = join(base, "regular");
  await writeFile(regular, "keep me");
  await expect(clearStaleSocket(regular)).rejects.toMatchObject({ code: SOCKET_LIVE });
  expect(await lstat(regular)).toMatchObject({ size: 7 });

  const link = join(base, "link.sock");
  await symlink(regular, link);
  await expect(clearStaleSocket(link)).rejects.toMatchObject({ code: SOCKET_LIVE });
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
});

test("refuses a same-type socket whose owner is not the current effective uid", async () => {
  const socketPath = join(base, "foreign.sock");
  makeStaleSocket(socketPath);
  const realLstat = runtimePathsFs.lstat;
  runtimePathsFs.lstat = async (path) => {
    const stat = await realLstat(path);
    const foreignUid = (process.geteuid?.() ?? 0) + 1;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: foreignUid });
  };

  await expect(clearStaleSocket(socketPath)).rejects.toMatchObject({ code: SOCKET_LIVE });
  expect((await lstat(socketPath)).isSocket()).toBe(true);
});

test("does not unlink when the socket inode changed during the stale probe", async () => {
  const socketPath = join(base, "swapped.sock");
  makeStaleSocket(socketPath);
  const realLstat = runtimePathsFs.lstat;
  let calls = 0;
  runtimePathsFs.lstat = async (path) => {
    const stat = await realLstat(path);
    calls += 1;
    if (calls === 1) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1 });
  };

  await expect(clearStaleSocket(socketPath, 250)).rejects.toMatchObject({ code: SOCKET_LIVE });
  expect(calls).toBeGreaterThanOrEqual(2);
  expect((await lstat(socketPath)).isSocket()).toBe(true);
});

test("removes the socket only when the recorded dev/ino identity matches", async () => {
  const socketPath = join(base, "owned.sock");
  makeStaleSocket(socketPath);
  const stale = await lstat(socketPath);

  await removeOwnedSocket(socketPath, { dev: stale.dev, ino: stale.ino });
  await assertMissing(socketPath);
});

test("keeps a replacement socket that does not match the recorded identity", async () => {
  const socketPath = join(base, "replaced.sock");
  makeStaleSocket(socketPath);
  const stale = await lstat(socketPath);
  await rm(socketPath);
  const server = await listen(socketPath);
  const replacement = await lstat(socketPath);
  expect(replacement.ino).not.toBe(stale.ino);

  await removeOwnedSocket(socketPath, { dev: stale.dev, ino: stale.ino });
  expect((await lstat(socketPath)).isSocket()).toBe(true);
  expect(server.listening).toBe(true);

  await removeOwnedSocket(socketPath, { dev: replacement.dev, ino: replacement.ino });
  await assertMissing(socketPath);
});

test("ignores missing paths and refuses non-socket paths during owned removal", async () => {
  await removeOwnedSocket(join(base, "absent.sock"), { dev: 0, ino: 0 });

  const regular = join(base, "regular");
  await writeFile(regular, "keep me");
  await removeOwnedSocket(regular, { dev: 0, ino: 0 });
  expect(await lstat(regular)).toMatchObject({ size: 7 });
});

test("error messages do not expose the rejected path", async () => {
  const secret = join(base, "secret-name");
  await mkdir(secret, { mode: 0o700 });
  await chmod(secret, 0o777);
  const error = await prepareRuntimePaths(secret).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: INSECURE });
  expect((error as Error).message).not.toContain(secret);
});

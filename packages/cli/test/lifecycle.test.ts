import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiscesError } from "@pisces/core";
import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
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
} from "../src/lifecycle.js";

const INSECURE = "daemon.insecure_directory";
const INSECURE_MESSAGE = "Data directory is not private";

const dirs: string[] = [];
const servers: Server[] = [];
const connections = new Set<Socket>();

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pisces-lifecycle-"));
  dirs.push(dir);
  return dir;
}

async function startServer(
  socketPath: string,
  onConnection: (socket: Socket) => void,
): Promise<Server> {
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    onConnection(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  for (const socket of connections) socket.destroy();
  connections.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function replyWith(payload: unknown): (socket: Socket) => void {
  return (socket) => {
    socket.once("data", () => socket.write(`${JSON.stringify(payload)}\n`));
  };
}

function reapedPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (result.pid === undefined) throw new Error("expected a child pid");
  return result.pid;
}

async function expectInsecure(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect((error as PiscesError).code).toBe(INSECURE);
    expect((error as PiscesError).message).toBe(INSECURE_MESSAGE);
    return;
  }
  throw new Error(`expected ${INSECURE}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("derives the socket path under run", () => {
  expect(socketPathFor("/data/pisces")).toBe("/data/pisces/run/pisces.sock");
});

test("creates the data directory with mode 0700", async () => {
  const root = await tempDir();
  const dataDir = join(root, "nested", "data");
  await ensureDataDir(dataDir);
  const stat = await lstat(dataDir);
  expect(stat.isDirectory()).toBe(true);
  expect(stat.mode & 0o777).toBe(0o700);
  // Idempotent for an already private directory.
  await ensureDataDir(dataDir);
});

test("rejects group or world writable data directories", async () => {
  const root = await tempDir();
  const dataDir = join(root, "data");
  await mkdir(dataDir, { mode: 0o700 });
  await chmod(dataDir, 0o770);
  await expectInsecure(() => ensureDataDir(dataDir));
});

test("rejects symlinked data directories", async () => {
  const root = await tempDir();
  const real = join(root, "real");
  const link = join(root, "link");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, link);
  await expectInsecure(() => ensureDataDir(link));
});

test("rejects relative and non-directory data directories", async () => {
  const root = await tempDir();
  const file = join(root, "file");
  await writeFile(file, "", { mode: 0o600 });
  await expectInsecure(() => ensureDataDir("relative/data"));
  await expectInsecure(() => ensureDataDir(file));
});

test("creates the pid record exclusively and removes it only for the recorded pid", async () => {
  const dir = await tempDir();
  const socketPath = join(dir, "run", "pisces.sock");
  expect(
    await createPidRecord(dir, {
      pid: 123,
      socketPath,
      startedAt: "2026-11-09T00:00:00.000Z",
    }),
  ).toBe(true);
  expect(await createPidRecord(dir, { pid: 999, socketPath, startedAt: "x" })).toBe(false);
  await removePidRecord(dir, 999);
  expect((await readPidRecord(dir))?.pid).toBe(123);
  await removePidRecord(dir, 123);
  expect(await readPidRecord(dir)).toBeUndefined();
});

test("writes the pid record privately and reads it back", async () => {
  const dir = await tempDir();
  const record = { pid: 7, socketPath: join(dir, "run", "pisces.sock"), startedAt: "now" };
  expect(await createPidRecord(dir, record)).toBe(true);
  expect(await readPidRecord(dir)).toEqual(record);
  expect((await lstat(join(dir, "daemon.pid"))).mode & 0o777).toBe(0o600);
  expect((await readFile(join(dir, "daemon.pid"), "utf8")).trim()).toBe(JSON.stringify(record));
});

test("treats missing, malformed and wrongly typed pid records as absent", async () => {
  const dir = await tempDir();
  expect(await readPidRecord(dir)).toBeUndefined();

  const pidPath = join(dir, "daemon.pid");
  for (const contents of ["not json", "[]", "null", '{"pid":"1"}', '{"pid":-1,"socketPath":"s"}']) {
    await writeFile(pidPath, contents, { mode: 0o600 });
    expect(await readPidRecord(dir)).toBeUndefined();
  }
});

test("removes a pid record only when it names the given pid", async () => {
  const dir = await tempDir();
  const pidPath = join(dir, "daemon.pid");
  const record = { pid: 123, socketPath: join(dir, "run", "pisces.sock"), startedAt: "now" };
  expect(await createPidRecord(dir, record)).toBe(true);
  await removePidRecord(dir, 999);
  expect(await readPidRecord(dir)).toEqual(record);
  await removePidRecord(dir, 123);
  await expect(lstat(pidPath)).rejects.toMatchObject({ code: "ENOENT" });
  // Absent records are also a no-op.
  await removePidRecord(dir, 123);

  // A malformed record names no pid, so the selective remover must keep it.
  await writeFile(pidPath, "garbage", { mode: 0o600 });
  await removePidRecord(dir, 123);
  expect(await readPidRecord(dir)).toBeUndefined();
  await expect(lstat(pidPath)).resolves.toBeDefined();

  await clearPidRecord(dir);
  await expect(lstat(pidPath)).rejects.toMatchObject({ code: "ENOENT" });
  await clearPidRecord(dir);
});

test("detects a pid file whatever it contains", async () => {
  const dir = await tempDir();
  const pidPath = join(dir, "daemon.pid");
  expect(await pidRecordExists(dir)).toBe(false);
  await writeFile(pidPath, "garbage", { mode: 0o600 });
  expect(await pidRecordExists(dir)).toBe(true);
  await rm(pidPath);
  expect(await pidRecordExists(dir)).toBe(false);
});

test("maps unexpected pid write failures to storage.io", async () => {
  const dir = await tempDir();
  try {
    await createPidRecord(join(dir, "missing"), {
      pid: 1,
      socketPath: "s",
      startedAt: "now",
    });
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect((error as PiscesError).code).toBe("storage.io");
    return;
  }
  throw new Error("expected storage.io");
});

test("detects live, reaped and invalid pids", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(reapedPid())).toBe(false);
  for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(isProcessAlive(pid)).toBe(false);
  }
});

test("waits promptly for a dead pid and reports a live one as not exited", async () => {
  const started = Date.now();
  expect(await waitForExit(reapedPid(), 5000)).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await waitForExit(process.pid, 100)).toBe(false);
});

test("probe succeeds only on a compatible hello", async () => {
  const socketPath = join(await tempDir(), "s.sock");
  const server = await startServer(
    socketPath,
    replyWith({ id: "h", result: { version: PROTOCOL_VERSION, compatible: true } }),
  );
  expect(await probeDaemon(socketPath)).toBe(true);
  await closeServer(server);
  expect(await probeDaemon(socketPath)).toBe(false);
});

test("probe sends the protocol hello line and a fixed id", async () => {
  const socketPath = join(await tempDir(), "s.sock");
  let received = "";
  await startServer(socketPath, (socket) => {
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (!received.includes("\n")) return;
      socket.write(`${JSON.stringify({ id: "cli-probe", result: { compatible: true } })}\n`);
    });
  });
  expect(await probeDaemon(socketPath)).toBe(true);
  expect(JSON.parse(received.trim())).toEqual({
    id: "cli-probe",
    method: "protocol.hello",
    params: { versions: [PROTOCOL_VERSION] },
  });
});

test("probe rejects incompatible, malformed and missing daemons", async () => {
  const root = await tempDir();

  const incompatible = join(root, "incompatible.sock");
  await startServer(incompatible, replyWith({ id: "h", result: { compatible: false } }));
  expect(await probeDaemon(incompatible)).toBe(false);

  const erroring = join(root, "error.sock");
  await startServer(
    erroring,
    replyWith({ id: "h", error: { code: "protocol.version_mismatch", message: "no" } }),
  );
  expect(await probeDaemon(erroring)).toBe(false);

  const malformed = join(root, "malformed.sock");
  await startServer(malformed, (socket) => {
    socket.once("data", () => socket.write("not json\n"));
  });
  expect(await probeDaemon(malformed)).toBe(false);

  const closing = join(root, "closing.sock");
  await startServer(closing, (socket) => socket.destroy());
  expect(await probeDaemon(closing)).toBe(false);

  expect(await probeDaemon(join(root, "absent.sock"))).toBe(false);
});

test("probe times out on a silent daemon", async () => {
  const socketPath = join(await tempDir(), "silent.sock");
  await startServer(socketPath, () => {});
  const started = Date.now();
  expect(await probeDaemon(socketPath, 100)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
});

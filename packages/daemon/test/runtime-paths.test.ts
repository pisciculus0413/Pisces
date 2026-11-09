import { spawnSync } from "node:child_process";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  runtimePathsFs.unlink = (path) => unlink(path);
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

const OBSERVATION_TIMEOUT_MS = 5000;

/** Bound a synchronization wait so a missed arrival fails instead of hanging. */
const boundedWait = async (wait: Promise<void>, label: string): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${OBSERVATION_TIMEOUT_MS}ms`)),
      OBSERVATION_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([wait, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs the real preparation flow and inserts an entry at the run path after
 * the first real `lstat` observed it missing, before the actual `mkdir`.
 */
const prepareWithRunInsertion = async (
  dataDir: string,
  runDir: string,
  insert: () => Promise<void>,
): Promise<unknown> => {
  const realLstat = runtimePathsFs.lstat;
  let inserted = false;
  runtimePathsFs.lstat = async (path) => {
    try {
      return await realLstat(path);
    } catch (error) {
      const missing =
        path === runDir &&
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT";
      if (missing && !inserted) {
        inserted = true;
        await insert();
      }
      throw error;
    }
  };
  return prepareRuntimePaths(dataDir).then(
    () => {
      throw new Error("preparation accepted the inserted run path");
    },
    (error: unknown) => error,
  );
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

test("accepts a run directory created concurrently by another preparer", async () => {
  const dataDir = join(base, "data");
  const runDir = join(dataDir, "run");
  const realLstat = runtimePathsFs.lstat;
  let absentObservations = 0;
  let openGate: (() => void) | undefined;
  const bothObservedAbsent = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  runtimePathsFs.lstat = async (path) => {
    try {
      return await realLstat(path);
    } catch (error) {
      const missing =
        path === runDir &&
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT";
      if (!missing) throw error;
      absentObservations += 1;
      if (absentObservations === 2) openGate?.();
      await boundedWait(bothObservedAbsent, "concurrent absent observation");
      throw error;
    }
  };

  const settled = await Promise.allSettled([
    prepareRuntimePaths(dataDir),
    prepareRuntimePaths(dataDir),
  ]);
  expect(absentObservations).toBe(2);
  expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  const prepared = settled.map(
    (result) => (result as PromiseFulfilledResult<{ runDir: string }>).value,
  );
  expect(prepared[0]?.runDir).toBe(runDir);
  expect(prepared[1]).toEqual(prepared[0]);

  const final = await lstat(runDir);
  expect(final.isSymbolicLink()).toBe(false);
  expect(final.isDirectory()).toBe(true);
  expect(final.uid).toBe(process.geteuid?.());
  expect(final.mode & 0o7777).toBe(0o700);
});

test("rejects a symlink inserted after the run directory was observed missing", async () => {
  const dataDir = join(base, "data");
  const runDir = join(dataDir, "run");
  const elsewhere = join(base, "elsewhere");
  await mkdir(elsewhere, { mode: 0o700 });

  const error = await prepareWithRunInsertion(dataDir, runDir, () => symlink(elsewhere, runDir));
  expect(error).toMatchObject({ code: INSECURE });
  expect((await lstat(runDir)).isSymbolicLink()).toBe(true);
  expect((await lstat(elsewhere)).isDirectory()).toBe(true);
  expect(await readdir(elsewhere)).toEqual([]);
});

test("rejects a file inserted after the run directory was observed missing", async () => {
  const dataDir = join(base, "data");
  const runDir = join(dataDir, "run");

  const error = await prepareWithRunInsertion(dataDir, runDir, () => writeFile(runDir, "keep me"));
  expect(error).toMatchObject({ code: INSECURE });
  const inserted = await lstat(runDir);
  expect(inserted.isFile()).toBe(true);
  expect(inserted.size).toBe(7);
});

test("rejects a non-0700 directory inserted after the run directory was observed missing", async () => {
  const dataDir = join(base, "data");
  const runDir = join(dataDir, "run");

  const error = await prepareWithRunInsertion(dataDir, runDir, async () => {
    await mkdir(runDir, { mode: 0o700 });
    await chmod(runDir, 0o750);
  });
  expect(error).toMatchObject({ code: INSECURE });
  const inserted = await lstat(runDir);
  expect(inserted.isDirectory()).toBe(true);
  expect(inserted.mode & 0o7777).toBe(0o750);
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

test.skipIf(process.geteuid?.() !== 0)(
  "refuses a same-type socket whose owner is not the current effective uid",
  async () => {
    const socketPath = join(base, "foreign.sock");
    makeStaleSocket(socketPath);
    await chown(socketPath, 65534, 65534);

    await expect(clearStaleSocket(socketPath)).rejects.toMatchObject({ code: SOCKET_LIVE });
    expect((await lstat(socketPath)).isSocket()).toBe(true);
  },
);

test("does not unlink a live socket that replaces the stale path before quarantine", async () => {
  const socketPath = join(base, "swapped.sock");
  const aside = join(base, "swapped.aside");
  makeStaleSocket(socketPath);
  const realLstat = runtimePathsFs.lstat;
  let calls = 0;
  let liveServer: Server | undefined;
  let liveIno = 0;
  runtimePathsFs.lstat = async (path) => {
    const stat = await realLstat(path);
    calls += 1;
    if (calls === 2) {
      await rename(socketPath, aside);
      liveServer = await listen(socketPath);
      liveIno = (await realLstat(socketPath)).ino;
    }
    return stat;
  };

  await expect(clearStaleSocket(socketPath, 250)).rejects.toMatchObject({ code: SOCKET_LIVE });

  const live = await lstat(socketPath);
  expect(live.isSocket()).toBe(true);
  expect(live.ino).toBe(liveIno);
  expect(liveServer?.listening).toBe(true);
  const accepted = new Promise<void>((resolve) => liveServer?.once("connection", () => resolve()));
  const client = connect(socketPath);
  await accepted;
  client.destroy();
});

test("refuses when an ENOENT probe is followed by the same live socket reappearing", async () => {
  const socketPath = join(base, "moved.sock");
  const aside = join(base, "moved.aside");
  const server = await listen(socketPath);
  const original = await lstat(socketPath);
  const realLstat = runtimePathsFs.lstat;
  let calls = 0;
  runtimePathsFs.lstat = async (path) => {
    calls += 1;
    if (calls === 1) {
      const stat = await realLstat(path);
      await rename(socketPath, aside);
      return stat;
    }
    if (calls === 2) {
      await rename(aside, socketPath);
      return realLstat(path);
    }
    return realLstat(path);
  };

  await expect(clearStaleSocket(socketPath, 250)).rejects.toMatchObject({ code: SOCKET_LIVE });

  const restored = await lstat(socketPath);
  expect(restored.isSocket()).toBe(true);
  expect(restored.ino).toBe(original.ino);
  expect(server.listening).toBe(true);
});

test("does nothing when the probed path disappears and stays absent", async () => {
  const socketPath = join(base, "vanished.sock");
  makeStaleSocket(socketPath);
  const realLstat = runtimePathsFs.lstat;
  let calls = 0;
  runtimePathsFs.lstat = async (path) => {
    const stat = await realLstat(path);
    calls += 1;
    if (calls === 1) await rm(path);
    return stat;
  };

  await expect(clearStaleSocket(socketPath, 250)).resolves.toBeUndefined();
  await assertMissing(socketPath);
});

test("surfaces a normalized error when a quarantined stale socket cannot be unlinked", async () => {
  const socketPath = join(base, "unlink.sock");
  makeStaleSocket(socketPath);
  const realUnlink = runtimePathsFs.unlink;
  runtimePathsFs.unlink = async (path) => {
    if (path.startsWith(`${socketPath}.stale-`)) {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return realUnlink(path);
  };

  await expect(clearStaleSocket(socketPath)).rejects.toMatchObject({ code: SOCKET_LIVE });
  await assertMissing(socketPath);
  const quarantined = (await readdir(base)).filter((name) => name.startsWith("unlink.sock.stale-"));
  expect(quarantined).toHaveLength(1);
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

test("does not unlink a live socket that replaces the owned path before quarantine", async () => {
  const socketPath = join(base, "swap-owned.sock");
  const aside = join(base, "swap-owned.aside");
  makeStaleSocket(socketPath);
  const stale = await lstat(socketPath);
  const realLstat = runtimePathsFs.lstat;
  let calls = 0;
  let liveServer: Server | undefined;
  let liveIno = 0;
  runtimePathsFs.lstat = async (path) => {
    const stat = await realLstat(path);
    calls += 1;
    if (calls === 1) {
      await rename(socketPath, aside);
      liveServer = await listen(socketPath);
      liveIno = (await realLstat(socketPath)).ino;
    }
    return stat;
  };

  await expect(
    removeOwnedSocket(socketPath, { dev: stale.dev, ino: stale.ino }),
  ).rejects.toMatchObject({ code: SOCKET_LIVE });

  const live = await lstat(socketPath);
  expect(live.isSocket()).toBe(true);
  expect(live.ino).toBe(liveIno);
  expect(liveServer?.listening).toBe(true);
});

test("surfaces a normalized error when a quarantined owned socket cannot be unlinked", async () => {
  const socketPath = join(base, "unlink-owned.sock");
  makeStaleSocket(socketPath);
  const stale = await lstat(socketPath);
  const realUnlink = runtimePathsFs.unlink;
  runtimePathsFs.unlink = async (path) => {
    if (path.startsWith(`${socketPath}.stale-`)) {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return realUnlink(path);
  };

  await expect(
    removeOwnedSocket(socketPath, { dev: stale.dev, ino: stale.ino }),
  ).rejects.toMatchObject({ code: SOCKET_LIVE });
  await assertMissing(socketPath);
  const quarantined = (await readdir(base)).filter((name) =>
    name.startsWith("unlink-owned.sock.stale-"),
  );
  expect(quarantined).toHaveLength(1);
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

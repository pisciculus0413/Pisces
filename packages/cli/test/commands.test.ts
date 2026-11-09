import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiscesError } from "@pisces/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type ChildHandle,
  type CommandDeps,
  type CommandIo,
  type SpawnedChild,
  startCommand,
  statusCommand,
  stopCommand,
  wrapChild,
} from "../src/commands.js";
import { readPidRecord, socketPathFor } from "../src/lifecycle.js";

const STARTED_AT = "2026-11-09T00:00:00.000Z";
const KEY_ENV = "PISCES_TASK4_KEY";
const ABSENT_KEY_ENV = "PISCES_TASK4_ABSENT_KEY";
const SECRET = "sk-task4-secret";
const CHILD_PID = 4242;

const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv(KEY_ENV, SECRET);
  delete process.env[ABSENT_KEY_ENV];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
}

async function fixture(apiKeyEnv = KEY_ENV): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-commands-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      providers: [
        {
          id: "fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
  );
  return { root, dataDir, configPath };
}

interface FakeChild extends ChildHandle {
  signals: NodeJS.Signals[];
  unrefs: number;
}

function fakeChild(pid = CHILD_PID, exitCode: number | null = null): FakeChild {
  const child: FakeChild = {
    pid,
    exitCode,
    signals: [],
    unrefs: 0,
    kill(signal) {
      child.signals.push(signal);
    },
    unref() {
      child.unrefs += 1;
    },
  };
  return child;
}

function fakeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  let elapsed = 0;
  return {
    spawnChild: () => {
      throw new Error("spawnChild must not be called");
    },
    probe: async () => false,
    isAlive: () => false,
    waitForExit: async () => false,
    sleep: async (ms) => {
      elapsed += ms;
    },
    clock: () => elapsed,
    now: () => STARTED_AT,
    signal: () => {},
    ...overrides,
  };
}

interface Recorder {
  io: CommandIo;
  out: string[];
  err: string[];
}

function recorder(): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function writeRecord(dataDir: string, pid: number, socketPath = socketPathFor(dataDir)): void {
  writeFileSync(
    join(dataDir, "daemon.pid"),
    `${JSON.stringify({ pid, socketPath, startedAt: STARTED_AT })}\n`,
  );
}

test("start spawns, records and reports a running daemon", async () => {
  const { dataDir, configPath } = await fixture();
  const child = fakeChild();
  const spawns: { entry: string; args: string[]; logPath: string }[] = [];
  const probes: string[] = [];
  const deps = fakeDeps({
    probe: async (socketPath) => {
      probes.push(socketPath);
      return probes.length > 1;
    },
    isAlive: () => true,
    spawnChild: (entry, args, logPath) => {
      spawns.push({ entry, args, logPath });
      return child;
    },
  });
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(0);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]?.entry.endsWith("daemon-child.js")).toBe(true);
  expect(spawns[0]?.args).toEqual([configPath, dataDir]);
  expect(spawns[0]?.logPath).toBe(join(dataDir, "daemon.log"));
  expect(await readPidRecord(dataDir)).toEqual({
    pid: CHILD_PID,
    socketPath: socketPathFor(dataDir),
    startedAt: STARTED_AT,
  });
  expect(child.unrefs).toBe(1);
  expect(rec.out).toEqual([`running (pid ${CHILD_PID}, socket ${socketPathFor(dataDir)})`]);
  expect(rec.err).toEqual([]);
});

test("start refuses a second daemon when the socket already answers", async () => {
  const { dataDir, configPath } = await fixture();
  const rec = recorder();

  const code = await startCommand(
    { configPath, io: rec.io },
    fakeDeps({ probe: async () => true }),
  );

  expect(code).toBe(1);
  expect(rec.err.join("\n")).toContain("daemon.already_running");
  expect(await readPidRecord(dataDir)).toBeUndefined();
});

test("start keeps the record of a live but unresponsive owner", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 987);
  const rec = recorder();

  const code = await startCommand(
    { configPath, io: rec.io },
    fakeDeps({ isAlive: (pid) => pid === 987, probe: async () => false }),
  );

  expect(code).toBe(1);
  expect(rec.err.join("\n")).toContain("daemon.unknown_owner");
  expect((await readPidRecord(dataDir))?.pid).toBe(987);
});

test("start replaces a stale record and reports the new pid", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const child = fakeChild();
  let probes = 0;
  const rec = recorder();

  const code = await startCommand(
    { configPath, io: rec.io },
    fakeDeps({
      spawnChild: () => child,
      isAlive: (pid) => pid === CHILD_PID,
      probe: async () => {
        probes += 1;
        return probes > 1;
      },
    }),
  );

  expect(code).toBe(0);
  expect((await readPidRecord(dataDir))?.pid).toBe(CHILD_PID);
  expect(rec.out).toEqual([`running (pid ${CHILD_PID}, socket ${socketPathFor(dataDir)})`]);
});

test("start cleans up when the child exits during readiness", async () => {
  const { dataDir, configPath } = await fixture();
  const child = fakeChild();
  child.exitCode = 0;
  const waits: number[] = [];
  const deps = fakeDeps({
    spawnChild: () => child,
    isAlive: () => true,
    waitForExit: async (_pid, timeoutMs) => {
      waits.push(timeoutMs);
      return true;
    },
  });
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(waits).toEqual([1_000]);
  expect(child.unrefs).toBe(1);
  expect(await readPidRecord(dataDir)).toBeUndefined();
  expect(rec.err.join("\n")).toContain("daemon.start_failed");
  expect(rec.err.join("\n")).toContain(join(dataDir, "daemon.log"));
});

test("start fails when the child vanishes without an exit code", async () => {
  const { dataDir, configPath } = await fixture();
  const child = fakeChild();
  const deps = fakeDeps({ spawnChild: () => child, isAlive: () => false });
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(child.unrefs).toBe(1);
  expect(await readPidRecord(dataDir)).toBeUndefined();
  expect(rec.err.join("\n")).toContain("daemon.start_failed");
  expect(rec.err.join("\n")).toContain(join(dataDir, "daemon.log"));
});

test("start cleans up when the pid record stops matching the child", async () => {
  const { dataDir, configPath } = await fixture();
  const child = fakeChild();
  let probes = 0;
  const deps = fakeDeps({
    spawnChild: () => child,
    isAlive: (pid) => pid === CHILD_PID,
    probe: async () => {
      probes += 1;
      // The readiness probe sees another launcher take over the record.
      if (probes === 2) writeRecord(dataDir, 1111);
      return false;
    },
  });
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect((await readPidRecord(dataDir))?.pid).toBe(1111);
  expect(rec.err.join("\n")).toContain("daemon.start_failed");
});

test("start kills its child when another launcher wins the pid record race", async () => {
  const { dataDir, configPath } = await fixture();
  const child = fakeChild();
  const deps = fakeDeps({
    spawnChild: () => {
      writeRecord(dataDir, 1111);
      return child;
    },
    isAlive: () => false,
  });
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(child.unrefs).toBe(1);
  expect((await readPidRecord(dataDir))?.pid).toBe(1111);
  expect(rec.err.join("\n")).toContain("daemon.already_running");
});

test("start bounds readiness by wall-clock time and caps each probe", async () => {
  const { dataDir, configPath } = await fixture();
  const child = fakeChild();
  let elapsed = 0;
  const probes: number[] = [];
  const deps = fakeDeps({
    clock: () => elapsed,
    spawnChild: () => child,
    isAlive: () => true,
    probe: async (_socketPath, timeoutMs = 500) => {
      probes.push(timeoutMs);
      elapsed += timeoutMs;
      return false;
    },
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(probes.length).toBeLessThanOrEqual(20);
  expect(Math.max(...probes)).toBeLessThanOrEqual(500);
  expect(probes.at(-1)).toBeLessThan(500);
  expect(elapsed).toBeLessThanOrEqual(10_000);
  expect(await readPidRecord(dataDir)).toBeUndefined();
  expect(rec.err.join("\n")).toContain("daemon.start_failed");
});

test("start reclaims a malformed pid file when no daemon answers", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(join(dataDir, "daemon.pid"), "garbage", { mode: 0o600 });
  const child = fakeChild();
  let probes = 0;
  const rec = recorder();

  const code = await startCommand(
    { configPath, io: rec.io },
    fakeDeps({
      spawnChild: () => child,
      isAlive: (pid) => pid === CHILD_PID,
      probe: async () => {
        probes += 1;
        return probes > 1;
      },
    }),
  );

  expect(code).toBe(0);
  expect((await readPidRecord(dataDir))?.pid).toBe(CHILD_PID);
  expect(rec.out).toEqual([`running (pid ${CHILD_PID}, socket ${socketPathFor(dataDir)})`]);
});

test("start refuses when a malformed pid file sits next to an answering daemon", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  const pidPath = join(dataDir, "daemon.pid");
  await writeFile(pidPath, "garbage", { mode: 0o600 });
  const deps = fakeDeps({ probe: async () => true });
  const spawn = vi.spyOn(deps, "spawnChild");
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(rec.err.join("\n")).toContain("daemon.already_running");
  expect(spawn).not.toHaveBeenCalled();
  expect(await readFile(pidPath, "utf8")).toBe("garbage");
});

test("start reports a spawn failure as a start failure with the log path", async () => {
  const { dataDir, configPath } = await fixture();
  const rec = recorder();

  const code = await startCommand(
    { configPath, io: rec.io },
    fakeDeps({
      spawnChild: () => {
        throw new Error("EACCES");
      },
    }),
  );

  expect(code).toBe(1);
  expect(rec.err.join("\n")).toContain("daemon.start_failed");
  expect(rec.err.join("\n")).toContain(join(dataDir, "daemon.log"));
  expect(rec.err.join("\n")).not.toContain("daemon.insecure_directory");
});

test("start keeps the insecure-directory report for an unopenable log", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await startCommand(
    { configPath, io: rec.io },
    fakeDeps({
      spawnChild: () => {
        throw new PiscesError("daemon.insecure_directory", "Data directory is not private");
      },
    }),
  );

  expect(code).toBe(2);
  expect(rec.err).toEqual(["error: daemon.insecure_directory: Data directory is not private"]);
});

test("start reports a missing api key without spawning", async () => {
  const { configPath } = await fixture(ABSENT_KEY_ENV);
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, fakeDeps());

  expect(code).toBe(2);
  expect(rec.err).toEqual(["error: config.missing_api_key: Missing API key environment variable"]);
  expect(rec.err.join("\n")).not.toContain(ABSENT_KEY_ENV);
  expect(rec.err.join("\n")).not.toContain(SECRET);
});

test("start reports an unusable data directory before spawning", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps = fakeDeps();
  const start = vi.spyOn(deps, "spawnChild");

  const code = await startCommand({ configPath, dataDir: "relative/data", io: rec.io }, deps);

  expect(code).toBe(2);
  expect(rec.err.join("\n")).toContain("daemon.insecure_directory");
  expect(start).not.toHaveBeenCalled();
});

test("status reports stopped, stale, running and unresponsive states", async () => {
  const { dataDir, configPath } = await fixture();

  const stopped = recorder();
  expect(await statusCommand({ configPath, io: stopped.io }, fakeDeps())).toBe(1);
  expect(stopped.out).toEqual(["stopped"]);

  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const stale = recorder();
  expect(
    await statusCommand({ configPath, io: stale.io }, fakeDeps({ isAlive: () => false })),
  ).toBe(1);
  expect(stale.out).toEqual(["stopped (stale pid file)"]);
  expect(await readPidRecord(dataDir)).toBeUndefined();

  writeRecord(dataDir, 1111);
  const running = recorder();
  expect(
    await statusCommand(
      { configPath, io: running.io },
      fakeDeps({ isAlive: () => true, probe: async () => true }),
    ),
  ).toBe(0);
  expect(running.out).toEqual([`running (pid 1111, socket ${socketPathFor(dataDir)})`]);

  const unresponsive = recorder();
  expect(
    await statusCommand(
      { configPath, io: unresponsive.io },
      fakeDeps({ isAlive: () => true, probe: async () => false }),
    ),
  ).toBe(1);
  expect(unresponsive.out).toEqual(["unresponsive (pid 1111)"]);
  expect((await readPidRecord(dataDir))?.pid).toBe(1111);
});

test("status reports an unmanaged socket without a pid record", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  const rec = recorder();

  const code = await statusCommand(
    { configPath, io: rec.io },
    fakeDeps({ probe: async () => true }),
  );

  expect(code).toBe(1);
  expect(rec.out).toEqual([`unmanaged (socket ${socketPathFor(dataDir)})`]);
  expect(await readPidRecord(dataDir)).toBeUndefined();
});

test("status --json reports the state without key material", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const rec = recorder();

  const code = await statusCommand(
    { configPath, json: true, io: rec.io },
    fakeDeps({ isAlive: () => true, probe: async () => true }),
  );

  expect(code).toBe(0);
  const output = rec.out.join("\n");
  expect(output).not.toContain(SECRET);
  expect(output).not.toContain(KEY_ENV);
  expect(JSON.parse(output)).toEqual({
    state: "running",
    pid: 1111,
    socketPath: socketPathFor(dataDir),
    dataDir,
  });
});

test("status --json omits the pid for stale records", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const rec = recorder();

  await statusCommand({ configPath, json: true, io: rec.io }, fakeDeps({ isAlive: () => false }));

  const parsed = JSON.parse(rec.out.join("\n")) as Record<string, unknown>;
  expect(parsed.state).toBe("stale");
  expect("pid" in parsed).toBe(false);
  expect(parsed.socketPath).toBe(socketPathFor(dataDir));
});

test("stop reports nothing to do when no daemon answers", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await stopCommand({ configPath, io: rec.io }, fakeDeps());

  expect(code).toBe(0);
  expect(rec.out).toEqual(["not running"]);
  expect(rec.err).toEqual([]);
});

test("stop refuses to signal an unmanaged socket", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  const signals: NodeJS.Signals[] = [];
  const rec = recorder();

  const code = await stopCommand(
    { configPath, io: rec.io },
    fakeDeps({
      probe: async () => true,
      signal: (_pid, signal) => {
        signals.push(signal);
      },
    }),
  );

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: daemon.unmanaged: unmanaged daemon"]);
  expect(signals).toEqual([]);
  expect(await readPidRecord(dataDir)).toBeUndefined();
});

test("stop removes a stale record without signaling", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const signals: NodeJS.Signals[] = [];
  const rec = recorder();

  const code = await stopCommand(
    { configPath, io: rec.io },
    fakeDeps({
      isAlive: () => false,
      signal: (_pid, signal) => {
        signals.push(signal);
      },
    }),
  );

  expect(code).toBe(0);
  expect(rec.out).toEqual(["not running"]);
  expect(signals).toEqual([]);
  expect(await readPidRecord(dataDir)).toBeUndefined();
});

test("stop signals a responsive daemon and waits for it to exit", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const waits: number[] = [];
  const rec = recorder();

  const code = await stopCommand(
    { configPath, io: rec.io },
    fakeDeps({
      isAlive: () => true,
      probe: async () => true,
      waitForExit: async (_pid, timeoutMs) => {
        waits.push(timeoutMs);
        return true;
      },
      signal: (pid, signal) => {
        signals.push({ pid, signal });
      },
    }),
  );

  expect(code).toBe(0);
  expect(signals).toEqual([{ pid: 1111, signal: "SIGTERM" }]);
  expect(waits).toEqual([10_000]);
  expect(rec.out).toEqual([`stopped (pid 1111, socket ${socketPathFor(dataDir)})`]);
  expect(await readPidRecord(dataDir)).toBeUndefined();
});

test("stop keeps a live record whose owner does not answer", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const signals: NodeJS.Signals[] = [];
  const rec = recorder();

  const code = await stopCommand(
    { configPath, io: rec.io },
    fakeDeps({
      isAlive: () => true,
      probe: async () => false,
      signal: (_pid, signal) => {
        signals.push(signal);
      },
    }),
  );

  expect(code).toBe(1);
  expect(rec.err.join("\n")).toContain("daemon.unknown_owner");
  expect(signals).toEqual([]);
  expect((await readPidRecord(dataDir))?.pid).toBe(1111);
});

test("stop keeps the record when the daemon does not exit in time", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const rec = recorder();

  const code = await stopCommand(
    { configPath, io: rec.io },
    fakeDeps({
      isAlive: () => true,
      probe: async () => true,
      waitForExit: async () => false,
      signal: () => {},
    }),
  );

  expect(code).toBe(1);
  expect(rec.err.join("\n")).toContain("daemon.stop_timeout");
  expect((await readPidRecord(dataDir))?.pid).toBe(1111);
});

test("stop prints the derived socket path", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const rec = recorder();

  const code = await stopCommand(
    { configPath, io: rec.io },
    fakeDeps({ isAlive: () => true, probe: async () => true, waitForExit: async () => true }),
  );

  expect(code).toBe(0);
  expect(rec.out).toEqual([`stopped (pid 1111, socket ${socketPathFor(dataDir)})`]);
});

test("status and stop never trust the record's socketPath", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  const foreign = join(dataDir, "elsewhere", "other.sock");
  writeRecord(dataDir, 1111, foreign);

  const probes: string[] = [];
  const signals: NodeJS.Signals[] = [];
  const deps = fakeDeps({
    isAlive: () => true,
    // Only the foreign path answers; the derived socket is dead.
    probe: async (socketPath) => {
      probes.push(socketPath);
      return socketPath === foreign;
    },
    signal: (_pid, signal) => {
      signals.push(signal);
    },
  });

  const status = recorder();
  expect(await statusCommand({ configPath, io: status.io }, deps)).toBe(1);
  expect(status.err).toEqual([
    "error: daemon.unknown_owner: A process owns the runtime but did not answer; check manually",
  ]);
  expect(status.out).toEqual([]);

  const json = recorder();
  expect(await statusCommand({ configPath, json: true, io: json.io }, deps)).toBe(1);
  expect(json.out).toEqual([]);
  expect(json.err.join("\n")).toContain("daemon.unknown_owner");

  const stop = recorder();
  expect(await stopCommand({ configPath, io: stop.io }, deps)).toBe(1);
  expect(stop.err.join("\n")).toContain("daemon.unknown_owner");
  expect(signals).toEqual([]);
  expect(probes).toEqual([]);
  expect((await readPidRecord(dataDir))?.socketPath).toBe(foreign);
});

test("stop probes the socket derived from the data directory", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  writeRecord(dataDir, 1111);
  const probes: string[] = [];
  const rec = recorder();

  const code = await stopCommand(
    { configPath, io: rec.io },
    fakeDeps({
      isAlive: () => true,
      probe: async (socketPath) => {
        probes.push(socketPath);
        return true;
      },
      waitForExit: async () => true,
    }),
  );

  expect(code).toBe(0);
  expect(probes).toEqual([socketPathFor(dataDir)]);
});

test("start reports a pid-record write failure as a runtime failure", async () => {
  const { dataDir, configPath } = await fixture();
  // Read-only data directory: the record cannot be created.
  await mkdir(dataDir, { mode: 0o500 });
  const child = fakeChild();
  const rec = recorder();

  const code = await startCommand(
    { configPath, io: rec.io },
    fakeDeps({ spawnChild: () => child, isAlive: () => true, waitForExit: async () => true }),
  );

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: storage.io: Daemon pid file could not be written"]);
  expect(child.signals).toEqual(["SIGTERM"]);
  expect(child.unrefs).toBe(1);

  await rm(dataDir, { recursive: true, force: true });
});

test("start reports a pid-record cleanup failure as a runtime failure", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  // An unremovable pid "file": unlink on a directory fails.
  await mkdir(join(dataDir, "daemon.pid"));
  const deps = fakeDeps();
  const spawn = vi.spyOn(deps, "spawnChild");
  const rec = recorder();

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: storage.io: Daemon pid file could not be written"]);
  expect(spawn).not.toHaveBeenCalled();
});

interface FakeSpawned extends EventEmitter {
  exitCode: number | null;
  kills: NodeJS.Signals[];
  unrefs: number;
}

function fakeSpawned(): FakeSpawned {
  const spawned = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kills: [] as NodeJS.Signals[],
    unrefs: 0,
    kill(signal: NodeJS.Signals): boolean {
      spawned.kills.push(signal);
      return true;
    },
    unref(): void {
      spawned.unrefs += 1;
    },
  });
  return spawned;
}

test("a spawn error marks the wrapped child as exited instead of crashing", () => {
  const spawned = fakeSpawned();
  const handle = wrapChild(spawned as unknown as SpawnedChild, 4242);

  expect(handle.pid).toBe(4242);
  expect(handle.exitCode).toBeNull();

  expect(() => spawned.emit("error", new Error("EMFILE: too many open files"))).not.toThrow();
  expect(handle.exitCode).not.toBeNull();
});

test("a child exit marks the wrapped handle as exited", () => {
  const spawned = fakeSpawned();
  const handle = wrapChild(spawned as unknown as SpawnedChild, 4242);

  spawned.exitCode = 0;
  spawned.emit("exit", 0, null);

  expect(handle.exitCode).toBe(0);
});

test("the wrapped handle forwards kill and unref", () => {
  const spawned = fakeSpawned();
  const handle = wrapChild(spawned as unknown as SpawnedChild, 4242);

  handle.kill("SIGTERM");
  handle.unref();

  expect(spawned.kills).toEqual(["SIGTERM"]);
  expect(spawned.unrefs).toBe(1);
});

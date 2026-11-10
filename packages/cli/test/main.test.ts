import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { ChildHandle, CommandDeps, CommandIo } from "../src/commands.js";
import { readPidRecord } from "../src/lifecycle.js";
import { isEntryPath, runCli } from "../src/main.js";

const CHILD_PID = 4242;
const KEY_ENV = "PISCES_TASK4_MAIN_KEY";

const roots: string[] = [];

afterEach(async () => {
  delete process.env[KEY_ENV];
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-main-"));
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
          apiKeyEnv: KEY_ENV,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
  );
  process.env[KEY_ENV] = "sk-main-secret";
  return { root, dataDir, configPath };
}

function fakeChild(pid = CHILD_PID): ChildHandle {
  return { pid, exitCode: null, kill: () => {}, unref: () => {} };
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
    now: () => "2026-11-09T00:00:00.000Z",
    signal: () => {},
    listSessions: async () => [],
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

test("runCli rejects unknown commands, flags and missing values with usage", async () => {
  const cases = [[], ["wat"], ["start", "--config"], ["start", "--bogus"], ["start", "--json"]];
  for (const argv of cases) {
    const rec = recorder();
    expect(await runCli(argv, rec.io, fakeDeps())).toBe(2);
    expect(rec.err.join("\n")).toContain("usage: pisces");
    expect(rec.out).toEqual([]);
  }
});

test("runCli does not let help win after an unknown command", async () => {
  for (const argv of [
    ["wat", "--help"],
    ["wat", "--version"],
  ]) {
    const rec = recorder();
    expect(await runCli(argv, rec.io, fakeDeps())).toBe(2);
    expect(rec.err.join("\n")).toContain("usage: pisces");
    expect(rec.out).toEqual([]);
  }
});

test("runCli rejects option values that look like flags", async () => {
  for (const argv of [
    ["start", "--config", "-x"],
    ["start", "--data-dir", "--json"],
    ["status", "--config", "-h"],
  ]) {
    const rec = recorder();
    expect(await runCli(argv, rec.io, fakeDeps())).toBe(2);
    expect(rec.err.join("\n")).toContain("usage: pisces");
    expect(rec.out).toEqual([]);
  }
});

test("isEntryPath resolves the entry through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pisces-entry-"));
  roots.push(root);
  const real = join(root, "main.js");
  await writeFile(real, "");
  const link = join(root, "pisces");
  await symlink(real, link);
  const moduleUrl = pathToFileURL(real).href;

  expect(isEntryPath(link, moduleUrl)).toBe(true);
  expect(isEntryPath(real, moduleUrl)).toBe(true);
  expect(isEntryPath(undefined, moduleUrl)).toBe(false);
  expect(isEntryPath(join(root, "missing.js"), moduleUrl)).toBe(false);
  expect(isEntryPath(link, pathToFileURL(join(root, "other.js")).href)).toBe(false);
});

test("runCli prints help and the version", async () => {
  const help = recorder();
  expect(await runCli(["--help"], help.io, fakeDeps())).toBe(0);
  expect(help.out.join("\n")).toContain("start the daemon in the background");
  expect(help.out.join("\n")).toContain("status   report the daemon state");
  expect(help.out.join("\n")).toContain("stop     stop the daemon");
  expect(help.err).toEqual([]);

  const version = recorder();
  expect(await runCli(["--version"], version.io, fakeDeps())).toBe(0);
  expect(version.out.join("\n")).toMatch(/^pisces \d+\.\d+\.\d+$/);

  const nested = recorder();
  expect(await runCli(["start", "--help"], nested.io, fakeDeps())).toBe(0);
  expect(nested.out.join("\n")).toContain("usage: pisces");
});

test("runCli forwards the data directory override to start and the pid record", async () => {
  const { root, dataDir, configPath } = await fixture();
  const override = join(root, "override");
  const spawns: { entry: string; args: string[]; logPath: string }[] = [];
  let probes = 0;
  const deps = fakeDeps({
    probe: async () => {
      probes += 1;
      return probes > 1;
    },
    isAlive: () => true,
    spawnChild: (entry, args, logPath) => {
      spawns.push({ entry, args, logPath });
      return fakeChild();
    },
  });
  const rec = recorder();

  const code = await runCli(
    ["start", "--config", configPath, "--data-dir", override],
    rec.io,
    deps,
  );

  expect(code).toBe(0);
  expect(spawns[0]?.args).toEqual([configPath, override]);
  expect(spawns[0]?.logPath).toBe(join(override, "daemon.log"));
  expect((await readPidRecord(override))?.pid).toBe(CHILD_PID);
  expect(await readPidRecord(dataDir)).toBeUndefined();
  expect(rec.out.join("\n")).toContain("running (pid 4242");
});

test("runCli resolves the default config path from the environment", async () => {
  const { root } = await fixture();
  const configHome = join(root, "config");
  const configPath = join(configHome, "pisces", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, await readFile(join(root, "config.json")));
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  const rec = recorder();

  const code = await runCli(["status", "--json"], rec.io, fakeDeps());

  expect(code).toBe(1);
  expect(JSON.parse(rec.out.join("\n"))).toMatchObject({ state: "stopped" });
});

test("runCli stops a responsive daemon", async () => {
  const { dataDir, configPath } = await fixture();
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(
    join(dataDir, "daemon.pid"),
    `${JSON.stringify({
      pid: 1111,
      socketPath: join(dataDir, "run", "pisces.sock"),
      startedAt: "2026-11-09T00:00:00.000Z",
    })}\n`,
  );
  const signals: NodeJS.Signals[] = [];
  const deps = fakeDeps({
    isAlive: () => true,
    probe: async () => true,
    waitForExit: async () => true,
    signal: (_pid, signal) => {
      signals.push(signal);
    },
  });
  const rec = recorder();

  const code = await runCli(["stop", "--config", configPath], rec.io, deps);

  expect(code).toBe(0);
  expect(signals).toEqual(["SIGTERM"]);
  expect(rec.out).toEqual([`stopped (pid 1111, socket ${join(dataDir, "run", "pisces.sock")})`]);
  expect(await readPidRecord(dataDir)).toBeUndefined();
});

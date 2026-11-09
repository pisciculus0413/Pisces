import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { probeDaemon, readPidRecord, socketPathFor } from "../src/lifecycle.js";

/**
 * Real-process acceptance: the built CLI, a real detached daemon and a real
 * Unix-socket handshake. Nothing is faked except the provider `baseUrl`, which
 * points at a closed port so no network is needed.
 *
 * Each test owns a temp root; `afterEach` reaps every daemon through its pid
 * record (with SIGKILL as a test-only fallback) and removes the root.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const KEY_ENV = "PISCES_TEST_KEY";
const KEY_VALUE = "sk-test-not-real";
const TEST_TIMEOUT_MS = 30_000;
/** Leave room for the bounded cleanup before vitest's own timeout fires. */
const CLI_WAIT_MS = TEST_TIMEOUT_MS - 5_000;
const DAEMON_WAIT_MS = 8_000;

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
}

const roots: string[] = [];
const children = new Set<ChildProcess>();
const observedPids = new Set<number>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  children.clear();

  for (const root of roots.splice(0)) {
    const dataDir = join(root, "data");
    const record = await readPidRecord(dataDir);
    if (record !== undefined) observedPids.add(record.pid);
    // A losing or aborted child can still be starting; reap it by command line.
    for (const pid of await daemonProcesses(dataDir)) observedPids.add(pid);
    await rm(root, { recursive: true, force: true });
  }

  for (const pid of observedPids) {
    killIfAlive(pid);
  }
  observedPids.clear();
});

function killIfAlive(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ESRCH: already gone.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-cli-acceptance-"));
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
  return { root, dataDir, configPath };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliProcess {
  child: ChildProcess;
  done: Promise<RunResult>;
}

/** Spawns the built entry; every child is bounded and always ends up reaped. */
function cli(args: string[]): CliProcess {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { ...process.env, [KEY_ENV]: KEY_VALUE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let settled = false;
  const done = new Promise<RunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      reject(new Error(`pisces ${args.join(" ")} did not exit\n${stdout}${stderr}`));
    }, CLI_WAIT_MS);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

  return { child, done };
}

function run(args: string[]): Promise<RunResult> {
  return cli(args).done;
}

const command = (fixture: Fixture, args: string[]): string[] => [
  ...args,
  "--config",
  fixture.configPath,
  "--data-dir",
  fixture.dataDir,
];

async function waitForProbe(socketPath: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + DAEMON_WAIT_MS;
  for (;;) {
    if ((await probeDaemon(socketPath)) === expected) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Pids of live processes whose command line names our dataDir and the child entry. */
async function daemonProcesses(dataDir: string): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = await readFile(join("/proc", entry, "cmdline"), "utf8");
    } catch {
      continue;
    }
    if (cmdline.includes("daemon-child.js") && cmdline.includes(dataDir)) found.push(pid);
  }
  return found;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  expect(isAlive(pid)).toBe(false);
  return pid;
}

async function writePidFile(fixture: Fixture, pid: number, socketPath: string): Promise<void> {
  await mkdir(fixture.dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(fixture.dataDir, "daemon.pid"),
    `${JSON.stringify({ pid, socketPath, startedAt: new Date().toISOString() })}\n`,
  );
}

test(
  "start, status and stop drive a real daemon",
  async () => {
    const fixture = await makeFixture();
    const socketPath = socketPathFor(fixture.dataDir);

    // A cold start exits 0 only after the daemon answered a handshake.
    const started = await run(command(fixture, ["start"]));
    expect(started.stderr).toBe("");
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("running");

    const record = await readPidRecord(fixture.dataDir);
    expect(record).toBeDefined();
    expect(record?.socketPath).toBe(socketPath);
    expect(record?.pid).toBeGreaterThan(0);
    expect(isAlive(record?.pid ?? 0)).toBe(true);
    expect(await probeDaemon(socketPath)).toBe(true);
    observedPids.add(record?.pid ?? 0);

    const log = await readFile(join(fixture.dataDir, "daemon.log"), "utf8");
    expect(log).toContain("running");
    expect(log).not.toContain(KEY_VALUE);

    const secondStart = await run(command(fixture, ["start"]));
    expect(secondStart.code).toBe(1);
    expect(secondStart.stderr).toContain("daemon.already_running");

    const status = await run(command(fixture, ["status"]));
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("running");

    const json = await run(command(fixture, ["status", "--json"]));
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ state: "running" });
    expect(json.stdout).not.toContain(KEY_VALUE);

    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("stopped");
    expect(await readPidRecord(fixture.dataDir)).toBeUndefined();
    await waitForProbe(socketPath, false);
    expect(await probeDaemon(socketPath)).toBe(false);
    expect(isAlive(record?.pid ?? 0)).toBe(false);
    expect(await daemonProcesses(fixture.dataDir)).toEqual([]);

    const secondStop = await run(command(fixture, ["stop"]));
    expect(secondStop.code).toBe(0);
    expect(secondStop.stdout).toContain("not running");
  },
  TEST_TIMEOUT_MS,
);

test(
  "a stale pid file is cleaned by status and stop",
  async () => {
    const fixture = await makeFixture();
    const socketPath = socketPathFor(fixture.dataDir);
    const pid = await deadPid();

    await writePidFile(fixture, pid, socketPath);
    const status = await run(command(fixture, ["status"]));
    expect(status.code).toBe(1);
    expect(status.stdout).toContain("stale");
    expect(await readPidRecord(fixture.dataDir)).toBeUndefined();

    await writePidFile(fixture, pid, socketPath);
    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(0);
    expect(await readPidRecord(fixture.dataDir)).toBeUndefined();
  },
  TEST_TIMEOUT_MS,
);

test(
  "stop refuses a live pid that does not answer and keeps the record",
  async () => {
    const fixture = await makeFixture();
    await writePidFile(fixture, process.pid, join(fixture.dataDir, "run", "missing.sock"));
    const pidFile = join(fixture.dataDir, "daemon.pid");
    const before = await readFile(pidFile, "utf8");

    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("daemon.unknown_owner");
    expect(await readFile(pidFile, "utf8")).toBe(before);
    expect(isAlive(process.pid)).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

test(
  "start reclaims a malformed pid file",
  async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(fixture.dataDir, "daemon.pid"), "{not a pid record\n");

    const started = await run(command(fixture, ["start"]));
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("running");

    const record = await readPidRecord(fixture.dataDir);
    expect(record?.pid).toBeGreaterThan(0);
    observedPids.add(record?.pid ?? 0);
    expect(await probeDaemon(socketPathFor(fixture.dataDir))).toBe(true);

    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(0);
    expect(await readPidRecord(fixture.dataDir)).toBeUndefined();
    expect(await daemonProcesses(fixture.dataDir)).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "concurrent starts elect exactly one daemon",
  async () => {
    const fixture = await makeFixture();
    const socketPath = socketPathFor(fixture.dataDir);
    const args = command(fixture, ["start"]);

    const first = cli(args);
    const second = cli(args);
    const results = await Promise.all([first.done, second.done]);
    const codes = results.map((result) => result.code).sort((a, b) => a - b);
    expect(codes).toEqual([0, 1]);

    const winner = results.find((result) => result.code === 0);
    expect(winner?.stdout).toContain("running");

    const record = await readPidRecord(fixture.dataDir);
    expect(record).toBeDefined();
    observedPids.add(record?.pid ?? 0);
    expect(isAlive(record?.pid ?? 0)).toBe(true);
    expect(await probeDaemon(socketPath)).toBe(true);

    const status = await run(command(fixture, ["status", "--json"]));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: "running" });

    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(0);
    expect(await readPidRecord(fixture.dataDir)).toBeUndefined();
    await waitForProbe(socketPath, false);
    expect(await daemonProcesses(fixture.dataDir)).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

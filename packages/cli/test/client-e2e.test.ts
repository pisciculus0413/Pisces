import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/**
 * Real-socket acceptance for `pisces client list|start`.
 *
 * The daemon is started by the built CLI itself (`pisces start`), so the
 * extension directories it discovers come from the production `--config`
 * wiring, and the launched client is a genuine grandchild process.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const BUILT = existsSync(MAIN);
const KEY_ENV = "PISCES_CLIENTS_E2E_KEY";
const KEY_VALUE = "sk-test-not-real";
const CLI_TIMEOUT_MS = 60_000;
const MARKER_TIMEOUT_MS = 5_000;

const roots: string[] = [];
const children = new Set<ChildProcess>();
const pids = new Set<number>();

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
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ESRCH: already gone.
    }
  }
  pids.clear();
});

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
  marker: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-clients-e2e-"));
  roots.push(root);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const packageRoot = join(root, "extensions", "demo");
  await mkdir(packageRoot, { recursive: true });
  const marker = join(packageRoot, "seen.json");
  await writeFile(
    join(packageRoot, "client.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@demo/x",
      pisces: { clients: [{ id: "demo", entry: "./client.mjs" }] },
    }),
    "utf8",
  );
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      providers: [
        {
          id: "local-only",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: KEY_ENV,
          models: [{ id: "unused", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
    "utf8",
  );
  return { root, dataDir, configPath, marker };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
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

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      reject(new Error(`pisces ${args.join(" ")} did not exit\n${stdout}${stderr}`));
    }, CLI_TIMEOUT_MS - 5_000);
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
}

const command = (fixture: Fixture, args: string[]): string[] => [
  ...args,
  "--config",
  fixture.configPath,
  "--data-dir",
  fixture.dataDir,
];

async function waitForMarker(path: string): Promise<Record<string, string>> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    } catch {
      if (Date.now() > deadline) throw new Error("client marker was never written");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

test.skipIf(!BUILT)(
  "the built CLI lists and starts a client on a daemon it started",
  { timeout: CLI_TIMEOUT_MS },
  async () => {
    const fixture = await makeFixture();

    const started = await run(command(fixture, ["start"]));

    try {
      expect(started.code).toBe(0);
      const listed = await run(command(fixture, ["client", "list"]));
      expect(listed.code).toBe(0);
      expect(listed.stdout.trim()).toBe("demo  @demo/x");

      const json = await run(command(fixture, ["client", "list", "--json"]));
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.stdout) as { clients: { id: string; source: string }[] };
      expect(parsed.clients.map((client) => [client.id, client.source])).toEqual([
        ["demo", "@demo/x"],
      ]);

      const launch = await run(command(fixture, ["client", "start", "demo"]));
      expect(launch.code).toBe(0);
      expect(launch.stdout.trim()).toMatch(/^started demo \(pid [1-9][0-9]*\)$/);
      const pid = Number(/pid (\d+)/.exec(launch.stdout)?.[1]);
      if (Number.isInteger(pid)) pids.add(pid);

      const seen = await waitForMarker(fixture.marker);
      const { PATH: _path, ...rest } = seen;
      expect(rest).toEqual({
        PISCES_SOCKET_PATH: join(fixture.dataDir, "run", "pisces.sock"),
        PISCES_CLIENT_ID: "demo",
      });

      const missing = await run(command(fixture, ["client", "start", "absent"]));
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("client.not_found");
    } finally {
      await run(command(fixture, ["stop"]));
    }
  },
);

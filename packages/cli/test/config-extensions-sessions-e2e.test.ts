import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { connectClient } from "../src/client.js";
import { readPidRecord, socketPathFor } from "../src/lifecycle.js";

/**
 * Real-process acceptance for the config, extensions and sessions commands.
 *
 * The built CLI edits real config files, starts a real detached daemon and
 * talks to it over the real Unix socket. Extension fixtures are ordinary
 * directories whose tool entry writes a sentinel if it is ever imported, so
 * the listing proves no extension code ran.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const BUILT = existsSync(MAIN);
const KEY_ENV = "PISCES_TEST_KEY";
const KEY_VALUE = "sk-test-not-real";
const TEST_TIMEOUT_MS = 60_000;
const CLI_WAIT_MS = 30_000;
const PERSIST_WAIT_MS = 5_000;

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
    const record = await readPidRecord(join(root, "data"));
    if (record !== undefined) observedPids.add(record.pid);
    await rm(root, { recursive: true, force: true });
  }
  for (const pid of observedPids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ESRCH: already gone.
    }
  }
  observedPids.clear();
});

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
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

// The top-level side effect would fire on import; it must never exist after a listing.
function toolSource(sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export default async function run() {",
    '  return { content: [{ type: "text", text: "ran" }] };',
    "}",
    "",
  ].join("\n");
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
  configDir: string;
  workspace: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-cfg-e2e-"));
  roots.push(root);
  return {
    root,
    dataDir: join(root, "data"),
    configPath: join(root, "config", "config.json"),
    configDir: join(root, "config"),
    workspace: join(root, "workspace"),
  };
}

const command = (fixture: Fixture, args: string[]): string[] => [
  ...args,
  "--config",
  fixture.configPath,
  "--data-dir",
  fixture.dataDir,
];

function providersValue(): string {
  return JSON.stringify([
    {
      id: "fake",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: KEY_ENV,
      models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
    },
  ]);
}

async function persistedCount(socketPath: string): Promise<number> {
  const client = await connectClient(socketPath);
  try {
    const result = (await client.request("session.list", {})) as {
      sessions: unknown[];
    };
    return result.sessions.length;
  } finally {
    client.close();
  }
}

test.skipIf(!BUILT)(
  "config set prepares a mixed file that starts, then defaults removal makes session.create model_required",
  async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.workspace);

    // Start from a missing file: `config set` is the only writer.
    const setDataDir = await run([
      "config",
      "set",
      "dataDir",
      JSON.stringify(fixture.dataDir),
      "--config",
      fixture.configPath,
    ]);
    expect(setDataDir.stderr).toBe("");
    expect(setDataDir.code).toBe(0);

    const setProviders = await run([
      "config",
      "set",
      "providers",
      providersValue(),
      "--config",
      fixture.configPath,
    ]);
    expect(setProviders.stderr).toBe("");
    expect(setProviders.code).toBe(0);

    const setDefaults = await run([
      "config",
      "set",
      "defaults",
      '{"provider":"fake","model":"m"}',
      "--config",
      fixture.configPath,
    ]);
    expect(setDefaults.code).toBe(0);
    // Extension keys are accepted by `config` in the same global file.
    expect(
      (
        await run([
          "config",
          "set",
          "defaultWorkspace",
          JSON.stringify(fixture.workspace),
          "--config",
          fixture.configPath,
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          "config",
          "set",
          "extensions",
          '["@pisces/builtin-shell#shell"]',
          "--config",
          fixture.configPath,
        ])
      ).code,
    ).toBe(0);

    const getProvider = await run([
      "config",
      "get",
      "defaults.provider",
      "--config",
      fixture.configPath,
    ]);
    expect(getProvider.code).toBe(0);
    expect(getProvider.stdout.trim()).toBe("fake");

    const getArrayPath = await run([
      "config",
      "get",
      "providers.0.models.0.maxOutput",
      "--config",
      fixture.configPath,
    ]);
    expect(getArrayPath.code).toBe(0);
    expect(getArrayPath.stdout.trim()).toBe("100");

    const listed = await run(["config", "list", "--json", "--config", fixture.configPath]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({
      dataDir: fixture.dataDir,
      providers: [
        {
          id: "fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: KEY_ENV,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
      defaults: { provider: "fake", model: "m" },
      defaultWorkspace: fixture.workspace,
      extensions: ["@pisces/builtin-shell#shell"],
    });
    expect((await stat(fixture.configPath)).mode & 0o777).toBe(0o600);

    const started = await run(command(fixture, ["start"]));
    expect(started.stderr).toBe("");
    expect(started.code).toBe(0);
    expect(started.stdout).toContain("running");
    const record = await readPidRecord(fixture.dataDir);
    expect(record).toBeDefined();
    observedPids.add(record?.pid ?? 0);

    const status = await run(command(fixture, ["status"]));
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("running");

    const socketPath = socketPathFor(fixture.dataDir);
    const client = await connectClient(socketPath);
    let sessionId: string;
    let createdAt: string;
    try {
      const created = (await client.request("session.create", {
        workspace: fixture.workspace,
      })) as {
        id: string;
        provider: string;
        model: string;
        workspace: string;
        createdAt: string;
      };
      expect(created).toMatchObject({
        provider: "fake",
        model: "m",
        workspace: fixture.workspace,
      });
      sessionId = created.id;
      createdAt = created.createdAt;

      // A temporary session is not persisted and therefore not listed.
      const empty = await run(command(fixture, ["sessions", "list"]));
      expect(empty.code).toBe(0);
      expect(empty.stdout).toBe("");
      expect(empty.stderr).toBe("");
      const emptyJson = await run(command(fixture, ["sessions", "list", "--json"]));
      expect(emptyJson.code).toBe(0);
      expect(JSON.parse(emptyJson.stdout)).toEqual({ sessions: [] });

      await client.request("queue.enqueue", {
        sessionId,
        entries: [
          {
            kind: "agent",
            role: "user",
            source: "test",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      });
      await client.request("turn.start", { sessionId });
    } finally {
      client.close();
    }

    const deadline = Date.now() + PERSIST_WAIT_MS;
    while ((await persistedCount(socketPath)) === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the session to persist");
      await delay(50);
    }

    const listedSessions = await run(command(fixture, ["sessions", "list"]));
    expect(listedSessions.code).toBe(0);
    expect(listedSessions.stdout.trim()).toBe(
      `${sessionId} fake/m ${fixture.workspace} ${createdAt}`,
    );

    const jsonSessions = await run(command(fixture, ["sessions", "list", "--json"]));
    expect(jsonSessions.code).toBe(0);
    expect(JSON.parse(jsonSessions.stdout)).toEqual({
      sessions: [
        {
          id: sessionId,
          provider: "fake",
          model: "m",
          workspace: fixture.workspace,
          createdAt,
          schemaVersion: 1,
        },
      ],
    });

    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(0);

    const unset = await run(["config", "unset", "defaults", "--config", fixture.configPath]);
    expect(unset.code).toBe(0);
    const missing = await run(["config", "get", "defaults", "--config", fixture.configPath]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("config.key_not_found");

    const restarted = await run(command(fixture, ["start"]));
    expect(restarted.code).toBe(0);
    expect(restarted.stdout).toContain("running");
    const secondRecord = await readPidRecord(fixture.dataDir);
    observedPids.add(secondRecord?.pid ?? 0);
    const restartedStatus = await run(command(fixture, ["status"]));
    expect(restartedStatus.code).toBe(0);

    const noDefaults = await connectClient(socketPath);
    try {
      await expect(
        noDefaults.request("session.create", { workspace: fixture.workspace }),
      ).rejects.toMatchObject({ code: "session.model_required" });
    } finally {
      noDefaults.close();
    }

    const finalStop = await run(command(fixture, ["stop"]));
    expect(finalStop.code).toBe(0);

    const unreachable = await run(command(fixture, ["sessions", "list"]));
    expect(unreachable.code).toBe(1);
    expect(unreachable.stdout).toBe("");
    expect(unreachable.stderr).toContain("daemon.unreachable");
  },
  TEST_TIMEOUT_MS,
);

test.skipIf(!BUILT)(
  "extensions list reports builtin, config and workspace origins without loading code",
  async () => {
    const fixture = await makeFixture();
    const sentinel = join(fixture.root, "sentinel.txt");
    await mkdir(fixture.workspace);
    await writeJson(fixture.configPath, {});
    await writeJson(join(fixture.configDir, "extensions", "cfg", "package.json"), {
      name: "config-pkg",
    });
    await writeText(
      join(fixture.configDir, "extensions", "cfg", "tools", "c.ts"),
      toolSource(sentinel),
    );
    await writeJson(join(fixture.workspace, ".pisces", "extensions", "ws", "package.json"), {
      name: "workspace-pkg",
    });
    await writeText(
      join(fixture.workspace, ".pisces", "extensions", "ws", "skills", "helper", "SKILL.md"),
      "Skill body\n",
    );

    const listed = await run([
      "extensions",
      "list",
      "--config",
      fixture.configPath,
      "--workspace",
      fixture.workspace,
    ]);
    expect(listed.stderr).toBe("");
    expect(listed.code).toBe(0);
    const rows = listed.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(/ +/).slice(0, 3));
    expect(rows).toContainEqual(["@pisces/builtin-shell#shell", "tool", "builtin"]);
    expect(rows).toContainEqual(["config-pkg#c", "tool", "config"]);
    expect(rows).toContainEqual(["workspace-pkg#helper", "skill", "workspace"]);
    expect(await exists(sentinel)).toBe(false);

    const json = await run([
      "extensions",
      "list",
      "--json",
      "--config",
      fixture.configPath,
      "--workspace",
      fixture.workspace,
    ]);
    expect(json.code).toBe(0);
    const entries = (JSON.parse(json.stdout) as { entries: { name: string; origin: string }[] })
      .entries;
    expect(entries.map((entry) => [entry.name, entry.origin])).toEqual(
      expect.arrayContaining([
        ["@pisces/builtin-shell#shell", "builtin"],
        ["config-pkg#c", "config"],
        ["workspace-pkg#helper", "workspace"],
      ]),
    );
    expect(await exists(sentinel)).toBe(false);

    const badConfig = join(fixture.configDir, "config.json");
    await writeJson(badConfig, { entryConfig: { "missing#wrapper": { timeoutMs: 1 } } });
    const bad = await run([
      "extensions",
      "list",
      "--config",
      badConfig,
      "--workspace",
      fixture.workspace,
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toBe("error: config.invalid: Invalid extension configuration\n");
    expect(await exists(sentinel)).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

test.skipIf(!BUILT)(
  "config --scope workspace writes the workspace layer and rejects CLI keys",
  async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.workspace);
    await writeJson(fixture.configPath, {
      dataDir: fixture.dataDir,
      providers: [
        {
          id: "fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: KEY_ENV,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    });

    const set = await run([
      "config",
      "set",
      "defaults",
      '{"provider":"fake","model":"m"}',
      "--scope",
      "workspace",
      "--workspace",
      fixture.workspace,
      "--config",
      fixture.configPath,
    ]);
    expect(set.stderr).toBe("");
    expect(set.code).toBe(0);

    const workspacePath = join(fixture.workspace, ".pisces", "config.json");
    expect((await stat(workspacePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(workspacePath, "utf8"))).toEqual({
      defaults: { provider: "fake", model: "m" },
    });

    const get = await run([
      "config",
      "get",
      "defaults.model",
      "--scope",
      "workspace",
      "--workspace",
      fixture.workspace,
      "--config",
      fixture.configPath,
    ]);
    expect(get.code).toBe(0);
    expect(get.stdout.trim()).toBe("m");

    const rejected = await run([
      "config",
      "set",
      "dataDir",
      JSON.stringify(fixture.dataDir),
      "--scope",
      "workspace",
      "--workspace",
      fixture.workspace,
      "--config",
      fixture.configPath,
    ]);
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("config.unknown_key");

    const noWorkspace = await run([
      "config",
      "list",
      "--scope",
      "workspace",
      "--workspace",
      join(fixture.root, "missing"),
      "--config",
      fixture.configPath,
    ]);
    expect(noWorkspace.code).toBe(2);
    expect(noWorkspace.stderr).toContain("config.no_workspace");
  },
  TEST_TIMEOUT_MS,
);

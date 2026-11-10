import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderManagement, type ProviderManagement } from "@pisces/core";
import {
  type DaemonHost,
  type ProviderHost,
  type ProviderListResult,
  startDaemon,
} from "@pisces/daemon";
import { afterEach, expect, test } from "vitest";
import { connectClient } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { readPidRecord } from "../src/lifecycle.js";
import { modelsList, providerList } from "../src/providers.js";

/**
 * Real-socket acceptance for `provider list` and `models list`.
 *
 * The first two tests drive the CLI functions against a genuine in-process
 * daemon (native transport, real Unix socket, real `provider.list` route) whose
 * provider registry holds two providers: `alpha` with two models and `beta`
 * with an empty model list. The third test runs the built CLI as a subprocess
 * against a detached daemon it started itself.
 *
 * The config file the CLI reads declares only `local-only`: every listed
 * provider therefore proves the daemon is the source, not the local config.
 * `baseUrl` points at a closed port; no network is needed because no command
 * starts a turn.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const BUILT = existsSync(MAIN);
const KEY_ENV = "PISCES_TEST_KEY";
const KEY_VALUE = "sk-test-not-real";
const SOCKET_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 60_000;

/** What `provider.list` must answer for the registered alpha/beta pair. */
const EXPECTED_PROVIDERS: ProviderListResult = {
  providers: [
    {
      id: "alpha",
      ready: true,
      models: [
        { id: "one", contextWindow: 8000, maxOutput: 1000, modalities: ["text"] },
        {
          id: "two",
          contextWindow: 16000,
          maxOutput: 2000,
          modalities: ["text", "image"],
          pricing: { input: 1.5, output: 2.5, currency: "USD" },
        },
      ],
    },
    { id: "beta", ready: false, models: [] },
  ],
};

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const children = new Set<ChildProcess>();
const observedPids = new Set<number>();

afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
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

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-providers-e2e-"));
  roots.push(root);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
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
  return { root, dataDir, configPath };
}

function acceptanceProviders(): ProviderManagement {
  const providers = createProviderManagement();
  providers.registerProvider({
    id: "alpha",
    dialect: "openai-chat",
    baseUrl: "https://alpha.test/v1",
    auth: { type: "apiKey", credentialRef: "alpha" },
    models: [
      { id: "one", contextWindow: 8000, maxOutput: 1000, modalities: ["text"] },
      {
        id: "two",
        contextWindow: 16000,
        maxOutput: 2000,
        modalities: ["text", "image"],
        pricing: { input: 1.5, output: 2.5, currency: "USD" },
      },
    ],
  });
  providers.registerProvider({
    id: "beta",
    dialect: "openai-chat",
    baseUrl: "https://beta.test/v1",
    auth: { type: "apiKey", credentialRef: "beta" },
    models: [],
  });
  return providers;
}

/** Deterministic readiness: no credentials are read in this acceptance. */
function acceptanceProviderHost(): ProviderHost {
  return {
    execute() {
      return () => {
        throw new Error("provider execution is not part of this acceptance");
      };
    },
    async ready(providerId) {
      return providerId === "alpha";
    },
  };
}

async function startAcceptanceDaemon(fixture: Fixture): Promise<DaemonHost> {
  const host = await startDaemon({
    dataDir: fixture.dataDir,
    providers: acceptanceProviders(),
    providerHost: acceptanceProviderHost(),
  });
  hosts.push(host);
  return host;
}

async function daemonProviderList(socketPath: string): Promise<ProviderListResult> {
  const client = await connectClient(socketPath);
  try {
    return (await client.request("provider.list", {})) as ProviderListResult;
  } finally {
    client.close();
  }
}

test("provider list and models list read every provider from the real daemon", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);

  // The wire result is asserted first, so the CLI assertions below cannot pass
  // on a daemon that answered something else.
  const wire = await daemonProviderList(host.socketPath);
  expect(wire).toEqual(EXPECTED_PROVIDERS);

  const human = recorder();
  expect(await providerList({ configPath: fixture.configPath, io: human.io })).toBe(0);
  expect(human.err).toEqual([]);
  // Daemon order; the empty `beta` is listed as unready with zero models.
  expect(human.out).toEqual(["alpha  ready  models=2", "beta  unready  models=0"]);

  const json = recorder();
  expect(await providerList({ configPath: fixture.configPath, io: json.io, json: true })).toBe(0);
  expect(json.err).toEqual([]);
  expect(json.out).toHaveLength(1);
  expect(JSON.parse(json.out[0] ?? "")).toEqual(wire);

  const all = recorder();
  expect(await modelsList({ configPath: fixture.configPath, io: all.io })).toBe(0);
  expect(all.err).toEqual([]);
  // Provider order is lexicographic, each provider keeps the daemon model order.
  expect(all.out).toEqual([
    "alpha/one  context=8000  maxOutput=1000  modalities=text",
    "alpha/two  context=16000  maxOutput=2000  modalities=text,image",
  ]);
  const humanText = all.out.join("\n");
  expect(humanText).not.toContain("pricing");
  expect(humanText).not.toContain("USD");
  expect(humanText).not.toContain("alpha.test");
  expect(humanText).not.toContain("local-only");

  const filtered = recorder();
  expect(
    await modelsList({ configPath: fixture.configPath, io: filtered.io, provider: "alpha" }),
  ).toBe(0);
  expect(filtered.out).toEqual(all.out);

  const empty = recorder();
  expect(await modelsList({ configPath: fixture.configPath, io: empty.io, provider: "beta" })).toBe(
    0,
  );
  expect(empty.err).toEqual([]);
  expect(empty.out).toEqual(["no models"]);

  const missing = recorder();
  expect(
    await modelsList({ configPath: fixture.configPath, io: missing.io, provider: "missing" }),
  ).toBe(1);
  expect(missing.out).toEqual([]);
  expect(missing.err).toEqual(["error: provider.not_found: Unknown provider"]);

  const modelsJson = recorder();
  expect(await modelsList({ configPath: fixture.configPath, io: modelsJson.io, json: true })).toBe(
    0,
  );
  expect(modelsJson.out).toHaveLength(1);
  expect(JSON.parse(modelsJson.out[0] ?? "")).toEqual({
    models: [
      { provider: "alpha", id: "one", contextWindow: 8000, maxOutput: 1000, modalities: ["text"] },
      {
        provider: "alpha",
        id: "two",
        contextWindow: 16000,
        maxOutput: 2000,
        modalities: ["text", "image"],
        pricing: { input: 1.5, output: 2.5, currency: "USD" },
      },
    ],
  });
});

test("both listing commands fail closed once the daemon is gone", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  await host.stop();
  hosts.splice(hosts.indexOf(host), 1);

  for (const run of [
    (io: CommandIo) => providerList({ configPath: fixture.configPath, io }),
    (io: CommandIo) => modelsList({ configPath: fixture.configPath, io }),
  ]) {
    const result = recorder();
    expect(await run(result.io)).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
  }
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

test.skipIf(!BUILT)(
  "the built CLI lists providers and models from a daemon it started",
  { timeout: CLI_TIMEOUT_MS },
  async () => {
    const fixture = await makeFixture();

    const started = await run(command(fixture, ["start"]));
    expect(started.stderr).toBe("");
    expect(started.code).toBe(0);
    const record = await readPidRecord(fixture.dataDir);
    expect(record).toBeDefined();
    observedPids.add(record?.pid ?? 0);

    const providers = await run(command(fixture, ["provider", "list", "--json"]));
    expect(providers.stderr).toBe("");
    expect(providers.code).toBe(0);
    // The configured key is in the child environment, so the one provider is ready.
    expect(JSON.parse(providers.stdout)).toEqual({
      providers: [
        {
          id: "local-only",
          ready: true,
          models: [{ id: "unused", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    });

    const models = await run(command(fixture, ["models", "list", "--json"]));
    expect(models.stderr).toBe("");
    expect(models.code).toBe(0);
    expect(JSON.parse(models.stdout)).toEqual({
      models: [
        {
          provider: "local-only",
          id: "unused",
          contextWindow: 1000,
          maxOutput: 100,
          modalities: ["text"],
        },
      ],
    });

    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(0);

    const unreachable = await run(command(fixture, ["provider", "list"]));
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain("daemon.unreachable");
  },
);

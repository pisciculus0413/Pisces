import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecuteProvider } from "@pisces/core";
import {
  type DaemonHost,
  type ProviderHost,
  type SessionListResult,
  startDaemon,
  type TurnListResult,
} from "@pisces/daemon";
import { afterEach, expect, test } from "vitest";
import { buildDaemonOptions } from "../src/assembly.js";
import { type Client, connectClient } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { type RunOptions, runCommand } from "../src/run.js";

/**
 * Real-socket acceptance for the configured default workspace and
 * `run --workspace`.
 *
 * The daemon is started in-process from exactly the options `pisces start`
 * builds (`buildDaemonOptions`), with a stub provider host so no network is
 * touched. The CLI runs with production dependencies against that socket, so
 * the daemon defaults, the explicit override and the local rejection of a
 * workspace on an existing session are all proven end to end.
 */

const KEY_ENV = "PISCES_DEFAULT_WORKSPACE_TEST_KEY";
const KEY_VALUE = "sk-test-not-real";
const FINAL_TEXT = "world";
const SOCKET_TIMEOUT_MS = 30_000;

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
  first: string;
  second: string;
}

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Streams one text delta and a stop chunk through the openai-chat adapter. */
const STREAM_FRAMES = [
  JSON.stringify({ choices: [{ index: 0, delta: { content: FINAL_TEXT } }] }),
  JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
];

function stubProviderHost(): ProviderHost {
  const execute: ExecuteProvider = async function* () {
    for (const frame of STREAM_FRAMES) yield frame;
  };
  return {
    execute() {
      return execute;
    },
    async ready() {
      return true;
    },
  };
}

const configValue = (fixture: Fixture, defaultWorkspace: string): unknown => ({
  dataDir: fixture.dataDir,
  providers: [
    {
      id: "stub",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: KEY_ENV,
      models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
    },
  ],
  defaults: { provider: "stub", model: "m" },
  defaultWorkspace,
});

async function writeConfig(fixture: Fixture, defaultWorkspace: string): Promise<void> {
  await writeFile(
    fixture.configPath,
    JSON.stringify(configValue(fixture, defaultWorkspace)),
    "utf8",
  );
}

async function makeFixture(): Promise<Fixture> {
  // `realpath` keeps the Unix socket path short and free of symlinked parents.
  const root = await realpath(await mkdtemp(join(tmpdir(), "pisces-default-ws-e2e-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(first);
  await mkdir(second);
  const fixture: Fixture = { root, dataDir, configPath: join(root, "config.json"), first, second };
  await writeConfig(fixture, first);
  return fixture;
}

/** Builds the same options `pisces start` passes, then swaps in the stub provider. */
async function startAcceptanceDaemon(fixture: Fixture): Promise<DaemonHost> {
  const config = await loadConfig(fixture.configPath);
  const options = buildDaemonOptions(config, fixture.dataDir, { [KEY_ENV]: KEY_VALUE });
  const host = await startDaemon({ ...options, providerHost: stubProviderHost() });
  hosts.push(host);
  return host;
}

async function openClient(socketPath: string): Promise<Client> {
  const client = await connectClient(socketPath);
  clients.push(client);
  return client;
}

async function request<T>(
  client: Client,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return (await client.request(method, params)) as T;
}

const sessionList = (client: Client): Promise<SessionListResult> =>
  request<SessionListResult>(client, "session.list", {});

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

function runOptions(fixture: Fixture, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    configPath: fixture.configPath,
    prompt: "hello",
    newSession: false,
    continueSession: false,
    create: false,
    useDefaultSystemPrompt: false,
    enable: [],
    disable: [],
    print: true,
    json: false,
    ...overrides,
  };
}

test("buildDaemonOptions seeds daemon defaults with the configured workspace", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const config = await loadConfig(fixture.configPath);
  const options = buildDaemonOptions(config, fixture.dataDir, { [KEY_ENV]: KEY_VALUE });
  // This is exactly the object `pisces start` passes to `startDaemon`; an
  // implementation that only stored `defaultWorkspace` in the CLI config would
  // leave the daemon without a workspace here.
  expect(options.defaults).toEqual({
    workspace: fixture.first,
    provider: "stub",
    model: "m",
  });
  expect(options.dataDir).toBe(fixture.dataDir);
});

test("run without --workspace uses the configured default and persists it", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  const rec = recorder();

  expect(await runCommand(runOptions(fixture, { io: rec.io }))).toBe(0);
  expect(rec.err).toEqual([]);
  expect(rec.out).toEqual([FINAL_TEXT]);

  const client = await openClient(host.socketPath);
  const sessions = (await sessionList(client)).sessions;
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.workspace).toBe(fixture.first);
});

test("a restarted daemon applies an updated default workspace", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const first = await startAcceptanceDaemon(fixture);
  expect(await runCommand(runOptions(fixture, { io: recorder().io }))).toBe(0);

  await first.stop();
  const index = hosts.indexOf(first);
  if (index !== -1) hosts.splice(index, 1);

  await writeConfig(fixture, fixture.second);
  const restarted = await startAcceptanceDaemon(fixture);
  expect(await runCommand(runOptions(fixture, { io: recorder().io }))).toBe(0);

  const client = await openClient(restarted.socketPath);
  const sessions = (await sessionList(client)).sessions;
  expect(sessions.map((session) => session.workspace).sort()).toEqual(
    [fixture.first, fixture.second].sort(),
  );
});

test("run --workspace overrides the configured default", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  const rec = recorder();

  expect(await runCommand(runOptions(fixture, { io: rec.io, workspace: fixture.second }))).toBe(0);
  expect(rec.err).toEqual([]);
  expect(rec.out).toEqual([FINAL_TEXT]);

  const client = await openClient(host.socketPath);
  const sessions = (await sessionList(client)).sessions;
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.workspace).toBe(fixture.second);
});

test("run --workspace on an existing session fails locally without touching it", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  expect(await runCommand(runOptions(fixture, { io: recorder().io }))).toBe(0);

  const client = await openClient(host.socketPath);
  const sessions = (await sessionList(client)).sessions;
  const existing = sessions[0];
  if (existing === undefined) throw new Error("missing persisted session");

  const rec = recorder();
  expect(
    await runCommand(
      runOptions(fixture, { io: rec.io, sessionId: existing.id, workspace: fixture.second }),
    ),
  ).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual([
    "error: run.workspace_unsupported: Workspace can only be set for a new session",
  ]);

  // No new session, no queued prompt and no turn were produced.
  expect((await sessionList(client)).sessions.map((session) => session.id)).toEqual([existing.id]);
  expect((await request<TurnListResult>(client, "turn.list", {})).turns).toEqual([]);
  expect((await sessionList(client)).sessions[0]?.workspace).toBe(fixture.first);
});

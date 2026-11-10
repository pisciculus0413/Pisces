import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderManagement,
  type ExecuteProvider,
  type LlmAdapter,
  type ProviderManagement,
  type SessionMeta,
} from "@pisces/core";
import {
  type DaemonHost,
  type ProviderHost,
  startDaemon,
  type TurnListResult,
  type TurnStartResult,
} from "@pisces/daemon";
import { afterEach, expect, test, vi } from "vitest";
import { type Client, connectClient } from "../src/client.js";
import { type CommandIo, statusCommand } from "../src/commands.js";

/**
 * Real-socket acceptance for `status` active sessions.
 *
 * A genuine in-process daemon (native transport, real Unix socket) holds a turn
 * open on a blocked provider, so `turn.list` reports an active session. The
 * `status` command runs with production dependencies against that socket; no
 * fake client is involved.
 */

const KEY_ENV = "PISCES_TEST_KEY";
const SOCKET_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 5_000;

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
  workspace: string;
}

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const adapter: LlmAdapter = {
  dialect: "test",
  buildRequest(request) {
    return { path: "/v1/chat/completions", body: JSON.stringify(request) };
  },
  parseChunk() {
    return [
      { type: "content", delta: "ok" },
      { type: "stop", reason: "stop" },
    ];
  },
};

/** Keeps the turn running until the daemon aborts it on stop. */
const blockedExecute: ExecuteProvider = async function* (_request, signal) {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
};

function testProviders(): ProviderManagement {
  const providers = createProviderManagement();
  providers.registerProvider({
    id: "blocked",
    dialect: "test",
    baseUrl: "https://provider.test/v1",
    auth: { type: "apiKey", credentialRef: "test" },
    models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
  });
  providers.registerDialect("test", () => adapter);
  return providers;
}

const testProviderHost: ProviderHost = {
  execute: () => blockedExecute,
  async ready() {
    return true;
  },
};

async function makeFixture(): Promise<Fixture> {
  // `realpath` keeps the Unix socket path short and free of symlinked parents.
  const root = await realpath(await mkdtemp(join(tmpdir(), "pisces-status-e2e-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      providers: [
        {
          id: "cli-unused",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: KEY_ENV,
          models: [{ id: "unused", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
    "utf8",
  );
  return { root, dataDir, configPath, workspace };
}

async function startAcceptanceDaemon(fixture: Fixture): Promise<DaemonHost> {
  const host = await startDaemon({
    dataDir: fixture.dataDir,
    providers: testProviders(),
    providerHost: testProviderHost,
  });
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

/** Creates a session, queues one entry and starts a turn that stays active. */
async function blockedSession(fixture: Fixture, client: Client): Promise<string> {
  const created = await request<SessionMeta>(client, "session.create", {
    workspace: fixture.workspace,
    provider: "blocked",
    model: "m",
  });
  await request(client, "queue.enqueue", {
    sessionId: created.id,
    entries: [
      {
        kind: "agent",
        role: "user",
        source: "test",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  });
  const started = await request<TurnStartResult>(client, "turn.start", { sessionId: created.id });
  await vi.waitFor(
    async () => {
      const turns = await request<TurnListResult>(client, "turn.list", {});
      expect(turns.turns).toContainEqual({
        sessionId: created.id,
        turnId: started.turnId,
        startedAt: expect.any(String),
      });
    },
    { timeout: WAIT_TIMEOUT_MS, interval: 10 },
  );
  return created.id;
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

test("status reports the active session of a real daemon", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  const client = await openClient(host.socketPath);
  const sessionId = await blockedSession(fixture, client);

  const human = recorder();
  const code = await statusCommand({ configPath: fixture.configPath, io: human.io });

  // The in-process daemon has no pid record, so the state is `unmanaged`.
  expect(code).toBe(1);
  expect(human.err).toEqual([]);
  expect(human.out).toHaveLength(2);
  expect(human.out[0]).toBe(`unmanaged (socket ${host.socketPath})`);
  expect(human.out[1]).toBe(`sessions: ${sessionId}`);

  const json = recorder();
  expect(await statusCommand({ configPath: fixture.configPath, json: true, io: json.io })).toBe(1);
  expect(json.err).toEqual([]);
  const parsed = JSON.parse(json.out.join("\n")) as Record<string, unknown>;
  expect(parsed.state).toBe("unmanaged");
  expect(parsed.sessions).toEqual([sessionId]);
});

test("status reports none when the daemon has no active turn", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  await startAcceptanceDaemon(fixture);

  const human = recorder();
  expect(await statusCommand({ configPath: fixture.configPath, io: human.io })).toBe(1);
  expect(human.err).toEqual([]);
  expect(human.out).toEqual([
    `unmanaged (socket ${join(fixture.dataDir, "run", "pisces.sock")})`,
    "sessions: none",
  ]);

  const json = recorder();
  expect(await statusCommand({ configPath: fixture.configPath, json: true, io: json.io })).toBe(1);
  expect(json.err).toEqual([]);
  expect((JSON.parse(json.out.join("\n")) as Record<string, unknown>).sessions).toEqual([]);
});

test("status reports stopped without sessions after the daemon stops", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  const client = await openClient(host.socketPath);
  await blockedSession(fixture, client);

  await host.stop();
  hosts.splice(hosts.indexOf(host), 1);

  const human = recorder();
  expect(await statusCommand({ configPath: fixture.configPath, io: human.io })).toBe(1);
  expect(human.err).toEqual([]);
  expect(human.out).toEqual(["stopped"]);

  const json = recorder();
  expect(await statusCommand({ configPath: fixture.configPath, json: true, io: json.io })).toBe(1);
  expect(json.err).toEqual([]);
  const parsed = JSON.parse(json.out.join("\n")) as Record<string, unknown>;
  expect(parsed.state).toBe("stopped");
  expect("sessions" in parsed).toBe(false);
});

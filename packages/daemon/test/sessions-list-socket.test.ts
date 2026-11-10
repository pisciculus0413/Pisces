import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderManagement,
  type LlmAdapter,
  type ProviderManagement,
  type SessionId,
} from "@pisces/core";
import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
import { parseExtensionConfig } from "../src/extensions/config.js";
import type { GatewayResponse, SessionListResult } from "../src/gateway/protocol.js";
import { type DaemonHost, startDaemon } from "../src/host/daemon-host.js";
import type { ProviderHost } from "../src/provider/provider-host.js";

/**
 * Real-socket acceptance for `session.list` and the unified global config.
 *
 * A genuine daemon (native transport, real Unix socket, real `SessionStore`,
 * configured extension mode) reads one config.json holding both CLI and
 * extension keys. `session.create` resolves its workspace and provider/model
 * from that file, and only a persisted session reaches `session.list`.
 */

const WAIT_TIMEOUT_MS = 5_000;

interface Fixture {
  root: string;
  dataDir: string;
  workspace: string;
  configDir: string;
  builtinDir: string;
}

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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

function testProviders(): ProviderManagement {
  const providers = createProviderManagement();
  providers.registerProvider({
    id: "p",
    dialect: "test",
    baseUrl: "https://provider.test/v1",
    auth: { type: "apiKey", credentialRef: "test" },
    models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
  });
  providers.registerDialect("test", () => adapter);
  return providers;
}

function recordingProviderHost(record: string[]): ProviderHost {
  return {
    execute() {
      return (request) => {
        return (async function* () {
          record.push(request.body);
          yield "frame";
        })();
      };
    },
    async ready() {
      return true;
    },
  };
}

/** One file with the CLI group, the extension group and the shared `defaults` key. */
function unifiedConfig(fixture: Fixture): Record<string, unknown> {
  return {
    dataDir: fixture.dataDir,
    providers: [
      {
        id: "p",
        baseUrl: "https://provider.test/v1",
        apiKeyEnv: "PISCES_TEST_KEY",
        models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
      },
    ],
    defaults: { provider: "p", model: "m" },
    defaultWorkspace: fixture.workspace,
    extensions: [],
    entryConfig: {},
  };
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pisces-sessions-list-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  const configDir = join(root, "config");
  const builtinDir = join(root, "builtin");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace);
  await mkdir(configDir, { recursive: true });
  await mkdir(builtinDir);
  const fixture = { root, dataDir, workspace, configDir, builtinDir };
  await writeFile(
    join(configDir, "config.json"),
    `${JSON.stringify(unifiedConfig(fixture), null, 2)}\n`,
    "utf8",
  );
  return fixture;
}

type WireResponse = GatewayResponse;

let requestSeq = 0;

class Client {
  private buffer = "";
  private readonly waiters = new Map<string, (response: WireResponse) => void>();
  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => {});
  }

  static connect(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const fail = (): void => reject(socket.errored ?? new Error("connection failed"));
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        const client = new Client(socket);
        clients.push(client);
        resolve(client);
      });
      socket.once("error", fail);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as WireResponse;
      const waiter = this.waiters.get(parsed.id);
      if (waiter === undefined) continue;
      this.waiters.delete(parsed.id);
      waiter(parsed);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<WireResponse> {
    const id = `req-${++requestSeq}`;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, resolve);
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error === null || error === undefined) return;
        this.waiters.delete(id);
        reject(error);
      });
    });
  }

  hello(): Promise<WireResponse> {
    return this.request("protocol.hello", { versions: [PROTOCOL_VERSION] });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function ok(
  client: Client,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await client.request(method, params);
  if (response.error) throw new Error(`${method}: ${response.error.code}`);
  return response.result;
}

async function openDaemon(fixture: Fixture, record: string[]): Promise<Client> {
  const host = await startDaemon({
    dataDir: fixture.dataDir,
    providers: testProviders(),
    providerHost: recordingProviderHost(record),
    extensions: { configDir: fixture.configDir, builtinDir: fixture.builtinDir },
  });
  hosts.push(host);
  const client = await Client.connect(host.socketPath);
  const hello = await client.hello();
  expect(hello.result).toMatchObject({ compatible: true });
  return client;
}

const listSessions = async (client: Client): Promise<SessionListResult> =>
  (await ok(client, "session.list", {})) as SessionListResult;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPersisted(client: Client): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while ((await listSessions(client)).sessions.length === 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a persisted session");
    await delay(20);
  }
}

test("one global file with CLI and extension keys drives a real daemon", async () => {
  const fixture = await makeFixture();
  const raw = JSON.parse(await readFile(join(fixture.configDir, "config.json"), "utf8"));
  // The shared extension parser accepts the same file the CLI loader accepts.
  expect(parseExtensionConfig(raw, "global")).toEqual({
    defaults: { provider: "p", model: "m" },
    defaultWorkspace: fixture.workspace,
    extensions: [],
    entryConfig: {},
  });

  const record: string[] = [];
  const client = await openDaemon(fixture, record);

  const created = (await ok(client, "session.create", {})) as {
    id: SessionId;
    provider: string;
    model: string;
    workspace: string;
    createdAt: string;
  };
  // Workspace and defaults came from the extension layer of the mixed file.
  expect(created).toMatchObject({
    provider: "p",
    model: "m",
    workspace: fixture.workspace,
  });

  expect(await listSessions(client)).toEqual({ sessions: [] });

  await ok(client, "queue.enqueue", {
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
  await ok(client, "turn.start", { sessionId: created.id });
  await waitForPersisted(client);

  expect(await listSessions(client)).toEqual({
    sessions: [
      {
        id: created.id,
        provider: "p",
        model: "m",
        workspace: fixture.workspace,
        createdAt: created.createdAt,
        schemaVersion: 1,
      },
    ],
  });
  expect(record).toHaveLength(1);
});

test("temporary sessions stay out of session.list until they are persisted", async () => {
  const fixture = await makeFixture();
  const client = await openDaemon(fixture, []);

  const first = (await ok(client, "session.create", {
    workspace: fixture.workspace,
    provider: "p",
    model: "m",
  })) as { id: SessionId };
  const second = (await ok(client, "session.create", {
    workspace: fixture.workspace,
    provider: "p",
    model: "m",
  })) as { id: SessionId };
  expect(first.id).not.toBe(second.id);

  const empty = await listSessions(client);
  expect(empty).toEqual({ sessions: [] });
  expect(JSON.stringify(empty)).not.toContain(first.id);
  expect(JSON.stringify(empty)).not.toContain(second.id);

  await ok(client, "queue.enqueue", {
    sessionId: second.id,
    entries: [
      {
        kind: "agent",
        role: "user",
        source: "test",
        content: [{ type: "text", text: "persist me" }],
      },
    ],
  });
  await ok(client, "turn.start", { sessionId: second.id });
  await waitForPersisted(client);

  const listed = await listSessions(client);
  expect(listed.sessions.map((session) => session.id)).toEqual([second.id]);
  expect(listed.sessions[0]).toMatchObject({ schemaVersion: 1 });
});

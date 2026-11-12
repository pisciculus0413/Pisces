import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter, ProviderManagement } from "@pisces/core";
import { createProviderManagement } from "@pisces/core";
import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
import type { ClientListResult, GatewayResponse } from "../src/gateway/protocol.js";
import { type DaemonHost, type StartDaemonOptions, startDaemon } from "../src/host/daemon-host.js";
import type { ProviderHost } from "../src/provider/provider-host.js";

/**
 * Real-socket acceptance for the client registry.
 *
 * A genuine daemon starts a genuine child process (`node <entry>`), so the
 * whitelisted environment and the exit-independent lifetime are exercised, not
 * mocked. The child reports its own environment and exits immediately.
 */

const MARKER_TIMEOUT_MS = 5_000;

interface Fixture {
  root: string;
  dataDir: string;
  configDir: string;
  marker: string;
  entry: string;
}

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pisces-clients-socket-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const packageRoot = join(configDir, "extensions", "demo");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(packageRoot, { recursive: true });
  const marker = join(packageRoot, "seen.json");
  const entry = join(packageRoot, "client.mjs");
  const script = [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));`,
    "",
  ].join("\n");
  await writeFile(entry, script, "utf8");
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@demo/x",
      pisces: { clients: [{ id: "demo", entry: "./client.mjs" }] },
    }),
    "utf8",
  );
  return { root, dataDir, configDir, marker, entry };
}

const adapter: LlmAdapter = {
  dialect: "test",
  buildRequest(request) {
    return { path: "/v1/chat/completions", body: JSON.stringify(request) };
  },
  parseChunk() {
    return [];
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

const readyProviderHost: ProviderHost = {
  execute() {
    return async function* () {
      yield "frame";
    };
  },
  async ready() {
    return true;
  },
};

function daemonOptions(fixture: Fixture, withExtensions: boolean): StartDaemonOptions {
  return {
    dataDir: fixture.dataDir,
    providers: testProviders(),
    providerHost: readyProviderHost,
    ...(withExtensions
      ? { extensions: { configDir: fixture.configDir, builtinDir: join(fixture.root, "builtin") } }
      : {}),
  };
}

async function startFixtureDaemon(fixture: Fixture, withExtensions: boolean): Promise<DaemonHost> {
  const host = await startDaemon(daemonOptions(fixture, withExtensions));
  hosts.push(host);
  return host;
}

let requestSeq = 0;

class Client {
  private buffer = "";
  private readonly waiters = new Map<string, (response: GatewayResponse) => void>();
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
      const parsed = JSON.parse(line) as GatewayResponse;
      const waiter = this.waiters.get(parsed.id);
      if (waiter === undefined) continue;
      this.waiters.delete(parsed.id);
      waiter(parsed);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<GatewayResponse> {
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

  async hello(): Promise<GatewayResponse> {
    return this.request("protocol.hello", { versions: [PROTOCOL_VERSION] });
  }

  close(): void {
    this.socket.destroy();
  }
}

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

test("lists and starts a discovered client over the socket", async () => {
  const fixture = await makeFixture();
  const host = await startFixtureDaemon(fixture, true);
  const client = await Client.connect(host.socketPath);
  await client.hello();

  const listed = await client.request("client.list");
  expect(listed.error).toBeUndefined();
  expect((listed.result as unknown as ClientListResult).clients).toEqual([
    { id: "demo", source: "@demo/x", entry: await realpath(fixture.entry) },
  ]);

  const started = await client.request("client.start", { id: "demo" });
  expect(started.error).toBeUndefined();
  const pid = (started.result as unknown as { pid: number }).pid;
  expect(Number.isInteger(pid) && pid > 0).toBe(true);

  const seen = await waitForMarker(fixture.marker);
  const { PATH: _path, ...rest } = seen;
  expect(rest).toEqual({
    PISCES_SOCKET_PATH: host.socketPath,
    PISCES_CLIENT_ID: "demo",
  });
});

test("returns an empty client list without extension sources", async () => {
  const fixture = await makeFixture();
  const host = await startFixtureDaemon(fixture, false);
  const client = await Client.connect(host.socketPath);
  await client.hello();

  const listed = await client.request("client.list");

  expect(listed.result).toEqual({ clients: [] });
});

test("answers client.not_found for an unknown id", async () => {
  const fixture = await makeFixture();
  const host = await startFixtureDaemon(fixture, true);
  const client = await Client.connect(host.socketPath);
  await client.hello();

  const started = await client.request("client.start", { id: "missing" });

  expect(started.error).toEqual({
    code: "client.not_found",
    message: "Client is not registered",
  });
});

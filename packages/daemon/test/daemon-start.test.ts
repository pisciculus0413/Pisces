import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync } from "node:fs";
import { chmod, cp, lstat, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProviderManagement,
  createSessions,
  type EntryName,
  type LlmAdapter,
  type NodeId,
  type ProviderManagement,
  type SessionId,
  type SessionMeta,
  type SessionNodeDraft,
  type TurnId,
} from "@pisces/core";
import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
import { createActiveTurnStore } from "../src/gateway/active-turn.js";
import type { GatewayResponse } from "../src/gateway/protocol.js";
import type { DaemonHost, StartDaemonOptions } from "../src/host/daemon-host.js";
import { acquireDaemonLock, type DaemonLock } from "../src/host/lock.js";
import { prepareRuntimePaths } from "../src/host/runtime-paths.js";
import type { ProviderHost } from "../src/provider/provider-host.js";
import { createSessionStore } from "../src/session-store/session-store.js";
import { sessionStoreIo } from "../src/session-store/session-store-io.js";
import { bindUnixListener } from "../src/transport/peer-credentials.js";

const NOW = "2026-11-08T05:00:00.000Z";
const FIXTURE = fileURLToPath(new URL("./fixtures/host-child.mjs", import.meta.url));
const DIST_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

type HostModule = typeof import("../src/host/daemon-host.js");
const loadHost = (): Promise<HostModule> => import("../src/host/daemon-host.js");

const hosts: DaemonHost[] = [];
const clients: Client[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
const locks: DaemonLock[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const lock of locks.splice(0)) await lock.release().catch(() => {});
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const running = children.splice(0).filter((child) => child.exitCode === null);
  for (const child of running) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempDir = async (prefix = "pisces-host-"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await delay(10);
  }
};

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

function readyProviderHost(overrides: Partial<ProviderHost> = {}): ProviderHost {
  return {
    execute() {
      return async function* () {
        yield "frame";
      };
    },
    async ready() {
      return true;
    },
    ...overrides,
  };
}

function hostOptions(
  dataDir: string,
  overrides: Partial<StartDaemonOptions> = {},
): StartDaemonOptions {
  return {
    dataDir,
    providers: testProviders(),
    providerHost: readyProviderHost(),
    defaults: { provider: "p", model: "m", workspace: dataDir },
    ...overrides,
  };
}

async function openHost(options: StartDaemonOptions): Promise<DaemonHost> {
  const host = await (await loadHost()).startDaemon(options);
  hosts.push(host);
  return host;
}

const draftUser = (text: string): SessionNodeDraft => ({
  kind: "agent",
  role: "user",
  source: "create",
  content: [{ type: "text", text }],
});

const draftAssistantCall = (callId: string): SessionNodeDraft => ({
  kind: "agent",
  role: "assistant",
  source: "assistant",
  content: [{ type: "toolCall", id: callId, name: "pkg#tool" as EntryName, arguments: {} }],
});

async function seedCommittedTurn(dataDir: string, sessionId: SessionId): Promise<void> {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  let generated = 0;
  const sessions = createSessions({
    repository: store,
    newId: () => `seed-${++generated}` as NodeId,
    now: () => NOW,
  });
  const meta: SessionMeta = {
    id: sessionId,
    model: "m",
    provider: "p",
    workspace: dataDir,
    createdAt: NOW,
    schemaVersion: 1,
  };
  const [root] = await sessions.create(meta, [draftUser("root")]);
  if (root === undefined) throw new Error("missing committed root");
  const startOffset = await store.commitOffset(sessionId);
  await sessions.append(sessionId, [draftAssistantCall("call_1")], root.id);
  await createActiveTurnStore({ dataDir }).write(sessionId, {
    turnId: "t-crash" as TurnId,
    startedAt: NOW,
    startOffset,
    startNodeId: root.id,
  });
}

interface ChildSession {
  child: ChildProcess;
  next(): Promise<Record<string, unknown>>;
  stop(): Promise<number | null>;
}

function spawnHostChild(modulePath: string, dataDir: string): ChildSession {
  const child = spawn(process.execPath, [FIXTURE, modulePath, dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const queued: Record<string, unknown>[] = [];
  const waiters: ((line: Record<string, unknown>) => void)[] = [];
  let buffer = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(parsed);
      else waiter(parsed);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return {
    child,
    next() {
      const ready = queued.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`child produced no line; stderr: ${stderr}`));
        }, 15000);
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.once("exit", (code) => resolve(code));
        child.kill("SIGTERM");
      });
    },
  };
}

test("binds only after crash recovery completes, then serves the recovered session", async () => {
  const dataDir = await tempDir();
  const sessionId = "s-crash" as SessionId;
  await seedCommittedTurn(dataDir, sessionId);
  const { socketPath } = await prepareRuntimePaths(dataDir);

  const realReadFile = sessionStoreIo.readFile;
  let enterRecovery!: () => void;
  const recoveryEntered = new Promise<void>((resolve) => {
    enterRecovery = resolve;
  });
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const gatedReadFile = (async (path: unknown) => {
    if (String(path).endsWith("active-turn.json")) {
      enterRecovery();
      await recoveryGate;
    }
    return (realReadFile as (value: unknown) => Promise<Buffer>)(path);
  }) as typeof sessionStoreIo.readFile;

  let starting!: Promise<DaemonHost>;
  sessionStoreIo.readFile = gatedReadFile;
  try {
    starting = (await loadHost()).startDaemon(hostOptions(dataDir));
    await Promise.race([
      recoveryEntered,
      starting.then(() => {
        throw new Error("daemon started before recovery completed");
      }),
    ]);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(Client.connect(socketPath)).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/),
    });
  } finally {
    releaseRecovery();
    sessionStoreIo.readFile = realReadFile;
  }

  const host = await starting;
  hosts.push(host);
  expect(host.initializationIssues).toEqual([]);
  expect(host.recoveryIssues).toEqual([]);
  expect(await createActiveTurnStore({ dataDir }).read(sessionId)).toBeUndefined();

  const client = await Client.connect(host.socketPath);
  await client.hello();
  const read = (await ok(client, "session.read", { sessionId })) as {
    meta: SessionMeta;
    records: { kind: string; role: string; source: string }[];
  };
  expect(read.meta.id).toBe(sessionId);
  expect(read.records.map((node) => `${node.kind}:${node.role}:${node.source}`)).toEqual([
    "agent:user:create",
    "agent:assistant:assistant",
    "agent:tool:recovery",
    "control:cancel:recovery",
  ]);
});

test("serves hello, provider.list and session.create/read over the real socket", async () => {
  const dataDir = await tempDir();
  const host = await openHost(hostOptions(dataDir));
  expect(host.socketPath).toBe(join(dataDir, "run", "pisces.sock"));

  const client = await Client.connect(host.socketPath);
  expect(await client.request("provider.list")).toMatchObject({
    error: { code: "protocol.hello_required" },
  });
  const hello = await client.hello();
  expect(hello.result).toEqual({ version: PROTOCOL_VERSION, compatible: true });

  expect(await ok(client, "provider.list")).toEqual({
    providers: [
      {
        id: "p",
        ready: true,
        models: [
          {
            id: "m",
            contextWindow: 1000,
            maxOutput: 100,
            modalities: ["text"],
          },
        ],
      },
    ],
  });

  const created = (await ok(client, "session.create", {
    provider: "p",
    model: "m",
  })) as SessionMeta;
  expect(created).toMatchObject({
    provider: "p",
    model: "m",
    workspace: dataDir,
    schemaVersion: 1,
  });

  const read = (await ok(client, "session.read", { sessionId: created.id })) as {
    meta: SessionMeta;
    records: unknown[];
    queue: unknown[];
    selection: unknown[];
  };
  expect(read.meta.id).toBe(created.id);
  expect(read.records).toEqual([]);
  expect(read.queue).toEqual([]);
  expect(read.selection).toEqual([]);
});

test("refuses an insecure data directory before creating run state", async () => {
  const dataDir = await tempDir();
  await chmod(dataDir, 0o777);
  await expect((await loadHost()).startDaemon(hostOptions(dataDir))).rejects.toMatchObject({
    code: "daemon.insecure_directory",
  });
  await expect(lstat(join(dataDir, "run"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("keeps a live socket and its lock file when another instance owns the lock", async () => {
  const dataDir = await tempDir();
  const paths = await prepareRuntimePaths(dataDir);
  const lock = await acquireDaemonLock(paths.lockPath);
  locks.push(lock);
  const lockInode = (await lstat(paths.lockPath)).ino;

  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(paths.socketPath, () => resolve());
  });
  const socketInode = (await lstat(paths.socketPath)).ino;

  await expect((await loadHost()).startDaemon(hostOptions(dataDir))).rejects.toMatchObject({
    code: "daemon.lock_busy",
  });

  expect((await lstat(paths.socketPath)).ino).toBe(socketInode);
  expect((await lstat(paths.lockPath)).ino).toBe(lockInode);
  const probe = await Client.connect(paths.socketPath);
  probe.close();
});

test("releases only its own lock after refusing another process's live socket", async () => {
  const dataDir = await tempDir();
  const paths = await prepareRuntimePaths(dataDir);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(paths.socketPath, () => resolve());
  });
  const socketInode = (await lstat(paths.socketPath)).ino;
  const lockInode = (await lstat(paths.lockPath).catch(() => undefined))?.ino;

  await expect((await loadHost()).startDaemon(hostOptions(dataDir))).rejects.toMatchObject({
    code: "daemon.socket_live",
  });

  expect((await lstat(paths.socketPath)).ino).toBe(socketInode);
  const lockStat = await lstat(paths.lockPath);
  expect(lockStat.isFile()).toBe(true);
  if (lockInode !== undefined) expect(lockStat.ino).toBe(lockInode);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
  const host = await openHost(hostOptions(dataDir));
  expect(host.status().state).toBe("running");
  await host.stop();
});

test("reclaims a stale socket left by a crashed listener", async () => {
  const dataDir = await tempDir();
  const paths = await prepareRuntimePaths(dataDir);
  const fd = bindUnixListener(paths.socketPath);
  closeSync(fd);
  const stale = await lstat(paths.socketPath);
  expect(stale.isSocket()).toBe(true);
  expect(stale.uid).toBe(process.geteuid?.());

  const host = await openHost(hostOptions(dataDir));
  const client = await Client.connect(host.socketPath);
  await client.hello();
  expect(await ok(client, "provider.list")).toBeDefined();
  expect((await lstat(host.socketPath)).ino).not.toBe(stale.ino);
});

test("stops a zero-turn host: closes clients, unlinks its socket and frees the lock", async () => {
  const dataDir = await tempDir();
  const host = await openHost(hostOptions(dataDir));
  const client = await Client.connect(host.socketPath);
  await client.hello();
  expect(host.status()).toEqual({ state: "running", activeTurns: 0 });

  await host.stop();

  expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(Client.connect(host.socketPath)).rejects.toMatchObject({
    code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/),
  });

  const restarted = await openHost(hostOptions(dataDir));
  expect(restarted.status()).toEqual({ state: "running", activeTurns: 0 });
  await restarted.stop();
  await expect(lstat(restarted.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("returns stop_incomplete for an active turn, retains the lock, and stops on retry", async () => {
  const dataDir = await tempDir();
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const providerHost = readyProviderHost({
    execute() {
      return async function* () {
        await turnGate;
        yield "frame";
      };
    },
  });
  const host = await openHost(hostOptions(dataDir, { providerHost }));
  const client = await Client.connect(host.socketPath);
  await client.hello();
  const created = (await ok(client, "session.create", {
    provider: "p",
    model: "m",
  })) as SessionMeta;
  const started = (await ok(client, "turn.start", { sessionId: created.id })) as {
    turnId: TurnId;
  };
  expect(started.turnId).toBeDefined();
  await waitFor(() => host.status().activeTurns === 1);

  await expect(host.stop()).rejects.toMatchObject({ code: "daemon.stop_incomplete" });
  expect(host.status().state).toBe("quiescing");
  expect((await lstat(host.socketPath)).isSocket()).toBe(true);
  await expect((await loadHost()).startDaemon(hostOptions(dataDir))).rejects.toMatchObject({
    code: "daemon.lock_busy",
  });

  releaseTurn();
  await waitFor(() => host.status().activeTurns === 0);
  await host.stop();
  expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("drains admitted Gateway work before releasing the lock and socket", async () => {
  const dataDir = await tempDir();
  let enterReady!: () => void;
  const readyEntered = new Promise<void>((resolve) => {
    enterReady = resolve;
  });
  let releaseReady!: () => void;
  const readyGate = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  const providerHost = readyProviderHost({
    async ready() {
      enterReady();
      await readyGate;
      return true;
    },
  });
  const host = await openHost(hostOptions(dataDir, { providerHost }));
  const client = await Client.connect(host.socketPath);
  await client.hello();
  const pending = client.request("provider.list");
  pending.catch(() => {});
  await readyEntered;

  let settled = false;
  const stopping = host.stop();
  stopping.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await delay(50);
  expect(settled).toBe(false);
  expect(host.status().state).toBe("quiescing");
  expect((await lstat(host.socketPath)).isSocket()).toBe(true);

  releaseReady();
  await stopping;
  expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const restarted = await openHost(hostOptions(dataDir));
  expect(restarted.status()).toEqual({ state: "running", activeTurns: 0 });
  await restarted.stop();
});

test("fails closed before binding when the compiled host cannot load its native addon", async () => {
  const dataDir = await tempDir();
  const copyRoot = join(PACKAGE_ROOT, "test", `.tmp-native-missing-${process.pid}-${randomUUID()}`);
  dirs.push(copyRoot);
  await cp(join(PACKAGE_ROOT, "dist"), join(copyRoot, "dist"), { recursive: true });
  await expect(lstat(join(copyRoot, "native"))).rejects.toMatchObject({ code: "ENOENT" });

  const child = spawnHostChild(join(copyRoot, "dist", "index.js"), dataDir);
  const message = await child.next();
  expect(message).toMatchObject({ event: "error", code: "daemon.native_unavailable" });
  await new Promise<void>((resolve) => child.child.once("exit", () => resolve()));

  const paths = await prepareRuntimePaths(dataDir);
  await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const lock = await acquireDaemonLock(paths.lockPath);
  await lock.release();
  expect((await lstat(paths.lockPath)).isFile()).toBe(true);
});

test("two processes racing for one data directory produce exactly one daemon", async () => {
  const dataDir = await tempDir();
  const first = spawnHostChild(DIST_ENTRY, dataDir);
  const second = spawnHostChild(DIST_ENTRY, dataDir);
  const results = [await first.next(), await second.next()];

  const winners = results.filter((result) => result.event === "ready");
  const losers = results.filter((result) => result.event === "error");
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]).toMatchObject({ code: "daemon.lock_busy" });

  const winner = results[0]?.event === "ready" ? first : second;
  const socketPath = (results.find((result) => result.event === "ready") as { socketPath: string })
    .socketPath;
  const client = await Client.connect(socketPath);
  expect((await client.hello()).result).toMatchObject({ compatible: true });
  expect(await ok(client, "provider.list")).toBeDefined();
  client.close();

  await winner.stop();
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

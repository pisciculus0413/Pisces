import { lstat, mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderManagement,
  createSessions,
  type ExecuteProvider,
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
import {
  type DaemonHost,
  type DaemonHostSeams,
  type StartDaemonOptions,
  startDaemonWithSeams,
} from "../src/host/daemon-host.js";
import { daemonLockFs } from "../src/host/lock.js";
import type { ProviderHost } from "../src/provider/provider-host.js";
import { createSessionStore } from "../src/session-store/session-store.js";
import { sessionStoreIo } from "../src/session-store/session-store-io.js";

const NOW = "2026-11-08T05:00:00.000Z";

const hosts: DaemonHost[] = [];
const clients: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pisces-stop-"));
  dirs.push(dir);
  return dir;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await delay(10);
  }
};

interface Gate {
  entered: Promise<void>;
  promise: Promise<void>;
  enter(): void;
  open(): void;
}

function gate(): Gate {
  let enter!: () => void;
  let open!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { entered, promise, enter, open };
}

type WireResponse = GatewayResponse;

let requestSeq = 0;

class Client {
  private buffer = "";
  private readonly waiters = new Map<string, (response: WireResponse) => void>();
  private readonly eventFrames: string[] = [];
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
      const parsed = JSON.parse(line) as WireResponse & { event?: unknown };
      if (typeof parsed.event === "string") {
        this.eventFrames.push(parsed.event);
        continue;
      }
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

  events(): readonly string[] {
    return this.eventFrames;
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

const adapter: LlmAdapter = {
  dialect: "test",
  buildRequest() {
    return { path: "/v1/chat/completions", body: JSON.stringify({}) };
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

async function openHost(
  dataDir: string,
  overrides: Partial<StartDaemonOptions> = {},
  seams: DaemonHostSeams = {},
): Promise<DaemonHost> {
  const host = await startDaemonWithSeams(hostOptions(dataDir, overrides), seams);
  hosts.push(host);
  return host;
}

interface AbortableDriver {
  execute: ExecuteProvider;
  /** Resolves once the provider execute is actually iterating. */
  started: Promise<void>;
  observed: boolean[];
  release(): void;
}

/**
 * Block a turn until its AbortSignal fires or the test releases it. The release
 * latch exists so a failing stop attempt can never leave the daemon listening
 * past the test's `finally`; a successful stop does not need it.
 */
function abortableDriver(): AbortableDriver {
  const observed: boolean[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    observed,
    started,
    release,
    execute: async function* (_request, signal) {
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const done = (): void => resolve();
        signal?.addEventListener("abort", done, { once: true });
        void released.then(done);
      });
      observed.push(signal?.aborted === true);
      if (signal?.aborted === true) return;
      yield "frame";
    },
  };
}

const draftUser = (text: string): SessionNodeDraft => ({
  kind: "agent",
  role: "user",
  source: "create",
  content: [{ type: "text", text }],
});

function sessionMeta(dataDir: string, sessionId: SessionId): SessionMeta {
  return {
    id: sessionId,
    model: "m",
    provider: "p",
    workspace: dataDir,
    createdAt: NOW,
    schemaVersion: 1,
  };
}

async function seedPersistedSession(dataDir: string, sessionId: SessionId): Promise<void> {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  const sessions = createSessions({
    repository: store,
    newId: () => "root-node" as NodeId,
    now: () => NOW,
  });
  await sessions.create(sessionMeta(dataDir, sessionId), [draftUser("root")]);
}

async function expectLockHeld(dataDir: string): Promise<void> {
  await expect(startDaemonWithSeams(hostOptions(dataDir), {})).rejects.toMatchObject({
    code: "daemon.lock_busy",
  });
}

test("cancels a turn.start queued behind the session lock before the cancel snapshot", async () => {
  const dataDir = await tempDir();
  const sessionId = "s-queued" as SessionId;
  await seedPersistedSession(dataDir, sessionId);
  const driver = abortableDriver();
  const host = await openHost(
    dataDir,
    { providerHost: readyProviderHost({ execute: () => driver.execute }) },
    { stopDeadlines: { pendingDrainMs: 2000, cancelAllMs: 2000 } },
  );

  // Hold the session lock from a real admitted request so the later turn.start
  // can only register after the lock holder settles. Store meta is cached by
  // startup recovery, so the gate sits on the persisted meta rewrite instead.
  const metaGate = gate();
  const metaTemp = join(dataDir, "sessions", sessionId, "meta.json.tmp");
  const realWriteSynced = sessionStoreIo.writeSynced;
  sessionStoreIo.writeSynced = async (path, bytes) => {
    if (String(path) === metaTemp) {
      metaGate.enter();
      await metaGate.promise;
    }
    return realWriteSynced(path, bytes);
  };

  const client = await Client.connect(host.socketPath);
  await client.hello();
  let stopping: Promise<void> | undefined;
  try {
    const configure = client.request("session.configure", { sessionId, model: "m", provider: "p" });
    configure.catch(() => {});
    await metaGate.entered;

    const starting = client.request("turn.start", { sessionId });
    starting.catch(() => {});
    await delay(50);
    expect(host.status().activeTurns).toBe(0);

    stopping = host.stop();
    let settled = false;
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

    // The queued turn.register happens while stop is still draining admitted
    // requests, i.e. before cancelAll takes its snapshot.
    metaGate.open();
    await stopping;

    expect(driver.observed.every((aborted) => aborted)).toBe(true);
    expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
    expect(await createActiveTurnStore({ dataDir }).read(sessionId)).toBeUndefined();
    await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    const restarted = await openHost(dataDir);
    await restarted.stop();
  } finally {
    metaGate.open();
    sessionStoreIo.writeSynced = realWriteSynced;
    await stopping?.catch(() => {});
    driver.release();
    await waitFor(() => host.status().activeTurns === 0).catch(() => {});
    await host.stop().catch(() => {});
  }
}, 20000);

test("retains the lock and reports incomplete while a driver ignores abort, then stops on retry", async () => {
  const dataDir = await tempDir();
  const sessionId = "s-ignore-abort" as SessionId;
  await seedPersistedSession(dataDir, sessionId);
  const driverGate = gate();
  let turnSignal: AbortSignal | undefined;
  const providerHost = readyProviderHost({
    execute() {
      return async function* (_request, signal) {
        turnSignal = signal;
        await driverGate.promise;
        yield "frame";
      };
    },
  });
  const host = await openHost(
    dataDir,
    { providerHost },
    {
      stopDeadlines: { pendingDrainMs: 200, cancelAllMs: 100 },
    },
  );
  const client = await Client.connect(host.socketPath);
  await client.hello();
  const started = (await ok(client, "turn.start", { sessionId })) as { turnId: TurnId };
  expect(started.turnId).toBeDefined();
  await waitFor(() => host.status().activeTurns === 1);
  await waitFor(() => turnSignal !== undefined);
  const inode = (await lstat(host.socketPath)).ino;

  try {
    await expect(host.stop()).rejects.toMatchObject({ code: "daemon.stop_incomplete" });
    // Cancellation was actually delivered; the driver simply refused to finish.
    expect(turnSignal?.aborted).toBe(true);
    expect(host.status().state).toBe("quiescing");
    expect((await lstat(host.socketPath)).ino).toBe(inode);
    await expectLockHeld(dataDir);

    // A retry while the turn is still live must not report success.
    await expect(host.stop()).rejects.toMatchObject({ code: "daemon.stop_incomplete" });
    expect(host.status().state).toBe("quiescing");
  } finally {
    driverGate.open();
    await waitFor(() => host.status().activeTurns === 0).catch(() => {});
    await host.stop().catch(() => {});
  }

  expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const restarted = await openHost(dataDir);
  await restarted.stop();
});

test("retains marker, lock and socket after cleanup_failed and never reports stopped", async () => {
  const dataDir = await tempDir();
  const sessionId = "s-cleanup-failed" as SessionId;
  await seedPersistedSession(dataDir, sessionId);
  const driver = abortableDriver();
  const markers = createActiveTurnStore({ dataDir });

  const realUnlink = sessionStoreIo.unlink;
  sessionStoreIo.unlink = (async (path: unknown) => {
    if (String(path).endsWith("active-turn.json")) {
      throw Object.assign(new Error("unlink failed"), { code: "EACCES" });
    }
    return (realUnlink as (value: unknown) => Promise<void>)(path);
  }) as typeof sessionStoreIo.unlink;

  const host = await openHost(
    dataDir,
    { providerHost: readyProviderHost({ execute: () => driver.execute }) },
    { stopDeadlines: { pendingDrainMs: 200, cancelAllMs: 200 } },
  );
  const client = await Client.connect(host.socketPath);
  await client.hello();
  await ok(client, "session.subscribe", { sessionId });
  const started = (await ok(client, "turn.start", { sessionId })) as { turnId: TurnId };
  await waitFor(() => host.status().activeTurns === 1);
  await driver.started;
  const inode = (await lstat(host.socketPath)).ino;

  try {
    await expect(host.stop()).rejects.toMatchObject({ code: "daemon.stop_incomplete" });
    // The turn was cancelled but its marker cleanup failed, so it stays registered.
    expect(driver.observed).toEqual([true]);
    // The Gateway is still attached during an incomplete stop: its cleanup event
    // is published to the subscribed client instead of being disposed away.
    await waitFor(() => client.events().includes("turn.cleanup_failed"));
    expect(host.status()).toEqual({ state: "quiescing", activeTurns: 1 });
    expect(await markers.read(sessionId)).toMatchObject({ turnId: started.turnId });
    expect((await lstat(host.socketPath)).ino).toBe(inode);
    await expectLockHeld(dataDir);

    // Retry must not silently turn the retained state into a stopped daemon.
    await expect(host.stop()).rejects.toMatchObject({ code: "daemon.stop_incomplete" });
    expect(host.status().state).toBe("quiescing");
    expect(await markers.read(sessionId)).toMatchObject({ turnId: started.turnId });
  } finally {
    // This state is intentionally unrecoverable in-process: the gateway keeps the
    // cleanup_failed turn registered so the next process can recover its marker.
    sessionStoreIo.unlink = realUnlink;
    driver.release();
    await waitFor(() => host.status().activeTurns === 0, 300).catch(() => {});
    await host.stop().catch(() => {});
  }
}, 15000);

test("removes the active-turn marker before releasing the lock", async () => {
  const dataDir = await tempDir();
  const sessionId = "s-marker-order" as SessionId;
  await seedPersistedSession(dataDir, sessionId);
  const driver = abortableDriver();
  const markers = createActiveTurnStore({ dataDir });
  const host = await openHost(
    dataDir,
    { providerHost: readyProviderHost({ execute: () => driver.execute }) },
    { stopDeadlines: { pendingDrainMs: 2000, cancelAllMs: 2000 } },
  );
  const client = await Client.connect(host.socketPath);
  await client.hello();
  await ok(client, "turn.start", { sessionId });
  await waitFor(() => host.status().activeTurns === 1);
  await driver.started;
  expect(await markers.read(sessionId)).toBeDefined();

  const realClose = daemonLockFs.close;
  const markersAtRelease: (Awaited<ReturnType<typeof markers.read>> | "read-failed")[] = [];
  daemonLockFs.close = async (handle) => {
    markersAtRelease.push(await markers.read(sessionId).catch(() => "read-failed" as const));
    await realClose(handle);
  };

  try {
    await host.stop();
    // When the lock is released, the turn's marker must already be gone.
    expect(markersAtRelease).toEqual([undefined]);
    expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
    expect(driver.observed).toEqual([true]);
  } finally {
    daemonLockFs.close = realClose;
    driver.release();
    await waitFor(() => host.status().activeTurns === 0).catch(() => {});
    await host.stop().catch(() => {});
  }

  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const restarted = await openHost(dataDir);
  await restarted.stop();
});

test("times out an in-flight hung request without unlocking or unlinking", async () => {
  const dataDir = await tempDir();
  const readyGate = gate();
  let readyCalls = 0;
  const providerHost = readyProviderHost({
    async ready() {
      readyCalls += 1;
      readyGate.enter();
      await readyGate.promise;
      return true;
    },
  });
  const host = await openHost(
    dataDir,
    { providerHost },
    {
      stopDeadlines: { pendingDrainMs: 150, cancelAllMs: 150 },
    },
  );
  const client = await Client.connect(host.socketPath);
  await client.hello();
  const hung = client.request("provider.list");
  hung.catch(() => {});
  await readyGate.entered;
  const inode = (await lstat(host.socketPath)).ino;

  try {
    const startedAt = Date.now();
    await expect(host.stop()).rejects.toMatchObject({ code: "daemon.stop_incomplete" });
    const elapsed = Date.now() - startedAt;
    // The injected pending deadline was honored instead of the public 5 s one.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1500);
    expect(host.status()).toEqual({ state: "quiescing", activeTurns: 0 });
    expect((await lstat(host.socketPath)).ino).toBe(inode);
    await expectLockHeld(dataDir);

    // Retry while the request still hangs also fails closed.
    await expect(host.stop()).rejects.toMatchObject({ code: "daemon.stop_incomplete" });
    expect(host.status().state).toBe("quiescing");
  } finally {
    readyGate.open();
    // A broken stop can close the client while the request is still hung, so the
    // request promise may never settle; bound the wait instead of hanging.
    await Promise.race([hung.catch(() => {}), delay(1000)]);
    await host.stop().catch(() => {});
  }

  expect(readyCalls).toBe(1);
  expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const restarted = await openHost(dataDir);
  await restarted.stop();
}, 20000);

test("does not cancel on unsubscribe or disconnect, but stop cancels the detached turn", async () => {
  const dataDir = await tempDir();
  const sessionId = "s-disconnect" as SessionId;
  await seedPersistedSession(dataDir, sessionId);
  const driver = abortableDriver();
  const markers = createActiveTurnStore({ dataDir });
  const host = await openHost(
    dataDir,
    { providerHost: readyProviderHost({ execute: () => driver.execute }) },
    { stopDeadlines: { pendingDrainMs: 500, cancelAllMs: 1000 } },
  );
  const client = await Client.connect(host.socketPath);
  await client.hello();
  await ok(client, "session.subscribe", { sessionId });
  await ok(client, "turn.start", { sessionId });
  await waitFor(() => host.status().activeTurns === 1);
  await driver.started;
  expect(await markers.read(sessionId)).toBeDefined();

  try {
    await ok(client, "session.unsubscribe", { sessionId });
    expect(host.status().activeTurns).toBe(1);
    expect(driver.observed).toEqual([]);

    client.close();
    await delay(50);
    expect(host.status().activeTurns).toBe(1);
    expect(driver.observed).toEqual([]);

    await host.stop();
    expect(driver.observed).toEqual([true]);
    expect(await markers.read(sessionId)).toBeUndefined();
    expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  } finally {
    driver.release();
    await waitFor(() => host.status().activeTurns === 0).catch(() => {});
    await host.stop().catch(() => {});
  }

  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const restarted = await openHost(dataDir);
  await restarted.stop();
});

test("rejects frames that arrive after stop begins (quiesced before drain)", async () => {
  const dataDir = await tempDir();
  const readyGate = gate();
  let readyCalls = 0;
  const providerHost = readyProviderHost({
    async ready() {
      readyCalls += 1;
      readyGate.enter();
      await readyGate.promise;
      return true;
    },
  });
  const host = await openHost(
    dataDir,
    { providerHost },
    {
      stopDeadlines: { pendingDrainMs: 2000, cancelAllMs: 2000 },
    },
  );
  const client = await Client.connect(host.socketPath);
  await client.hello();
  const first = client.request("provider.list");
  first.catch(() => {});
  await readyGate.entered;

  let stopping: Promise<void> | undefined;
  try {
    stopping = host.stop();
    await delay(20);
    expect(host.status().state).toBe("quiescing");

    const late = client.request("provider.list");
    late.catch(() => {});
    await delay(50);
    // The late frame was rejected before admission, so it never reached the provider.
    expect(readyCalls).toBe(1);

    readyGate.open();
    await stopping;
    expect(readyCalls).toBe(1);
    expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
    await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    readyGate.open();
    await stopping?.catch(() => {});
    await host.stop().catch(() => {});
  }
}, 20000);

test("repeated successful stop is a no-op", async () => {
  const dataDir = await tempDir();
  const host = await openHost(dataDir);
  const client = await Client.connect(host.socketPath);
  await client.hello();

  const realClose = daemonLockFs.close;
  let closes = 0;
  daemonLockFs.close = async (handle) => {
    closes += 1;
    await realClose(handle);
  };
  try {
    await host.stop();
    expect(closes).toBe(1);
    expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
    await host.stop();
    await host.stop();
    // A repeated stop is a no-op: it must not release the lock again.
    expect(closes).toBe(1);
    expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  } finally {
    daemonLockFs.close = realClose;
  }
  await expect(lstat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });

  const restarted = await openHost(dataDir);
  expect(restarted.status()).toEqual({ state: "running", activeTurns: 0 });
  await restarted.stop();
  await expect(lstat(restarted.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});

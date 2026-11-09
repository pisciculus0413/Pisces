import { type ChildProcess, spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProviderManagement,
  createTools,
  type EntryName,
  type LlmAdapter,
  type ProviderManagement,
  type SessionMeta,
} from "@pisces/core";
import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import { defaultBuiltinDir } from "../src/extensions/discovery.js";
import { createExtensions } from "../src/extensions/extensions.js";
import type { ExtensionBinding, Extensions, ExtensionsOptions } from "../src/extensions/types.js";
import type {
  EntriesSnapshotResult,
  GatewayResponse,
  SessionReadResult,
} from "../src/gateway/protocol.js";
import type { DaemonHost, StartDaemonOptions } from "../src/host/daemon-host.js";
import { startDaemon } from "../src/host/daemon-host.js";
import { acquireDaemonLock } from "../src/host/lock.js";
import { prepareRuntimePaths } from "../src/host/runtime-paths.js";
import type {
  ExtensionBinding as PublicExtensionBinding,
  Extensions as PublicExtensions,
  ExtensionsOptions as PublicExtensionsOptions,
  StartDaemonOptions as PublicStartDaemonOptions,
} from "../src/index.js";
import type { ProviderHost } from "../src/provider/provider-host.js";
import { makePackage, toolSource, writeJson, writeText } from "./extensions-fixtures.js";

const RUN = "demo#run" as EntryName;
// The repo ships one built-in extension; these tests use the module-derived builtin dir.
const SHELL = "@pisces/builtin-shell#shell" as EntryName;
/** Inner bounds shorter than the default 5 s test timeout: a stuck helper reports itself. */
const WAIT_TIMEOUT_MS = 4000;
const CHILD_TIMEOUT_MS = 4000;
const FIXTURE = fileURLToPath(new URL("./fixtures/extensions-child.mjs", import.meta.url));
const DIST_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const hosts: DaemonHost[] = [];
const clients: Client[] = [];
const children: ChildHost[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  // Bounded child cleanup: kill+reap before deleting any fixture directory or socket.
  for (const child of children.splice(0)) await child.kill();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempDir = async (prefix = "pisces-ext-host-"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  condition: () => Promise<boolean>,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await delay(25);
  }
};

async function workspaceDir(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeWorkspaceConfig(workspace: string, value: unknown): Promise<void> {
  await writeJson(join(workspace, ".pisces", "config.json"), value);
}

/** Workspace package with one real TS tool whose module import writes the sentinel. */
async function addTool(workspace: string, sentinel: string): Promise<EntryName> {
  await makePackage(join(workspace, ".pisces", "extensions", "demo"), {
    name: "demo",
    files: {
      "tools/run.ts": toolSource(sentinel),
      "tools/run.ts.meta.json": JSON.stringify({ description: "runs a tool" }),
    },
  });
  return RUN;
}

const contentAdapter: LlmAdapter = {
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

/** One tool-calling step, then a plain completion: proves the frozen binding runs the tool. */
function toolCallingAdapter(tool: EntryName): LlmAdapter {
  let step = 0;
  return {
    dialect: "test",
    buildRequest(request) {
      return { path: "/v1/chat/completions", body: JSON.stringify(request) };
    },
    parseChunk() {
      step += 1;
      if (step === 1)
        return [
          { type: "toolCall", call: { id: "call_1", name: tool, arguments: {} } },
          { type: "stop", reason: "toolCall" },
        ];
      return [
        { type: "content", delta: "done" },
        { type: "stop", reason: "stop" },
      ];
    },
  };
}

function testProviders(adapter: LlmAdapter = contentAdapter): ProviderManagement {
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

function readyProviderHost(): ProviderHost {
  return {
    execute() {
      return async function* () {
        yield "frame";
      };
    },
    async ready() {
      return true;
    },
  };
}

function baseOptions(dataDir: string, extra: Partial<StartDaemonOptions> = {}): StartDaemonOptions {
  return {
    dataDir,
    providers: testProviders(),
    providerHost: readyProviderHost(),
    ...extra,
  };
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

interface ChildHost {
  child: ChildProcess;
  next(): Promise<Record<string, unknown>>;
  stop(): Promise<number | null>;
  kill(): Promise<void>;
}

function spawnChildHost(args: string[]): ChildHost {
  const child = spawn(process.execPath, [FIXTURE, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
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

  const waitExit = (timeoutMs = CHILD_TIMEOUT_MS): Promise<number | null> => {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", done);
        reject(new Error(`child did not exit; stderr: ${stderr}`));
      }, timeoutMs);
      const done = (code: number | null): void => {
        clearTimeout(timer);
        resolve(code);
      };
      child.once("exit", done);
    });
  };

  const handle: ChildHost = {
    child,
    next() {
      const ready = queued.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`child produced no line; stderr: ${stderr}`));
        }, CHILD_TIMEOUT_MS);
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      child.stdin?.write(`${JSON.stringify({ command: "stop" })}\n`);
      try {
        return await waitExit();
      } catch {
        return null;
      }
    },
    async kill() {
      if (child.exitCode !== null) return;
      child.kill("SIGKILL");
      await waitExit().catch(() => {});
    },
  };
  children.push(handle);
  return handle;
}

const openClient = (path: string): Promise<Client> => Client.connect(path);

const snapshot = async (client: Client, sessionId: string): Promise<EntriesSnapshotResult> =>
  (await ok(client, "entries.snapshot", { sessionId })) as EntriesSnapshotResult;

const readSession = async (client: Client, sessionId: string): Promise<SessionReadResult> =>
  (await ok(client, "session.read", { sessionId })) as SessionReadResult;

const toolResultText = (read: SessionReadResult): string | undefined => {
  const node = read.records.find((record) => record.role === "tool");
  const block = node?.content.find((item) => item.type === "toolResult");
  if (block === undefined || block.type !== "toolResult") return undefined;
  const text = block.content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : undefined;
};

async function waitForToolResult(client: Client, sessionId: string): Promise<SessionReadResult> {
  let latest: SessionReadResult | undefined;
  await waitFor(async () => {
    latest = await readSession(client, sessionId);
    return toolResultText(latest) !== undefined;
  });
  if (latest === undefined) throw new Error("session was never read");
  return latest;
}

// Compile-time contract only (`tsc -p tsconfig.json`), not behavioural coverage: the public
// startup option is the directory configuration, never the Gateway's `extensions` service.
type PublicOption = NonNullable<PublicStartDaemonOptions["extensions"]>;
type ServiceIsNotStartupOptions = Extensions extends ExtensionsOptions ? never : true;
type PublicServiceMatches = PublicExtensions extends Extensions
  ? Extensions extends PublicExtensions
    ? true
    : false
  : false;

test("public extension types: directory config in, service type out (type-level assertions)", () => {
  expectTypeOf<PublicOption>().toEqualTypeOf<PublicExtensionsOptions>();
  expectTypeOf<ServiceIsNotStartupOptions>().toEqualTypeOf<true>();
  expectTypeOf<PublicServiceMatches>().toEqualTypeOf<true>();
  expectTypeOf<PublicExtensionBinding>().toEqualTypeOf<ExtensionBinding>();
});

test("public host rejects mixed extension composition before listening", async () => {
  const mixed: [string, Partial<StartDaemonOptions>][] = [
    ["defaults", { defaults: { provider: "p", model: "m", workspace: "/" } }],
    ["createTools", { createTools: () => createTools() }],
    ["entries", { entries: { kind: () => undefined } }],
    ["skills", { skills: { selected: () => [] } }],
    ["sources", { sources: { get: () => undefined } }],
  ];
  for (const [label, extra] of mixed) {
    const root = await tempDir(`pisces-ext-mixed-${label}-`);
    const dataDir = join(root, "data");
    const configDir = join(root, "config");
    await mkdir(configDir, { recursive: true });
    const paths = await prepareRuntimePaths(dataDir);

    await expect(
      startDaemon(baseOptions(dataDir, { ...extra, extensions: { configDir } })),
    ).rejects.toMatchObject({ code: "daemon.start_failed" });

    // No listener was bound and the failed-start cleanup released the single-instance lock.
    await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    const lock = await acquireDaemonLock(paths.lockPath);
    await lock.release();
  }
});

test("serves a configured extension session, runs its TS tool, then stops cleanly", {
  timeout: 20000,
}, async () => {
  const root = await tempDir();
  const workspace = await workspaceDir(root, "ws");
  const sentinel = join(root, "tool.log");
  await addTool(workspace, sentinel);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN],
  });
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const dataDir = join(root, "data");

  const host = await startDaemon(
    baseOptions(dataDir, {
      providers: testProviders(toolCallingAdapter(RUN)),
      extensions: { configDir },
    }),
  );
  hosts.push(host);
  const client = await openClient(host.socketPath);
  expect((await client.hello()).result).toMatchObject({ compatible: true });

  const meta = (await ok(client, "session.create", {
    workspace,
    systemPrompt: ["use the tool"],
  })) as SessionMeta;
  const initial = await snapshot(client, meta.id);
  expect(initial.entries.map((entry) => entry.name)).toEqual([SHELL, RUN]);
  expect(initial.selection).toEqual([]);
  // Discovery never imported the module: the sentinel is written by the tool module itself.
  expect(await exists(sentinel)).toBe(false);

  await ok(client, "turn.start", { sessionId: meta.id });
  const read = await waitForToolResult(client, meta.id);
  expect(toolResultText(read)).toBe("ran");
  expect(await exists(sentinel)).toBe(true);
  expect((await snapshot(client, meta.id)).selection).toEqual([RUN]);

  const paths = await prepareRuntimePaths(dataDir);
  await host.stop();
  expect(host.status()).toEqual({ state: "stopped", activeTurns: 0 });
  await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const lock = await acquireDaemonLock(paths.lockPath);
  await lock.release();

  // Same data directory restarts in configured mode: no new startup bypass.
  const restarted = await startDaemon(
    baseOptions(dataDir, {
      providers: testProviders(toolCallingAdapter(RUN)),
      extensions: { configDir },
    }),
  );
  hosts.push(restarted);
  const restartedClient = await openClient(restarted.socketPath);
  expect((await restartedClient.hello()).result).toMatchObject({ compatible: true });
  // The restarted host still composes extensions: a fresh session is created and snapshotted
  // through the same public routes instead of reporting a stopped or bypassed startup.
  const restartedMeta = (await ok(restartedClient, "session.create", {
    workspace,
    systemPrompt: ["restarted"],
  })) as SessionMeta;
  const restartedSnapshot = await snapshot(restartedClient, restartedMeta.id);
  expect(restartedSnapshot.entries.map((entry) => entry.name)).toEqual([SHELL, RUN]);
  expect(restartedSnapshot.selection).toEqual([]);
  await restarted.stop();
});

test("keeps the legacy manual startup when no extensions option is provided", async () => {
  const root = await tempDir();
  const workspace = await workspaceDir(root, "legacy-ws");
  const dataDir = join(root, "data");
  const host = await startDaemon(
    baseOptions(dataDir, { defaults: { provider: "p", model: "m", workspace } }),
  );
  hosts.push(host);
  const client = await openClient(host.socketPath);
  expect((await client.hello()).result).toMatchObject({ compatible: true });

  const meta = (await ok(client, "session.create", { workspace })) as SessionMeta;
  expect(await snapshot(client, meta.id)).toEqual({ entries: [], selection: [], effective: [] });
  // The legacy path still refuses manual extension names instead of composing a binding.
  const rejected = await client.request("session.create", { workspace, extensions: [RUN] });
  expect(rejected.error).toMatchObject({ code: "queue.invalid_control" });

  await host.stop();
});

test("resolves the default builtin directory from the module URL, not the working directory", async () => {
  const root = await tempDir();
  const workspace = await workspaceDir(root, "cwd-ws");
  const sentinel = join(root, "cwd-tool.log");
  await addTool(workspace, sentinel);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN],
  });
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  // Decoy builtin tree at the candidate cwd location: a cwd-derived implementation discovers it.
  const elsewhere = await workspaceDir(root, "elsewhere");
  const decoySentinel = join(root, "decoy-tool.log");
  await makePackage(join(elsewhere, "extensions", "builtin", "decoy"), {
    name: "decoy",
    files: { "tools/x.ts": toolSource(decoySentinel) },
  });
  expect(await exists(join(elsewhere, "extensions", "builtin", "decoy", "tools", "x.ts"))).toBe(
    true,
  );
  const original = process.cwd();
  const before = defaultBuiltinDir();
  let host: DaemonHost | undefined;
  try {
    process.chdir(elsewhere);
    const after = defaultBuiltinDir();
    expect(isAbsolute(after)).toBe(true);
    expect(after).toBe(before);
    expect(resolve(after)).toBe(join(REPO_ROOT, "extensions", "builtin"));
    // Not inferred from the process working directory.
    expect(relative(elsewhere, after).startsWith("..")).toBe(true);

    host = await startDaemon(baseOptions(join(root, "data"), { extensions: { configDir } }));
    hosts.push(host);
    const client = await openClient(host.socketPath);
    expect((await client.hello()).result).toMatchObject({ compatible: true });
    const meta = (await ok(client, "session.create", { workspace })) as SessionMeta;
    const discovered = (await snapshot(client, meta.id)).entries.map((entry) => entry.name);
    // The decoy tree under the working directory is not the module-derived builtin directory.
    expect(discovered).toEqual([SHELL, RUN]);
    expect(discovered).not.toContain("decoy#x");
    expect(await exists(decoySentinel)).toBe(false);
  } finally {
    process.chdir(original);
    await host?.stop().catch(() => {});
  }
});

test("fails on an unsupported platform before extension config, native probe or listening", async () => {
  const root = await tempDir();
  const dataDir = join(root, "data");
  const child = spawnChildHost([
    DIST_ENTRY,
    dataDir,
    join(root, "config"),
    join(root, "ws"),
    RUN,
    "platform",
  ]);
  const message = await child.next();
  expect(message).toMatchObject({ event: "error", code: "daemon.unsupported_platform" });
  expect(await child.stop()).toBe(1);

  const paths = await prepareRuntimePaths(dataDir);
  await expect(lstat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a bounded dist child serves an extension session over a real socket and runs one TS tool", {
  timeout: 20000,
}, async () => {
  const root = await tempDir();
  const workspace = await workspaceDir(root, "dist-ws");
  const sentinel = join(root, "dist-tool.log");
  await addTool(workspace, sentinel);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN],
  });
  // A genuinely invalid package: an unparseable package.json yields `extensions.invalid`
  // during discovery and must not block the daemon or the healthy workspace package.
  await writeText(
    join(workspace, ".pisces", "extensions", "broken", "package.json"),
    "{ not valid json\n",
  );
  await writeJson(join(workspace, ".pisces", "extensions", "broken", "tools", "bad.ts.meta.json"), {
    description: "broken",
  });
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const dataDir = join(root, "data");

  // Same directories the child uses: the issue is real, not assumed by the fixture shape.
  const probed = await createExtensions({ configDir }).prepare(workspace);
  expect(probed.issues).toContainEqual({
    code: "extensions.invalid",
    source: "broken",
  });
  expect(probed.inventory.entries.map((entry) => entry.name)).toEqual([SHELL, RUN]);

  const child = spawnChildHost([DIST_ENTRY, dataDir, configDir, workspace, RUN]);
  const ready = await child.next();
  expect(ready).toMatchObject({ event: "ready" });
  const socketPath = ready.socketPath as string;
  expect(typeof socketPath).toBe("string");
  expect(ready.initializationIssues).toBe(0);

  const client = await openClient(socketPath);
  expect((await client.hello()).result).toMatchObject({ compatible: true });
  const meta = (await ok(client, "session.create", {
    workspace,
    systemPrompt: ["use the tool"],
  })) as SessionMeta;
  const initial = await snapshot(client, meta.id);
  expect(initial.entries.map((entry) => entry.name)).toEqual([SHELL, RUN]);
  expect(await exists(sentinel)).toBe(false);

  await ok(client, "turn.start", { sessionId: meta.id });
  const read = await waitForToolResult(client, meta.id);
  expect(toolResultText(read)).toBe("ran");
  expect(await exists(sentinel)).toBe(true);
  expect((await snapshot(client, meta.id)).selection).toEqual([RUN]);
  client.close();

  // Ordered teardown: stop the child, reap it, then the fixture directory is removed by afterEach.
  expect(await child.stop()).toBe(0);
  await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const paths = await prepareRuntimePaths(dataDir);
  const lock = await acquireDaemonLock(paths.lockPath);
  await lock.release();
});

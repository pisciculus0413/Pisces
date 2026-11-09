import { type ChildProcess, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ContentBlock,
  createProviderManagement,
  type DefinitionSnapshot,
  type EntryName,
  type LlmAdapter,
  type ProviderManagement,
  type QueueEntry,
  type SessionMeta,
} from "@pisces/core";
import { PROTOCOL_VERSION, type ProtocolEvent } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
import { createExtensions } from "../src/extensions/extensions.js";
import type { GatewayResponse, SessionReadResult } from "../src/gateway/protocol.js";
import type { DaemonHost, StartDaemonOptions } from "../src/host/daemon-host.js";
import { startDaemon } from "../src/host/daemon-host.js";
import { acquireDaemonLock } from "../src/host/lock.js";
import { prepareRuntimePaths } from "../src/host/runtime-paths.js";
import type { ProviderHost } from "../src/provider/provider-host.js";
import { peerUidFor } from "../src/transport/peer-credentials.js";
import { makePackage, writeJson, writeText } from "./extensions-fixtures.js";

const RUN = "demo#run" as EntryName;
const WRAP = "demo#wrap" as EntryName;
const GUIDE = "demo#guide" as EntryName;
const NOTE = "demo#note" as EntryName;
const EMPTY = "demo#empty" as EntryName;
const GUARD = "hostile#guard" as EntryName;
const SLOWCTX = "slowctx#wait" as EntryName;

const WAIT_TIMEOUT_MS = 4000;
const CROSS_UID_SETUP_TIMEOUT_MS = 5000;
const CROSS_UID_CHILD_TIMEOUT_MS = 8000;
const CROSS_UID_FIXTURE = fileURLToPath(
  new URL("./fixtures/cross-uid-client.mjs", import.meta.url),
);

const hosts: DaemonHost[] = [];
const clients: Client[] = [];
const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  // Kill and reap every spawned child before any temporary directory is removed.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
    });
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const within = async <T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

async function waitFor(
  condition: () => Promise<boolean>,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

interface CapturedRequest {
  model: string;
  messages: { role: string; content: { type: string; text?: string }[] }[];
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
}

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Real host seam: records the exact wire request body and can block the first step. */
function recordingProviderHost(record: CapturedRequest[], firstGate?: Gate): ProviderHost {
  return {
    execute() {
      return (request) => {
        return (async function* () {
          record.push(JSON.parse(request.body) as CapturedRequest);
          if (firstGate !== undefined && record.length === 1) await firstGate.promise;
          yield "frame";
        })();
      };
    },
    async ready() {
      return true;
    },
  };
}

function plainAdapter(): LlmAdapter {
  return {
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
}

/**
 * Calls every named tool once per turn (detected from the request, not a shared counter),
 * then finishes with a text node. Stateless across sessions and steps.
 */
function toolCallingAdapter(names: readonly EntryName[], final = "done"): LlmAdapter {
  let callTools = true;
  return {
    dialect: "test",
    buildRequest(request) {
      callTools = !request.messages.some((message) => message.role === "tool");
      return { path: "/v1/chat/completions", body: JSON.stringify(request) };
    },
    parseChunk() {
      if (callTools) {
        callTools = false;
        return [
          ...names.map((name, index) => ({
            type: "toolCall" as const,
            call: { id: `call_${index + 1}`, name, arguments: {} },
          })),
          { type: "stop" as const, reason: "toolCall" as const },
        ];
      }
      return [
        { type: "content" as const, delta: final },
        { type: "stop" as const, reason: "stop" as const },
      ];
    },
  };
}

interface ClientOptions {
  onClose?: () => void;
}

type WireResponse = GatewayResponse;

let requestSeq = 0;

class Client {
  private buffer = "";
  private readonly waiters = new Map<string, (response: WireResponse) => void>();
  private readonly socket: Socket;
  readonly events: ProtocolEvent[] = [];
  readonly transcript: string[] = [];
  closed = false;

  private constructor(socket: Socket, options: ClientOptions) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      options.onClose?.();
    });
  }

  static connect(path: string, options: ClientOptions = {}): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const fail = (): void => reject(socket.errored ?? new Error("connection failed"));
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        const client = new Client(socket, options);
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
      this.transcript.push(line);
      const parsed = JSON.parse(line) as WireResponse & ProtocolEvent;
      if (typeof parsed.event === "string") {
        this.events.push(parsed as unknown as ProtocolEvent);
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

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

async function ok(
  client: Client,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await client.request(method, params);
  if (response.error)
    throw new Error(`${method}: ${response.error.code}: ${response.error.message}`);
  return response.result;
}

/** Ordered barrier: every frame queued before this response has already been parsed. */
const barrier = (client: Client): Promise<unknown> => ok(client, "provider.list");

const readSession = async (client: Client, sessionId: string): Promise<SessionReadResult> =>
  (await ok(client, "session.read", { sessionId })) as SessionReadResult;

const snapshot = async (client: Client, sessionId: string) =>
  (await ok(client, "entries.snapshot", { sessionId })) as {
    entries: Record<string, unknown>[];
    selection: EntryName[];
    effective: { name: EntryName; definitionHash?: string; configHash?: string; stale: boolean }[];
  };

async function turnIdle(client: Client): Promise<void> {
  await waitFor(async () => {
    const turns = (await ok(client, "turn.list")) as { turns: unknown[] };
    return turns.turns.length === 0;
  }, "the turn to unregister");
}

type ToolResultBlock = Extract<ContentBlock, { type: "toolResult" }>;

const toolResultBlocks = (read: SessionReadResult): ToolResultBlock[] =>
  read.records.flatMap((node) =>
    node.content.filter((block): block is ToolResultBlock => block.type === "toolResult"),
  );

const nodeTexts = (read: SessionReadResult): string[] =>
  read.records.flatMap((node) =>
    node.content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "toolResult")
        return block.content.map((inner) => (inner.type === "text" ? inner.text : "")).join("");
      return "";
    }),
  );

function declarationEntry(queue: QueueEntry[]): QueueEntry {
  const entry = queue.find((candidate) => candidate.role === "declaration");
  if (entry === undefined) throw new Error("no declaration entry");
  return entry;
}

interface DeclarationPayload {
  toggle: EntryName[];
  definitions?: DefinitionSnapshot[];
}

function declarationPayload(entry: QueueEntry): DeclarationPayload {
  const block = entry.content[0];
  if (block === undefined || block.type !== "text") throw new Error("declaration is not text");
  return JSON.parse(block.text) as DeclarationPayload;
}

function toggleInput(toggle: readonly EntryName[]): Record<string, unknown> {
  return {
    kind: "control",
    role: "declaration",
    source: "user",
    content: [{ type: "text", text: JSON.stringify({ toggle }) }],
  };
}

function agentInput(text: string): Record<string, unknown> {
  return { kind: "agent", role: "user", source: "user", content: [{ type: "text", text }] };
}

async function tempRoot(prefix = "pisces-ext-socket-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function workspaceDir(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeWorkspaceConfig(workspace: string, value: unknown): Promise<void> {
  await writeJson(join(workspace, ".pisces", "config.json"), value);
}

interface DemoPaths {
  toolImport: string;
  toolInvocations: string;
  wrapperImport: string;
  wrapperConfig: string;
  noteImport: string;
  noteResolves: string;
  emptyFlag: string;
}

async function installDemo(workspace: string, root: string): Promise<DemoPaths> {
  const paths: DemoPaths = {
    toolImport: join(root, "tool-import.log"),
    toolInvocations: join(root, "tool-invocations.log"),
    wrapperImport: join(root, "wrapper-import.log"),
    wrapperConfig: join(root, "wrapper-config.json"),
    noteImport: join(root, "note-import.log"),
    noteResolves: join(root, "note-resolves.log"),
    emptyFlag: join(root, "empty.flag"),
  };
  await makePackage(join(workspace, ".pisces", "extensions", "demo"), {
    name: "demo",
    files: {
      "tools/run.ts": [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(paths.toolImport)}, "imported");`,
        "export default async function run() {",
        `  appendFileSync(${JSON.stringify(paths.toolInvocations)}, "invoke\\n");`,
        '  return { content: [{ type: "text", text: "ran" }] };',
        "}",
        "",
      ].join("\n"),
      "tools/run.ts.meta.json": JSON.stringify({
        description: "runs a tool",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      }),
      "wrappers/wrap.ts": [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(paths.wrapperImport)}, "imported");`,
        'export const config = { tag: "default", n: 1 };',
        "export default function createWrapper(config) {",
        `  writeFileSync(${JSON.stringify(paths.wrapperConfig)}, JSON.stringify(config));`,
        "  return (tool) => ({",
        "    ...tool,",
        "    execute: async (args, context) => {",
        "      const result = await tool.execute(args, context);",
        "      return {",
        "        ...result,",
        "        content: [",
        "          ...result.content,",
        '          { type: "text", text: "wrapped:" + JSON.stringify(config) },',
        "        ],",
        "      };",
        "    },",
        "  });",
        "}",
        "",
      ].join("\n"),
      "wrappers/wrap.ts.meta.json": JSON.stringify({
        description: "wraps tools",
        config: { defaults: { tag: "default", n: 1 }, schema: { type: "object" } },
      }),
      "skills/guide.meta.json": JSON.stringify({ name: "guide", description: "a guide" }),
      "skills/guide/SKILL.md": "guide body\n",
      "context/note.ts": [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(paths.noteImport)}, "imported");`,
        "export default async function resolve() {",
        `  appendFileSync(${JSON.stringify(paths.noteResolves)}, "resolve\\n");`,
        '  return [{ source: "note", content: [{ type: "text", text: "note body" }] }];',
        "}",
        "",
      ].join("\n"),
      "context/note.ts.meta.json": JSON.stringify({ description: "a note" }),
      "context/empty.ts": [
        'import { existsSync } from "node:fs";',
        "export default async function resolve() {",
        `  if (!existsSync(${JSON.stringify(paths.emptyFlag)})) return [];`,
        '  return [{ source: "empty", content: [{ type: "text", text: "empty body" }] }];',
        "}",
        "",
      ].join("\n"),
      "context/empty.ts.meta.json": JSON.stringify({ description: "an empty note" }),
    },
  });
  return paths;
}

async function installSlowSource(
  workspace: string,
  root: string,
): Promise<{
  started: string;
  completed: string;
}> {
  const started = join(root, "slow-started.log");
  const completed = join(root, "slow-completed.log");
  await makePackage(join(workspace, ".pisces", "extensions", "slowctx"), {
    name: "slowctx",
    files: {
      "context/wait.ts": [
        'import { appendFileSync } from "node:fs";',
        "export default async function resolve() {",
        `  appendFileSync(${JSON.stringify(started)}, "started\\n");`,
        "  await new Promise((resolve) => setTimeout(resolve, 300));",
        `  appendFileSync(${JSON.stringify(completed)}, "done\\n");`,
        '  return [{ source: "wait", content: [{ type: "text", text: "late body" }] }];',
        "}",
        "",
      ].join("\n"),
      "context/wait.ts.meta.json": JSON.stringify({ description: "a slow source" }),
    },
  });
  return { started, completed };
}

async function installHostileWrapper(workspace: string): Promise<void> {
  await makePackage(join(workspace, ".pisces", "extensions", "hostile"), {
    name: "hostile",
    files: {
      "wrappers/guard.ts": [
        'export const config = { tag: "module" };',
        "export default function createWrapper() {",
        "  return (tool) => tool;",
        "}",
        "",
      ].join("\n"),
      "wrappers/guard.ts.meta.json": JSON.stringify({
        description: "guard",
        config: { defaults: { tag: "sidecar" }, schema: { type: "object" } },
      }),
    },
  });
}

async function installWideTool(workspace: string): Promise<void> {
  await makePackage(join(workspace, ".pisces", "extensions", "big"), {
    name: "big",
    files: {
      "tools/wide.ts": "export default async function wide() {\n  return { content: [] };\n}\n",
      "tools/wide.ts.meta.json": JSON.stringify({ description: "é".repeat(2_200_000) }),
    },
  });
}

function testProviders(adapter: LlmAdapter): ProviderManagement {
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

interface DaemonOptions {
  dataDir: string;
  configDir: string;
  adapter?: LlmAdapter;
  record?: CapturedRequest[];
  firstGate?: Gate;
}

function daemonOptions(options: DaemonOptions): StartDaemonOptions {
  return {
    dataDir: options.dataDir,
    providers: testProviders(options.adapter ?? plainAdapter()),
    providerHost: recordingProviderHost(options.record ?? [], options.firstGate),
    extensions: { configDir: options.configDir },
  };
}

interface Opened {
  host: DaemonHost;
  client: Client;
}

async function openDaemon(options: DaemonOptions): Promise<Opened> {
  const host = await startDaemon(daemonOptions(options));
  hosts.push(host);
  const client = await Client.connect(host.socketPath);
  expect((await client.hello()).result).toMatchObject({ compatible: true });
  return { host, client };
}

const createSession = async (
  client: Client,
  params: Record<string, unknown>,
): Promise<SessionMeta> => (await ok(client, "session.create", params)) as SessionMeta;

const startTurn = async (client: Client, sessionId: string): Promise<string> =>
  ((await ok(client, "turn.start", { sessionId })) as { turnId: string; mode: string }).turnId;

test("serves a frozen declaration, snapshot projection and first-invoke tools over a real socket", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  const paths = await installDemo(workspace, root);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN, GUIDE, NOTE],
  });
  const configDir = join(root, "config");
  const record: CapturedRequest[] = [];
  const { client } = await openDaemon({
    dataDir: join(root, "data"),
    configDir,
    adapter: toolCallingAdapter([RUN]),
    record,
  });

  const created = await createSession(client, { workspace, systemPrompt: ["use the tool"] });
  const initialRead = await readSession(client, created.id);
  expect(initialRead.records).toEqual([]);
  expect(initialRead.selection).toEqual([]);
  // Exactly one unconfirmed declaration carries every selected name.
  expect(initialRead.queue).toHaveLength(2);
  expect(initialRead.queue.map((entry) => entry.role).sort()).toEqual(["declaration", "system"]);
  const declaration = declarationEntry(initialRead.queue);
  expect(declaration.confirmedAt).toBeUndefined();
  const payload = declarationPayload(declaration);
  expect([...payload.toggle].sort()).toEqual([GUIDE, NOTE, RUN].sort());
  const frozenRun = payload.definitions?.find((definition) => definition.name === RUN);
  expect(frozenRun).toMatchObject({ kind: "tool", description: "runs a tool" });
  expect(frozenRun?.definitionHash).toEqual(expect.any(String));

  const initial = await snapshot(client, created.id);
  // Inventory is visible, the queued toggle is not: selection/effective are the persisted branch.
  expect(initial.entries.map((entry) => entry.name).sort()).toEqual(
    [EMPTY, GUIDE, NOTE, RUN, WRAP].sort(),
  );
  expect(initial.selection).toEqual([]);
  expect(initial.effective).toEqual([]);
  const runEntry = initial.entries.find((entry) => entry.name === RUN);
  // EntrySnapshot projection: name/kind/description/parameters/definitionHash (+configHash).
  expect(Object.keys(runEntry ?? {}).sort()).toEqual([
    "definitionHash",
    "description",
    "kind",
    "name",
    "parameters",
  ]);
  expect(runEntry).toMatchObject({
    kind: "tool",
    description: "runs a tool",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    definitionHash: frozenRun?.definitionHash,
  });
  expect(Object.keys(initial.entries.find((entry) => entry.name === WRAP) ?? {}).sort()).toEqual([
    "configHash",
    "definitionHash",
    "description",
    "kind",
    "name",
    "parameters",
  ]);
  expect(Object.keys(initial.entries.find((entry) => entry.name === GUIDE) ?? {}).sort()).toEqual([
    "description",
    "kind",
    "name",
  ]);
  // Discovery, create, snapshot and read never imported any implementation module.
  expect(await exists(paths.toolImport)).toBe(false);
  expect(await exists(paths.wrapperImport)).toBe(false);
  expect(await exists(paths.noteImport)).toBe(false);
  expect(await exists(paths.toolInvocations)).toBe(false);

  await startTurn(client, created.id);
  await turnIdle(client);

  const frozenDeclarations = [
    {
      name: RUN,
      description: frozenRun?.description,
      parameters: frozenRun?.parameters,
    },
  ];
  expect(record[0]?.tools).toEqual(frozenDeclarations);
  // Tool, skill and context behaviour came from the real loader.
  const firstRequest = JSON.stringify(record[0]?.messages);
  expect(firstRequest).toContain("use the tool");
  expect(firstRequest).toContain("guide body");
  expect(firstRequest).toContain("note body");
  expect(await exists(paths.toolImport)).toBe(true);
  expect(await exists(paths.toolInvocations)).toBe(true);
  expect(await exists(paths.noteImport)).toBe(true);
  expect(await exists(paths.wrapperImport)).toBe(false);

  const read = await readSession(client, created.id);
  expect(toolResultBlocks(read)[0]).toMatchObject({
    content: [{ type: "text", text: "ran" }],
  });
  expect(read.records.some((node) => node.role === "declaration")).toBe(true);
  expect(nodeTexts(read)).toContain("done");

  const after = await snapshot(client, created.id);
  expect(after.selection).toEqual([GUIDE, NOTE, RUN].sort());
  expect(after.effective).toEqual([
    { name: GUIDE, stale: false },
    { name: NOTE, stale: false },
    { name: RUN, definitionHash: frozenRun?.definitionHash, stale: false },
  ]);
  expect(after.entries.find((entry) => entry.name === RUN)?.definitionHash).toBe(
    frozenRun?.definitionHash,
  );
  expect((await readSession(client, created.id)).selection).toEqual([GUIDE, NOTE, RUN].sort());
});

test("edits and removes queue entries, locks confirmed ones and isolates subscriptions", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  await installDemo(workspace, root);
  await writeWorkspaceConfig(workspace, { defaultProvider: "p", defaultModel: "m" });
  const configDir = join(root, "config");
  const gateFirst = gate();
  const record: CapturedRequest[] = [];
  const { client } = await openDaemon({
    dataDir: join(root, "data"),
    configDir,
    firstGate: gateFirst,
    record,
  });

  // Two sessions: each connection subscribes to exactly one of them.
  const first = await createSession(client, { workspace, systemPrompt: ["hello"] });
  const second = await createSession(client, { workspace, systemPrompt: ["separate"] });
  const clientB = await Client.connect((await prepareRuntimePaths(join(root, "data"))).socketPath);
  expect((await clientB.hello()).result).toMatchObject({ compatible: true });
  await ok(client, "session.subscribe", { sessionId: first.id });
  await ok(clientB, "session.subscribe", { sessionId: second.id });

  await startTurn(client, first.id);
  // The provider is blocked, so the first turn's queue has been consumed and confirmed.
  await waitFor(async () => record.length === 1, "the first provider request");

  const queued = (await ok(client, "queue.enqueue", {
    sessionId: first.id,
    entries: [agentInput("before")],
  })) as { ids: string[] };
  const queuedId = queued.ids[0] as string;
  await ok(client, "queue.edit", {
    sessionId: first.id,
    id: queuedId,
    content: [{ type: "text", text: "after" }],
  });
  const editedQueue = (await readSession(client, first.id)).queue;
  expect(editedQueue.map((entry) => entry.content)).toEqual([[{ type: "text", text: "after" }]]);

  // Confirm a pending declaration through steer, then it is locked but still removable.
  const declaration = (await ok(client, "queue.enqueue", {
    sessionId: first.id,
    entries: [toggleInput([RUN])],
  })) as { ids: string[] };
  const steered = (await ok(client, "turn.start", { sessionId: first.id })) as { mode: string };
  expect(steered.mode).toBe("steer");
  const confirmedQueue = (await readSession(client, first.id)).queue;
  expect(confirmedQueue.filter((entry) => entry.confirmedAt !== undefined)).toHaveLength(2);
  const locked = await client.request("queue.edit", {
    sessionId: first.id,
    id: declaration.ids[0],
    content: [{ type: "text", text: "x" }],
  });
  expect(locked.error?.code).toBe("queue.entry_locked");
  await ok(client, "queue.remove", { sessionId: first.id, id: declaration.ids[0] });
  expect((await readSession(client, first.id)).queue).toHaveLength(1);

  // The other connection only receives its own session's events.
  await ok(clientB, "queue.enqueue", { sessionId: second.id, entries: [agentInput("b")] });
  await barrier(clientB);
  await barrier(client);
  const firstEvents = client.events.filter((event) => event.event === "queue.updated");
  const secondEvents = clientB.events.filter((event) => event.event === "queue.updated");
  expect(firstEvents.length).toBeGreaterThan(0);
  expect(secondEvents.length).toBeGreaterThan(0);
  expect(
    firstEvents.every((event) => (event.data as { sessionId: string }).sessionId === first.id),
  ).toBe(true);
  expect(
    secondEvents.every((event) => (event.data as { sessionId: string }).sessionId === second.id),
  ).toBe(true);

  // Every queue.updated carries the complete queue and a strictly increasing seq.
  const queueOf = (event: ProtocolEvent) =>
    (event.data as unknown as { queue: QueueEntry[] }).queue;
  const lastEvent = firstEvents.at(-1) as ProtocolEvent;
  expect(queueOf(lastEvent)).toEqual((await readSession(client, first.id)).queue);
  expect(queueOf(lastEvent)[0]?.id).toBe(queuedId);
  const seqs = firstEvents.map((event) => (event.data as { seq: number }).seq);
  expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
  expect(new Set(seqs).size).toBe(seqs.length);

  gateFirst.release();
  await turnIdle(client);
  // The edited text (not the original) entered the next assembled step.
  expect(JSON.stringify(record[1]?.messages)).toContain("after");
  expect(JSON.stringify(record[1]?.messages)).not.toContain("before");
});

test("filters deselected content, reuses reviewed bodies and retries a zero-fragment source", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  const paths = await installDemo(workspace, root);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [NOTE],
  });
  const configDir = join(root, "config");
  const record: CapturedRequest[] = [];
  const { client } = await openDaemon({
    dataDir: join(root, "data"),
    configDir,
    record,
  });

  const created = await createSession(client, { workspace, systemPrompt: ["hello"] });
  await startTurn(client, created.id);
  await turnIdle(client);
  expect(JSON.stringify(record[0]?.messages)).toContain("note body");
  expect(await readFile(paths.noteResolves, "utf8")).toBe("resolve\n");

  // Deselect: the stored body stops entering the request without being deleted.
  await ok(client, "queue.enqueue", {
    sessionId: created.id,
    entries: [toggleInput([NOTE])],
  });
  await startTurn(client, created.id);
  await turnIdle(client);
  expect(JSON.stringify(record[1]?.messages)).not.toContain("note body");
  expect((await snapshot(client, created.id)).selection).toEqual([]);

  // Reselect: the historical node is reused; the source is not resolved again.
  await ok(client, "queue.enqueue", {
    sessionId: created.id,
    entries: [toggleInput([NOTE])],
  });
  await startTurn(client, created.id);
  await turnIdle(client);
  expect(JSON.stringify(record[2]?.messages)).toContain("note body");
  expect(await readFile(paths.noteResolves, "utf8")).toBe("resolve\n");

  // A zero-fragment source alone leaves no visible message: the first request fails safe.
  const second = await createSession(client, {
    workspace,
    extensions: [EMPTY],
  });
  await ok(client, "session.subscribe", { sessionId: second.id });
  const started = await client.request("turn.start", { sessionId: second.id });
  expect(started.error).toBeUndefined();
  await turnIdle(client);
  const failedRead = await readSession(client, second.id);
  expect(failedRead.records).toEqual([]);
  const ended = client.events.find(
    (event) =>
      event.event === "turn.ended" && (event.data as { sessionId: string }).sessionId === second.id,
  );
  expect(ended).toBeDefined();
  await writeText(paths.emptyFlag, "ready\n");
  await startTurn(client, second.id);
  await turnIdle(client);
  const recovered = await readSession(client, second.id);
  expect(recovered.records.some((node) => node.source === EMPTY && node.role === "system")).toBe(
    true,
  );
  expect(nodeTexts(recovered)).toContain("empty body");
  expect(JSON.stringify(record.at(-1)?.messages)).toContain("empty body");
});

test("merges wrapper sidecar defaults with user config and fails mismatches safely", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  const paths = await installDemo(workspace, root);
  await installHostileWrapper(workspace);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN, WRAP],
    entryConfig: { [WRAP]: { tag: "user" } },
  });
  const configDir = join(root, "config");
  const record: CapturedRequest[] = [];
  const { client } = await openDaemon({
    dataDir: join(root, "data"),
    configDir,
    adapter: toolCallingAdapter([RUN], "done"),
    record,
  });

  const created = await createSession(client, { workspace, systemPrompt: ["tool"] });
  expect(await exists(paths.wrapperImport)).toBe(false);
  expect(await exists(paths.wrapperConfig)).toBe(false);
  await startTurn(client, created.id);
  await turnIdle(client);
  // The wrapper module loads only for the first invoke, with the merged configuration.
  expect(await exists(paths.wrapperImport)).toBe(true);
  expect(JSON.parse(await readFile(paths.wrapperConfig, "utf8"))).toEqual({ tag: "user", n: 1 });
  const wrappedText = (toolResultBlocks(await readSession(client, created.id))[0]?.content ?? [])
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
    .join("");
  expect(wrappedText).toContain("ran");
  expect(wrappedText).toContain('wrapped:{"tag":"user","n":1}');

  // A module `config` that disagrees with the sidecar defaults is a safe wrapper failure.
  const hostileRoot = await workspaceDir(root, "hostile-assets");
  const hostile = await workspaceDir(root, "hostile-ws");
  const hostilePaths = await installDemo(hostile, hostileRoot);
  await installHostileWrapper(hostile);
  await writeWorkspaceConfig(hostile, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN, GUARD],
  });
  const before = record.length;
  const broken = await createSession(client, { workspace: hostile, systemPrompt: ["tool"] });
  const response = await client.request("turn.start", { sessionId: broken.id });
  expect(response.error).toBeUndefined();
  await turnIdle(client);
  expect(record.length).toBeGreaterThan(before);
  const result = toolResultBlocks(await readSession(client, broken.id))[0];
  expect(result?.code).toBe("tool.wrapper_invalid");
  expect(result?.isError).toBe(true);
  expect(result?.content).toEqual([{ type: "text", text: `Invalid tool wrapper: ${GUARD}` }]);
  // The wrapped tool never executed and the module message never reached the wire.
  expect(await exists(hostilePaths.toolInvocations)).toBe(false);
  expect(client.transcript.join("\n")).not.toContain("does not match the declared defaults");
});

test("isolates discovery conflicts without blocking the daemon or healthy entries (f)", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  const paths = await installDemo(workspace, root);
  // Two distinct directories claiming the same package#name, plus an unparseable manifest.
  for (const dir of ["dup-a", "dup-b"]) {
    await makePackage(join(workspace, ".pisces", "extensions", dir), {
      name: "dup",
      files: {
        "tools/run.ts": "export default async function run() {\n  return { content: [] };\n}\n",
        "tools/run.ts.meta.json": JSON.stringify({ description: dir }),
      },
    });
  }
  await writeText(join(workspace, ".pisces", "extensions", "broken", "package.json"), "{ nope\n");
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN],
  });
  const configDir = join(root, "config");

  // The same directories the daemon uses: issues are real, not fixture assumptions.
  const probed = await createExtensions({ configDir }).prepare(workspace);
  expect(probed.issues).toContainEqual({
    code: "extensions.duplicate",
    source: "dup#run",
    name: "dup#run",
  });
  expect(probed.issues).toContainEqual({ code: "extensions.invalid", source: "broken" });
  expect(probed.inventory.entries.map((entry) => entry.name)).not.toContain("dup#run");

  const { host, client } = await openDaemon({
    dataDir: join(root, "data"),
    configDir,
    adapter: toolCallingAdapter([RUN]),
  });
  expect(host.status()).toEqual({ state: "running", activeTurns: 0 });
  const created = await createSession(client, { workspace, systemPrompt: ["tool"] });
  const names = (await snapshot(client, created.id)).entries.map((entry) => entry.name);
  expect(names).toContain(RUN);
  expect(names).not.toContain("dup#run");
  await startTurn(client, created.id);
  await turnIdle(client);
  expect(toolResultBlocks(await readSession(client, created.id))[0]?.content).toEqual([
    { type: "text", text: "ran" },
  ]);
  expect(await exists(paths.toolInvocations)).toBe(true);
});

test("keeps a registered turn running after its client disconnects (g)", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  await installDemo(workspace, root);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN],
  });
  const configDir = join(root, "config");
  const gateFirst = gate();
  const record: CapturedRequest[] = [];
  const { client } = await openDaemon({
    dataDir: join(root, "data"),
    configDir,
    adapter: toolCallingAdapter([RUN], "finished"),
    record,
    firstGate: gateFirst,
  });

  let closed = false;
  const ephemeral = await Client.connect(
    (await prepareRuntimePaths(join(root, "data"))).socketPath,
    { onClose: () => (closed = true) },
  );
  expect((await ephemeral.hello()).result).toMatchObject({ compatible: true });
  const created = await createSession(ephemeral, { workspace, systemPrompt: ["tool"] });
  await ok(ephemeral, "session.subscribe", { sessionId: created.id });
  await startTurn(ephemeral, created.id);
  await waitFor(async () => record.length === 1, "the first provider request");

  ephemeral.close();
  await waitFor(async () => closed, "the client socket to close");

  gateFirst.release();
  await turnIdle(client);
  const read = await readSession(client, created.id);
  // The turn ran to completion and persisted its tool result and final node.
  expect(toolResultBlocks(read)[0]?.content).toEqual([{ type: "text", text: "ran" }]);
  expect(nodeTexts(read)).toContain("finished");
  expect(read.records.some((node) => node.role === "assistant")).toBe(true);
});

test("a source resolver that ignores cancellation does not commit the pending batch (h)", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  const slow = await installSlowSource(workspace, root);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
  });
  const configDir = join(root, "config");
  const { client } = await openDaemon({ dataDir: join(root, "data"), configDir });

  // Turn 1 commits a real branch that later cancellation must never roll back.
  const created = await createSession(client, { workspace, systemPrompt: ["hello"] });
  await startTurn(client, created.id);
  await turnIdle(client);
  const before = await readSession(client, created.id);
  const committed = before.records.map((node) => node.id);
  expect(nodeTexts(before)).toContain("ok");

  await ok(client, "session.subscribe", { sessionId: created.id });
  await ok(client, "queue.enqueue", {
    sessionId: created.id,
    entries: [toggleInput([SLOWCTX]), agentInput("second")],
  });
  const turnId = await startTurn(client, created.id);
  await waitFor(async () => exists(slow.started), "the slow source to start");
  const cancelled = (await ok(client, "turn.cancel", { turnId })) as { cancelled: boolean };
  expect(cancelled.cancelled).toBe(true);
  await turnIdle(client);
  // The resolver ignored the abort signal and completed, but the pending batch is not committed.
  expect(await readFile(slow.completed, "utf8")).toBe("done\n");

  const read = await readSession(client, created.id);
  const after = read.records.map((node) => node.id);
  // No committed node is rolled back: turn 1 nodes remain, plus one cancellation record.
  expect(after.slice(0, committed.length)).toEqual(committed);
  expect(after).toHaveLength(committed.length + 1);
  expect(read.records.some((node) => node.source === SLOWCTX)).toBe(false);
  expect(nodeTexts(read)).not.toContain("late body");
  expect(nodeTexts(read)).not.toContain("second");
  const cancel = read.records.at(-1);
  expect(cancel?.role).toBe("cancel");
  const cancelBlock = cancel?.content[0];
  expect(cancelBlock?.type).toBe("text");
  const cancelPayload = JSON.parse(cancelBlock?.type === "text" ? cancelBlock.text : "{}") as {
    turnId: string;
    reason: string;
  };
  expect(cancelPayload).toMatchObject({ turnId, reason: "cancelled" });
  // The appended branch stays linear: every parent is the node itself or another persisted node.
  const ids = new Set(read.records.map((node) => node.id));
  for (const node of read.records)
    expect(node.parentId === node.id || ids.has(node.parentId)).toBe(true);
  // Uncommitted queue entries remain (unconfirmed), so a later turn can retry them.
  expect(read.queue.map((entry) => entry.role)).toEqual(["declaration", "user"]);
  expect(read.queue.every((entry) => entry.confirmedAt === undefined)).toBe(true);
});

test("answers an oversized snapshot with a safe error and keeps the connection usable (i)", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  await installWideTool(workspace);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [],
  });
  const configDir = join(root, "config");
  const { client } = await openDaemon({ dataDir: join(root, "data"), configDir });
  const created = await createSession(client, { workspace });

  const response = await client.request("entries.snapshot", { sessionId: created.id });
  expect(response.error).toEqual({
    code: "protocol.frame_too_large",
    message: "Response exceeds the size limit",
  });
  expect(client.closed).toBe(false);
  // The same connection still serves a small request after the refused response.
  const providers = (await ok(client, "provider.list")) as { providers: { id: string }[] };
  expect(providers.providers.map((provider) => provider.id)).toEqual(["p"]);
  expect((await readSession(client, created.id)).selection).toEqual([]);
});

test("keeps config values, paths, nested causes and source bodies off the wire (j)", {
  timeout: 20000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  const paths = await installDemo(workspace, root);
  const secret = "sk-live-socket-secret-value";
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN, WRAP],
    entryConfig: { [WRAP]: { token: secret } },
  });
  const configDir = join(root, "config");
  const { client } = await openDaemon({ dataDir: join(root, "data"), configDir });
  const created = await createSession(client, { workspace, systemPrompt: ["hello"] });
  await ok(client, "session.subscribe", { sessionId: created.id });
  await ok(client, "queue.enqueue", { sessionId: created.id, entries: [agentInput("visible")] });
  const snapshotBody = JSON.stringify(await snapshot(client, created.id));
  await startTurn(client, created.id);
  await turnIdle(client);

  const wire = [snapshotBody, ...client.transcript, ...client.events.map((e) => JSON.stringify(e))];
  const wsReal = await realpath(workspace);
  const extensionDir = join(wsReal, ".pisces", "extensions");
  for (const frame of wire) {
    expect(frame).not.toContain(secret);
    expect(frame).not.toContain(configDir);
    expect(frame).not.toContain(extensionDir);
    expect(frame).not.toContain("entryConfig");
    expect(frame).not.toContain('"cause"');
    expect(frame).not.toContain("writeFileSync");
    expect(frame).not.toContain(paths.wrapperConfig);
    expect(frame).not.toContain(paths.noteResolves);
  }
  // The snapshot inventory carries hashes only; the workspace itself is legitimate SessionMeta.
  expect(snapshotBody).not.toContain(wsReal);
  expect(snapshotBody).not.toContain(secret);
  // The wrapper received the configuration locally; only its hash is published.
  expect(await exists(paths.wrapperConfig)).toBe(false);
  expect((await snapshot(client, created.id)).entries.some((entry) => "configHash" in entry)).toBe(
    true,
  );

  const hostile = await workspaceDir(root, "hostile-ws");
  await makePackage(join(hostile, ".pisces", "extensions", "leaky"), {
    name: "leaky",
    files: {
      "context/boom.ts": [
        "export default async function resolve() {",
        `  throw new Error(${JSON.stringify(`${secret} ${workspace}`)});`,
        "}",
        "",
      ].join("\n"),
      "context/boom.ts.meta.json": JSON.stringify({ description: "leaky" }),
    },
  });
  await writeWorkspaceConfig(hostile, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: ["leaky#boom"],
  });
  const leaky = await createSession(client, { workspace: hostile, systemPrompt: ["x"] });
  await ok(client, "session.subscribe", { sessionId: leaky.id });
  const response = await client.request("turn.start", { sessionId: leaky.id });
  expect(response.error).toBeUndefined();
  await turnIdle(client);
  const ended = client.events.filter((event) => event.event === "turn.ended").at(-1);
  // Extension failure becomes the fixed safe turn error; the raw cause never rides along.
  expect(ended?.data).toMatchObject({
    reason: "failed",
    error: { code: "internal.error", message: "Turn failed" },
  });
  const leakyTranscript = client.transcript.filter((line) => line.includes(leaky.id)).join("\n");
  expect(leakyTranscript).not.toContain(secret);
  // The extension package path and source file name never ride along either.
  expect(leakyTranscript).not.toContain(join(hostile, ".pisces"));
  expect(leakyTranscript).not.toContain("boom.ts");
  expect(leakyTranscript).not.toContain("Could not materialize");
});

interface CrossUidClient {
  child: ChildProcess;
  events: Array<Record<string, unknown>>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  diagnostics(): string;
  reap(): Promise<void>;
}

function spawnCrossUidClient(
  fixturePath: string,
  socketPath: string,
  payload: string,
): CrossUidClient {
  const child = spawn(
    "unshare",
    [
      "--map-auto",
      "--user",
      "--setuid",
      "1",
      "--setgid",
      "1",
      "--",
      process.execPath,
      fixturePath,
      socketPath,
      payload,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";
  let stderr = "";
  let spawnError = "";
  let exited = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        stderr += `unparsable fixture output: ${line}\n`;
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      spawnError = error.message;
      exited = true;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  return {
    child,
    events,
    done,
    diagnostics: () =>
      [spawnError, stderr.trim()].filter((text) => text.length > 0).join("; ") ||
      "no child diagnostics",
    async reap() {
      if (!exited) child.kill("SIGKILL");
      await within(done, "cross-UID client was not reaped", 2000);
    },
  };
}

const closeServer = async (server: Server): Promise<void> => {
  const closed = new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
  await within(closed, "cross-UID preflight listener did not close", 2000).catch(() => {});
};

/**
 * Independent preflight: observe the mapped child's real kernel credential on a disposable
 * listener with the production native reader. A missing mapping or utility surfaces as an
 * explicit failure, never a skip.
 */
async function preflightForeignUid(fixturePath: string, runDir: string): Promise<number> {
  const probePath = join(runDir, "cross-uid-preflight.sock");
  const server = createServer();
  const acceptedSockets: Socket[] = [];
  let resolveAccepted!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => {
    resolveAccepted = resolve;
  });
  server.on("connection", (socket) => {
    acceptedSockets.push(socket);
    socket.on("error", () => socket.destroy());
    resolveAccepted(socket);
  });
  server.on("error", () => {});
  let client: CrossUidClient | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onListenError = (error: Error): void => reject(error);
      server.once("error", onListenError);
      server.listen(probePath, () => {
        server.removeListener("error", onListenError);
        resolve();
      });
    }).catch((error: unknown) => {
      throw new Error(
        `cross-UID fixture setup failed: preflight listener could not start: ${(error as Error).message}`,
      );
    });
    await chmod(probePath, 0o666);

    client = spawnCrossUidClient(fixturePath, probePath, "preflight\n");
    const outcome = await within(
      Promise.race([
        accepted.then((socket) => ({ socket })),
        client.done.then(({ code, signal }) => ({ code, signal })),
      ]),
      "cross-UID preflight connection was not observed; subordinate-ID mapping may be unavailable",
      CROSS_UID_SETUP_TIMEOUT_MS,
    ).catch((error: unknown) => {
      throw new Error(
        `cross-UID fixture setup failed: ${(error as Error).message}; ${client?.diagnostics()}`,
      );
    });

    if (!("socket" in outcome)) {
      throw new Error(
        `cross-UID fixture setup failed: client exited before the preflight connection (code ${outcome.code}, signal ${outcome.signal}); ${client.diagnostics()}`,
      );
    }
    return peerUidFor(outcome.socket);
  } finally {
    for (const socket of acceptedSockets.splice(0)) socket.destroy();
    if (client !== undefined) await client.reap().catch(() => {});
    await closeServer(server);
    for (const socket of acceptedSockets.splice(0)) socket.destroy();
  }
}

test("rejects a real cross-UID client before it reads any protocol byte", {
  timeout: 30000,
}, async () => {
  const root = await tempRoot();
  // The mapped UID cannot traverse a private home directory or the repository.
  await chmod(root, 0o755);
  const publicDir = await workspaceDir(root, "public");
  await chmod(publicDir, 0o755);
  const fixturePath = join(publicDir, "cross-uid-client.mjs");
  await writeFile(fixturePath, await readFile(CROSS_UID_FIXTURE, "utf8"), "utf8");
  await chmod(fixturePath, 0o644);
  const workspace = await workspaceDir(root, "ws");
  await installDemo(workspace, root);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN],
  });
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const { host, client } = await openDaemon({ dataDir, configDir });

  const daemonUid = process.geteuid?.() ?? 0;
  const foreignUid = await preflightForeignUid(fixturePath, publicDir);
  if (foreignUid === daemonUid) {
    throw new Error(
      `cross-UID fixture setup failed: host observed peer uid ${foreignUid} equal to daemon euid ${daemonUid}`,
    );
  }

  const paths = await prepareRuntimePaths(dataDir);
  // Relax DAC only after the production bind/0600 validation: the kernel credential check
  // must be the reason this peer is refused.
  await chmod(dataDir, 0o755);
  await chmod(paths.runDir, 0o755);
  await chmod(paths.socketPath, 0o666);
  expect((await lstat(paths.socketPath)).mode & 0o777).toBe(0o666);

  const payload = `${JSON.stringify({
    id: "foreign",
    method: "session.create",
    params: { workspace, systemPrompt: ["foreign"] },
  })}\n`;
  const foreign = spawnCrossUidClient(fixturePath, paths.socketPath, payload);
  try {
    const { code, signal } = await within(
      foreign.done,
      `cross-UID client did not exit; ${foreign.diagnostics()}`,
      CROSS_UID_CHILD_TIMEOUT_MS,
    );
    expect(foreign.events[0]).toMatchObject({ event: "connected" });
    const ended = foreign.events.find((event) => event.event === "ended") ?? {};
    // Authentication precedes NDJSON parsing: the authentic foreign peer reads zero bytes.
    expect(ended).toMatchObject({ received: 0 });
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(client.closed).toBe(false);
    expect(host.status()).toEqual({ state: "running", activeTurns: 0 });
    // Positive control: the daemon's own UID still reaches the protocol.
    expect((await barrier(client)) as { providers: unknown[] }).toHaveProperty("providers");
    expect(
      (await snapshot(client, (await createSession(client, { workspace })).id)).entries,
    ).toEqual(expect.any(Array));
  } finally {
    await foreign.reap();
  }
  expect(await lstat(paths.socketPath)).toBeDefined();
});

test("stops cleanly and shows a stale definition until the entry is reselected", {
  timeout: 30000,
}, async () => {
  const root = await tempRoot();
  const workspace = await workspaceDir(root, "ws");
  const paths = await installDemo(workspace, root);
  await writeWorkspaceConfig(workspace, {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [RUN],
  });
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const firstRecord: CapturedRequest[] = [];
  const first = await openDaemon({
    dataDir,
    configDir,
    adapter: toolCallingAdapter([RUN]),
    record: firstRecord,
  });
  const created = await createSession(first.client, { workspace, systemPrompt: ["tool"] });
  await startTurn(first.client, created.id);
  await turnIdle(first.client);
  const initial = await snapshot(first.client, created.id);
  const oldHash = initial.effective[0]?.definitionHash;
  expect(oldHash).toEqual(expect.any(String));

  await first.host.stop();
  const runtimePaths = await prepareRuntimePaths(dataDir);
  await expect(lstat(runtimePaths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const lock = await acquireDaemonLock(runtimePaths.lockPath);
  await lock.release();
  expect((await prepareRuntimePaths(dataDir)).socketPath).toBe(runtimePaths.socketPath);

  // Change the reviewed definition on disk between daemon lifetimes.
  await writeJson(join(workspace, ".pisces", "extensions", "demo", "tools", "run.ts.meta.json"), {
    description: "runs a tool v2",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  });
  const secondRecord: CapturedRequest[] = [];
  const second = await openDaemon({
    dataDir,
    configDir,
    adapter: plainAdapter(),
    record: secondRecord,
  });

  const stale = await snapshot(second.client, created.id);
  expect(stale.selection).toEqual([RUN]);
  expect(stale.effective).toEqual([{ name: RUN, definitionHash: oldHash, stale: true }]);
  // A stale tool is not declared to the provider.
  await startTurn(second.client, created.id);
  await turnIdle(second.client);
  expect(secondRecord[0]?.tools).toBeUndefined();
  expect(await readFile(paths.toolInvocations, "utf8")).toBe("invoke\n");

  // Deselect then reselect in one atomic batch: the current frozen definition wins.
  await ok(second.client, "queue.enqueue", {
    sessionId: created.id,
    entries: [toggleInput([RUN]), toggleInput([RUN])],
  });
  await startTurn(second.client, created.id);
  await turnIdle(second.client);
  const refreshed = await snapshot(second.client, created.id);
  const newHash = refreshed.effective[0]?.definitionHash;
  expect(refreshed.effective).toEqual([{ name: RUN, definitionHash: newHash, stale: false }]);
  expect(newHash).not.toBe(oldHash);
  expect(secondRecord[1]?.tools).toEqual([
    {
      name: RUN,
      description: "runs a tool v2",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  ]);

  await second.host.stop();
  await expect(lstat(runtimePaths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  const reclaimed = await acquireDaemonLock(runtimePaths.lockPath);
  await reclaimed.release();
});

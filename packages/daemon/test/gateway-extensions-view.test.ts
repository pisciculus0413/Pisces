import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContentBlock,
  createProviderManagement,
  createSessions,
  type DefinitionSnapshot,
  type EngineEvent,
  type EntryName,
  type JsonValue,
  type LlmAdapter,
  type NodeId,
  PiscesError,
  type ProviderManagement,
  type QueueEntry,
  type QueueEntryId,
  type QueueEntryInput,
  type SessionId,
  type SessionMeta,
  type SessionNodeDraft,
  type TurnId,
} from "@pisces/core";
import { MAX_RESPONSE_BYTES, type ProtocolEvent } from "@pisces/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createExtensions } from "../src/extensions/extensions.js";
import type { ExtensionBinding, Extensions, ExtensionsOptions } from "../src/extensions/types.js";
import { type ActiveTurnStore, createActiveTurnStore } from "../src/gateway/active-turn.js";
import { bootstrapGateway } from "../src/gateway/bootstrap.js";
import type { Gateway, GatewayDeps } from "../src/gateway/gateway.js";
import type {
  EntriesSnapshotResult,
  SessionReadResult,
  TurnStartResult,
} from "../src/gateway/protocol.js";
import type { ProviderHost } from "../src/provider/provider-host.js";
import { type Concurrency, createConcurrency } from "../src/runtime/concurrency.js";
import { createEventBus } from "../src/runtime/event-bus.js";
import { createSessionStore, type SessionStore } from "../src/session-store/session-store.js";
import { makePackage, toolSource, writeJson } from "./extensions-fixtures.js";
import {
  createGatewayHarness,
  descriptor,
  draftDeclaration,
  draftUser,
  type GatewayHarness,
  gatewayModel,
} from "./support/gateway-harness.js";

const RUN = "demo#run" as EntryName;
const WRAP = "demo#wrap" as EntryName;
const GHOST = "ghost#missing" as EntryName;
const NOW = "2026-11-08T05:00:00.000Z";
const SAFE_CODE = "config.invalid";
const SAFE_MESSAGE = "Invalid extension configuration";
const TOO_LARGE = {
  code: "protocol.frame_too_large",
  message: "Response exceeds the size limit",
};
const ENCODER = new TextEncoder();

const roots: string[] = [];
const open: ViewHarness[] = [];
const manualHarness: GatewayHarness[] = [];
let root = "";
let configDir = "";
let options: ExtensionsOptions;

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

const blockedExecute = () =>
  async function* (_request: unknown, signal?: AbortSignal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

interface ViewHarness {
  gateway: Gateway;
  store: SessionStore;
  concurrency: Concurrency;
  markers: ActiveTurnStore;
  events: EngineEvent[];
  requests: string[];
  commitOffsetReads(): number;
  /** nodeId arguments the Core branch reads actually used, in call order. */
  branchReadNodeIds(): (NodeId | undefined)[];
  close(): void;
}

interface OpenOptions {
  extensions?: Extensions;
  newSessionId?: () => SessionId;
  adapter?: LlmAdapter;
  dataDir?: string;
  execute?: (request: { body: string }, signal?: AbortSignal) => AsyncIterable<string>;
  countOffsets?: boolean;
}

function sequentialIds(): () => SessionId {
  let next = 0;
  return () => `s-${++next}` as SessionId;
}

// Real store; the optional wrapper only records commitOffset reads and branch reads.
function countingStore(
  store: SessionStore,
  reads: { count: number; branches: (NodeId | undefined)[] },
): SessionStore {
  return {
    initialize: () => store.initialize(),
    create: (meta, nodes) => store.create(meta, nodes),
    append: (id, nodes) => store.append(id, nodes),
    readBranch(id, nodeId) {
      reads.branches.push(nodeId);
      return store.readBranch(id, nodeId);
    },
    readTree: (id) => store.readTree(id),
    list: () => store.list(),
    updateMeta: (id, meta) => store.updateMeta(id, meta),
    getMeta: (id) => store.getMeta(id),
    async commitOffset(id) {
      reads.count += 1;
      return store.commitOffset(id);
    },
    readTreeSince: (id, offset) => store.readTreeSince(id, offset),
  };
}

async function openHarness(options: OpenOptions = {}): Promise<ViewHarness> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(root, "data-")));
  const realStore = createSessionStore({ dataDir });
  const reads = { count: 0, branches: [] as (NodeId | undefined)[] };
  const store = options.countOffsets ? countingStore(realStore, reads) : realStore;
  const providers: ProviderManagement = createProviderManagement();
  providers.registerProvider(
    descriptor({ id: "p", models: [gatewayModel("m"), gatewayModel("m2")] }),
  );
  providers.registerDialect("test", () => options.adapter ?? adapter);
  const recorded: EngineEvent[] = [];
  const bus = createEventBus();
  const requests: string[] = [];
  const providerHost: ProviderHost = {
    execute() {
      return (request, signal) => {
        requests.push(request.body);
        if (options.execute) return options.execute(request, signal);
        return (async function* () {
          yield "frame";
        })();
      };
    },
    async ready() {
      return true;
    },
  };
  const concurrency = createConcurrency();
  const markers = createActiveTurnStore({ dataDir });
  const deps: GatewayDeps = {
    store,
    providers,
    providerHost,
    concurrency,
    events: {
      publish(event) {
        recorded.push(structuredClone(event));
        bus.publish(event);
      },
      subscribe: (handler) => bus.subscribe(handler),
    },
    markers,
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    ...(options.newSessionId === undefined ? {} : { newSessionId: options.newSessionId }),
  };
  const { gateway } = await bootstrapGateway(deps);
  const harness: ViewHarness = {
    gateway,
    store,
    concurrency,
    markers,
    events: recorded,
    requests,
    commitOffsetReads: () => reads.count,
    branchReadNodeIds: () => [...reads.branches],
    close() {
      gateway.dispose();
    },
  };
  open.push(harness);
  return harness;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-gateway-view-"));
  roots.push(root);
  configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  options = { configDir, builtinDir: join(root, "builtin") };
});

afterEach(async () => {
  for (const harness of open.splice(0)) harness.close();
  for (const harness of manualHarness.splice(0)) await harness.close();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspaceDir(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeWorkspaceConfig(workspace: string, value: unknown): Promise<void> {
  await writeJson(join(workspace, ".pisces", "config.json"), value);
}

async function addTool(workspace: string, sentinel: string, description = "runs a tool") {
  await makePackage(join(workspace, ".pisces", "extensions", "demo"), {
    name: "demo",
    files: {
      "tools/run.ts": toolSource(sentinel),
      "tools/run.ts.meta.json": JSON.stringify({ description }),
    },
  });
  return RUN;
}

async function addWrap(workspace: string, sentinel: string) {
  await makePackage(join(workspace, ".pisces", "extensions", "demo"), {
    name: "demo",
    files: {
      "wrappers/wrap.ts": [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
        "export default function createWrapper() {",
        "  return (tool) => tool;",
        "}",
        "",
      ].join("\n"),
      "wrappers/wrap.ts.meta.json": JSON.stringify({
        config: { defaults: {}, schema: { type: "object" } },
      }),
    },
  });
  return WRAP;
}

function createSession(harness: ViewHarness, params: Record<string, unknown>, id = "create") {
  return harness.gateway.handle({
    id,
    method: "session.create",
    params: params as unknown as JsonValue,
  });
}

async function readSession(harness: ViewHarness, sessionId: SessionId): Promise<SessionReadResult> {
  const response = await harness.gateway.handle({
    id: "read",
    method: "session.read",
    params: { sessionId } as unknown as JsonValue,
  });
  if (response.error) throw new PiscesError(response.error.code, response.error.message);
  return response.result as unknown as SessionReadResult;
}

async function snapshot(
  harness: ViewHarness,
  sessionId: SessionId,
  id = "snapshot",
): Promise<EntriesSnapshotResult> {
  const response = await harness.gateway.handle({
    id,
    method: "entries.snapshot",
    params: { sessionId } as unknown as JsonValue,
  });
  if (response.error) throw new PiscesError(response.error.code, response.error.message);
  return response.result as unknown as EntriesSnapshotResult;
}

function enqueue(harness: ViewHarness, sessionId: SessionId, entries: QueueEntryInput[]) {
  return harness.gateway.handle({
    id: "enqueue",
    method: "queue.enqueue",
    params: { sessionId, entries } as unknown as JsonValue,
  });
}

function turnStart(
  harness: ViewHarness,
  sessionId: SessionId,
  extra: Record<string, unknown> = {},
) {
  return harness.gateway.handle({
    id: "start",
    method: "turn.start",
    params: { sessionId, ...extra } as unknown as JsonValue,
  });
}

function turnCancel(harness: ViewHarness, turnId: TurnId) {
  return harness.gateway.handle({
    id: "cancel",
    method: "turn.cancel",
    params: { turnId } as unknown as JsonValue,
  });
}

function queueEdit(
  harness: ViewHarness,
  sessionId: SessionId,
  id: QueueEntryId,
  content: ContentBlock[],
  requestId = "edit",
) {
  return harness.gateway.handle({
    id: requestId,
    method: "queue.edit",
    params: { sessionId, id, content } as unknown as JsonValue,
  });
}

function queueRemove(
  harness: ViewHarness,
  sessionId: SessionId,
  id: QueueEntryId,
  requestId = "remove",
) {
  return harness.gateway.handle({
    id: requestId,
    method: "queue.remove",
    params: { sessionId, id } as unknown as JsonValue,
  });
}

function agent(value: string): QueueEntryInput {
  return {
    kind: "agent",
    role: "user",
    source: "user",
    content: [{ type: "text", text: value }],
  };
}

function declaration(payload: unknown, source = "user"): QueueEntryInput {
  return {
    kind: "control",
    role: "declaration",
    source,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function declarationNode(payload: unknown): SessionNodeDraft {
  return {
    kind: "control",
    role: "declaration",
    source: "user",
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function userNode(value: string): SessionNodeDraft {
  return {
    kind: "agent",
    role: "user",
    source: "user",
    content: [{ type: "text", text: value }],
  };
}

function seedSessions(harness: ViewHarness) {
  let next = 0;
  return createSessions({
    repository: harness.store,
    newId: () => `seed-${++next}` as NodeId,
    now: () => NOW,
  });
}

function fullMeta(meta: Partial<SessionMeta> & { id: SessionId }): SessionMeta {
  return {
    model: "m",
    provider: "p",
    workspace: root,
    createdAt: NOW,
    schemaVersion: 1,
    ...meta,
  };
}

async function seed(
  harness: ViewHarness,
  drafts: SessionNodeDraft[],
  meta: Partial<SessionMeta> & { id: SessionId },
): Promise<SessionMeta> {
  const full = fullMeta(meta);
  await seedSessions(harness).create(full, drafts);
  return full;
}

interface TreeSeeds {
  meta: Partial<SessionMeta> & { id: SessionId };
  nodes: ({ draft: SessionNodeDraft; parent?: number } | undefined)[];
}

/** Writes explicit branches; the last written node stays the default head. */
async function seedTree(
  harness: ViewHarness,
  seeds: TreeSeeds,
): Promise<{ meta: SessionMeta; ids: NodeId[] }> {
  const sessions = seedSessions(harness);
  const full = fullMeta(seeds.meta);
  const ids: NodeId[] = [];
  for (let index = 0; index < seeds.nodes.length; index++) {
    const node = seeds.nodes[index];
    if (node === undefined) throw new Error(`missing tree node ${index}`);
    const parent = node.parent === undefined ? undefined : ids[node.parent];
    if (node.parent !== undefined && parent === undefined)
      throw new Error(`missing tree parent ${node.parent}`);
    const written =
      parent === undefined
        ? await sessions.create(full, [node.draft])
        : await sessions.append(full.id, [node.draft], parent);
    const first = written[0];
    if (first === undefined) throw new Error("expected a committed node");
    ids.push(first.id);
  }
  return { meta: full, ids };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function queueUpdates(harness: ViewHarness): EngineEvent[] {
  return harness.events.filter((event) => event.type === "queue.updated");
}

function definitionOf(binding: ExtensionBinding, name: EntryName): DefinitionSnapshot {
  const definition = binding.inventory.entries.find((entry) => entry.name === name)?.definition;
  if (definition === undefined) throw new Error(`missing frozen definition for ${name}`);
  return definition;
}

function turnResult(response: Awaited<ReturnType<typeof turnStart>>): TurnStartResult {
  return response.result as unknown as TurnStartResult;
}

function wireBytes(value: unknown): number {
  return ENCODER.encode(JSON.stringify(value)).length;
}

async function finishTurn(harness: ViewHarness, turnId: TurnId): Promise<void> {
  await turnCancel(harness, turnId);
  await waitFor(
    () => harness.events.some((event) => event.type === "turn.ended"),
    "turn cancellation",
  );
  await waitFor(() => harness.concurrency.activeTurns().length === 0, "turn cleanup");
}

describe("entries.snapshot", () => {
  test("reports a temporary session's persisted selection and never a pending toggle", async () => {
    const ws = await workspaceDir("snapshot-temp");
    const tool = await addTool(ws, join(root, "snapshot-temp.log"));
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const meta = (await createSession(h, { workspace: ws, systemPrompt: ["hello"] }))
      .result as unknown as SessionMeta;

    const before = await snapshot(h, meta.id);

    // The queued toggle is visible in the queue but never in selection or effective.
    expect(before.selection).toEqual([]);
    expect(before.effective).toEqual([]);
    expect(before.entries).toEqual([
      {
        name: tool,
        kind: "tool",
        description: "runs a tool",
        parameters: {},
        definitionHash: expect.any(String),
      },
    ]);
    const queued = await readSession(h, meta.id);
    expect(queued.queue.map((entry) => entry.role)).toEqual(["system", "declaration"]);

    const started = await turnStart(h, meta.id);
    expect(started.error).toBeUndefined();
    await waitFor(() => h.events.some((event) => event.type === "turn.ended"), "turn completion");

    const after = await snapshot(h, meta.id);
    expect(after.selection).toEqual([tool]);
    expect(after.effective).toEqual([
      { name: tool, definitionHash: before.entries[0]?.definitionHash, stale: false },
    ]);
  });

  test("marks a selected entry stale when its frozen definition no longer matches", async () => {
    const ws = await workspaceDir("snapshot-stale");
    const sentinel = join(root, "snapshot-stale.log");
    const tool = await addTool(ws, sentinel);
    await writeWorkspaceConfig(ws, { defaultProvider: "p", defaultModel: "m" });
    const real = createExtensions(options);
    const frozen = await real.prepare(await realpath(ws));
    const definition = definitionOf(frozen, tool);
    const h = await openHarness({ extensions: real, newSessionId: sequentialIds() });
    const meta = await seed(
      h,
      [userNode("hello"), declarationNode({ toggle: [tool], definitions: [definition] })],
      { id: "s-stale" as SessionId, workspace: await realpath(ws) },
    );
    await rm(join(ws, ".pisces", "extensions", "demo"), { recursive: true, force: true });

    const snap = await snapshot(h, meta.id);

    expect(snap.entries).toEqual([]);
    expect(snap.selection).toEqual([tool]);
    expect(snap.effective).toEqual([
      { name: tool, definitionHash: definition.definitionHash, stale: true },
    ]);
  });

  test("keeps a real replayed selection without any frozen binding", async () => {
    const h = await createGatewayHarness();
    manualHarness.push(h);
    const { meta } = await h.seed([draftUser("hello"), draftDeclaration([GHOST])]);

    const response = await h.gateway.handle({
      id: "snapshot",
      method: "entries.snapshot",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ entries: [], selection: [GHOST], effective: [] });
  });

  test("projects the inventory without configuration values or filesystem paths", async () => {
    const ws = await workspaceDir("snapshot-secret");
    const secret = "sk-secret-entry-config-value";
    const wrap = await addWrap(ws, join(root, "snapshot-secret.log"));
    await writeWorkspaceConfig(ws, {
      extensions: [wrap],
      defaultProvider: "p",
      defaultModel: "m",
      entryConfig: { [wrap]: { token: secret } },
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const meta = (await createSession(h, { workspace: ws })).result as unknown as SessionMeta;
    const real = await realpath(ws);

    const snap = await snapshot(h, meta.id);
    const wire = JSON.stringify(snap);

    expect(snap.entries).toEqual([
      {
        name: wrap,
        kind: "wrapper",
        description: "",
        parameters: {},
        definitionHash: expect.any(String),
        configHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    ]);
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain(real);
    expect(wire).not.toContain(".pisces");
    expect(wire).not.toContain("entryConfig");
    expect(wire).not.toContain("export default");
  });

  test("maps a leaking extension failure to the fixed safe error", async () => {
    const ws = await workspaceDir("snapshot-fail");
    await addTool(ws, join(root, "snapshot-fail.log"));
    const secret = "nested-secret-/etc/passwd";
    const real = createExtensions(options);
    const broken: Extensions = {
      readGlobalConfig: () => real.readGlobalConfig(),
      prepare() {
        throw new PiscesError("extensions.invalid", "outer failure", {
          data: { nested: { cause: { secret } } },
        });
      },
    };
    const h = await openHarness({ extensions: broken, newSessionId: sequentialIds() });
    const meta = await seed(h, [userNode("hello")], {
      id: "s-fail" as SessionId,
      workspace: await realpath(ws),
    });

    const response = await h.gateway.handle({
      id: "snapshot",
      method: "entries.snapshot",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });

    expect(response.error).toEqual({ code: SAFE_CODE, message: SAFE_MESSAGE });
    expect(JSON.stringify(response)).not.toContain("nested-secret");
    expect(JSON.stringify(response)).not.toContain("/etc/passwd");
  });

  test("rejects an oversized snapshot by UTF-8 bytes and keeps the gateway usable", async () => {
    const ws = await workspaceDir("snapshot-large");
    const description = "é".repeat(2_200_000);
    // Only the encoded envelope exceeds the budget; a character count would not.
    expect(description.length).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(ENCODER.encode(description).length).toBeGreaterThan(MAX_RESPONSE_BYTES);
    await addTool(ws, join(root, "snapshot-large.log"), description);
    await writeWorkspaceConfig(ws, {
      extensions: [],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const meta = (await createSession(h, { workspace: ws })).result as unknown as SessionMeta;
    const before = queueUpdates(h).length;

    const response = await h.gateway.handle({
      id: "large",
      method: "entries.snapshot",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });

    expect(response).toEqual({ id: "large", error: TOO_LARGE });
    expect(queueUpdates(h)).toHaveLength(before);
    const follow = await readSession(h, meta.id);
    expect(follow.selection).toEqual([]);
    expect(follow.queue).toEqual([]);
    const small = await h.gateway.handle({
      id: "small",
      method: "turn.list",
      params: {} as unknown as JsonValue,
    });
    expect(small).toEqual({ id: "small", result: { turns: [] } });
  });

  test("counts the request id toward the exact response envelope budget", async () => {
    const probeWs = await workspaceDir("snapshot-budget-probe");
    await addTool(probeWs, join(root, "probe.log"), "x".repeat(64));
    await writeWorkspaceConfig(probeWs, {
      extensions: [],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const probe = (await createSession(h, { workspace: probeWs })).result as unknown as SessionMeta;
    const probed = await snapshot(h, probe.id, "a");
    const overhead = wireBytes({ id: "a", result: probed }) - 64;

    const exactWs = await workspaceDir("snapshot-budget-exact");
    const length = MAX_RESPONSE_BYTES - 1 - overhead;
    expect(length).toBeGreaterThan(64);
    await addTool(exactWs, join(root, "exact.log"), "x".repeat(length));
    await writeWorkspaceConfig(exactWs, {
      extensions: [],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const meta = (await createSession(h, { workspace: exactWs })).result as unknown as SessionMeta;

    const fits = await h.gateway.handle({
      id: "a",
      method: "entries.snapshot",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });
    expect(fits.error).toBeUndefined();
    expect(wireBytes(fits)).toBe(MAX_RESPONSE_BYTES - 1);

    const longId = "a".repeat(64);
    const overflow = await h.gateway.handle({
      id: longId,
      method: "entries.snapshot",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });
    expect(overflow).toEqual({ id: longId, error: TOO_LARGE });
    const small = await h.gateway.handle({
      id: "small",
      method: "turn.list",
      params: {} as unknown as JsonValue,
    });
    expect(small).toEqual({ id: "small", result: { turns: [] } });
  });
});

describe("queue routes with a frozen binding", () => {
  test("edits an unconfirmed agent entry once through Core", async () => {
    const ws = await workspaceDir("queue-edit");
    await addTool(ws, join(root, "queue-edit.log"));
    await writeWorkspaceConfig(ws, { extensions: [], defaultProvider: "p", defaultModel: "m" });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const meta = (await createSession(h, { workspace: ws })).result as unknown as SessionMeta;
    await readSession(h, meta.id);
    const ids = (await enqueue(h, meta.id, [agent("before")])).result as unknown as {
      ids: QueueEntryId[];
    };
    const before = queueUpdates(h).length;

    const edited = await queueEdit(h, meta.id, ids.ids[0] as QueueEntryId, [
      { type: "text", text: "after" },
    ]);

    expect(edited).toEqual({ id: "edit", result: { id: ids.ids[0] } });
    const queue = (await readSession(h, meta.id)).queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.content).toEqual([{ type: "text", text: "after" }]);
    const updates = queueUpdates(h);
    expect(updates).toHaveLength(before + 1);
    const seqs = updates.map((event) => event.seq as number);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("locks a confirmed declaration, removes it, and still rejects an unconfirmed control edit", async () => {
    const ws = await workspaceDir("queue-confirmed");
    const tool = await addTool(ws, join(root, "queue-confirmed.log"));
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
      execute: blockedExecute(),
    });
    const meta = (await createSession(h, { workspace: ws, systemPrompt: ["hello"] }))
      .result as unknown as SessionMeta;
    await readSession(h, meta.id);
    const started = await turnStart(h, meta.id);
    expect(started.error).toBeUndefined();
    const turnId = turnResult(started).turnId;
    await waitFor(() => queueUpdates(h).length > 0, "the initial queue");

    // Enqueue then confirm through steer so the declaration stays queued while the turn blocks.
    expect((await enqueue(h, meta.id, [declaration({ toggle: [tool] })])).error).toBeUndefined();
    const steer = await turnStart(h, meta.id);
    expect(steer.error).toBeUndefined();
    const confirmed = (await readSession(h, meta.id)).queue.find(
      (entry) => entry.role === "declaration",
    ) as QueueEntry;
    expect(confirmed.confirmedAt).toEqual(expect.any(String));
    const before = queueUpdates(h).length;

    const locked = await queueEdit(h, meta.id, confirmed.id, [{ type: "text", text: "x" }]);
    expect(locked.error?.code).toBe("queue.entry_locked");
    expect(queueUpdates(h)).toHaveLength(before);
    expect((await readSession(h, meta.id)).queue).toEqual([confirmed]);

    const removed = await queueRemove(h, meta.id, confirmed.id);
    expect(removed).toEqual({ id: "remove", result: { id: confirmed.id } });
    expect((await readSession(h, meta.id)).queue).toEqual([]);
    expect(queueUpdates(h)).toHaveLength(before + 1);

    const unconfirmed = (await enqueue(h, meta.id, [declaration({ toggle: [tool] })]))
      .result as unknown as { ids: QueueEntryId[] };
    const pending = (await readSession(h, meta.id)).queue;
    expect(pending).toHaveLength(1);
    const rejected = await queueEdit(h, meta.id, unconfirmed.ids[0] as QueueEntryId, [
      { type: "text", text: "x" },
    ]);
    expect(rejected.error?.code).toBe("queue.invalid_control");
    expect((await readSession(h, meta.id)).queue).toEqual(pending);

    await finishTurn(h, turnId);
  });

  test("keeps configuration values, paths and nested error fields out of queue routes and events", async () => {
    const ws = await workspaceDir("queue-secret");
    const secret = "sk-secret-queue-config-value";
    const wrap = await addWrap(ws, join(root, "queue-secret.log"));
    await writeWorkspaceConfig(ws, {
      extensions: [wrap],
      defaultProvider: "p",
      defaultModel: "m",
      entryConfig: { [wrap]: { token: secret } },
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const meta = (await createSession(h, { workspace: ws })).result as unknown as SessionMeta;
    const wsReal = await realpath(ws);
    // Capture what the wire would deliver, not only the engine event bus.
    const delivered: ProtocolEvent[] = [];
    h.gateway.attach("viewer", (event) => {
      delivered.push(event);
    });
    expect(
      (
        await h.gateway.handle(
          {
            id: "subscribe",
            method: "session.subscribe",
            params: { sessionId: meta.id } as unknown as JsonValue,
          },
          "viewer",
        )
      ).error,
    ).toBeUndefined();
    const before = queueUpdates(h).length;
    const created = (await enqueue(h, meta.id, [agent("visible text")])).result as unknown as {
      ids: QueueEntryId[];
    };
    const entryId = created.ids[0] as QueueEntryId;

    const edited = await queueEdit(h, meta.id, entryId, [{ type: "text", text: "edited text" }]);
    const removed = await queueRemove(h, meta.id, entryId);
    const snap = await h.gateway.handle({
      id: "snapshot",
      method: "entries.snapshot",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });
    expect(edited.error).toBeUndefined();
    expect(removed.error).toBeUndefined();
    expect(snap.error).toBeUndefined();
    // Enqueue, edit and remove each publish exactly one complete queue.updated event.
    const updates = queueUpdates(h).slice(before);
    expect(updates).toHaveLength(3);
    const wireEvents = delivered.filter((event) => event.event === "queue.updated");
    expect(wireEvents).toHaveLength(3);

    const responses = [edited, removed, snap];
    const wires = [
      ...responses.map((response) => JSON.stringify(response)),
      ...updates.map((event) => JSON.stringify(event)),
      ...delivered.map((event) => JSON.stringify(event)),
    ];
    for (const wire of wires) {
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain(wsReal);
      expect(wire).not.toContain(".pisces");
      expect(wire).not.toContain("entryConfig");
      expect(wire).not.toContain('"cause"');
    }
    // Wire errors stay flat {code, message}; no nested error payload rides along.
    for (const response of responses) {
      if (response.error) expect(Object.keys(response.error).sort()).toEqual(["code", "message"]);
    }

    // A leaking extension failure on a queue route becomes the fixed safe error.
    const nestedSecret = "nested-secret-/etc/shadow";
    const real = createExtensions(options);
    const failing: Extensions = {
      readGlobalConfig: () => real.readGlobalConfig(),
      prepare() {
        throw new PiscesError("extensions.invalid", "outer failure", {
          data: { nested: { cause: { secret: nestedSecret } } },
        });
      },
    };
    const broken = await openHarness({ extensions: failing, newSessionId: sequentialIds() });
    const seeded = await seed(broken, [userNode("hello")], {
      id: "s-queue-fail" as SessionId,
      workspace: wsReal,
    });
    const failed = await enqueue(broken, seeded.id, [agent("x")]);

    expect(failed.error).toEqual({ code: SAFE_CODE, message: SAFE_MESSAGE });
    const failedWire = JSON.stringify(failed);
    expect(failedWire).not.toContain(nestedSecret);
    expect(failedWire).not.toContain("nested");
    expect(failedWire).not.toContain(wsReal);
    expect(Object.keys(failed.error ?? {}).sort()).toEqual(["code", "message"]);
    expect(broken.events.filter((event) => event.type === "queue.updated")).toEqual([]);
  });
});

describe("turn.start declaration validation", () => {
  test("rejects a cross-type reopen on the target branch before any marker or state change", async () => {
    const ws = await workspaceDir("cross-type");
    const tool = await addTool(ws, join(root, "cross-type.log"));
    await writeWorkspaceConfig(ws, { defaultProvider: "p", defaultModel: "m" });
    const real = createExtensions(options);
    const frozen = await real.prepare(await realpath(ws));
    const current = definitionOf(frozen, tool);
    const historical = { ...current, kind: "wrapper" as const, definitionHash: "historical" };
    const h = await openHarness({ extensions: real, newSessionId: sequentialIds() });
    // The default head keeps no evidence; the other branch records wrapper evidence.
    const seeded = await seedTree(h, {
      meta: { id: "s-cross" as SessionId, workspace: await realpath(ws) },
      nodes: [
        { draft: userNode("root") },
        { draft: userNode("target branch"), parent: 0 },
        {
          draft: declarationNode({ toggle: [tool], definitions: [historical] }),
          parent: 1,
        },
        { draft: declarationNode({ toggle: [tool] }), parent: 2 },
        { draft: userNode("default branch"), parent: 0 },
      ],
    });
    const meta = seeded.meta;
    await readSession(h, meta.id);
    expect((await enqueue(h, meta.id, [declaration({ toggle: [tool] })])).error).toBeUndefined();
    const queue = (await readSession(h, meta.id)).queue;
    const updates = queueUpdates(h).length;
    const target = seeded.ids[3] as NodeId;

    const started = await turnStart(h, meta.id, { nodeId: target });

    expect(started.error?.code).toBe("queue.invalid_control");
    expect(await h.markers.read(meta.id)).toBeUndefined();
    expect(h.concurrency.activeTurns()).toEqual([]);
    expect((await readSession(h, meta.id)).queue).toEqual(queue);
    expect(queue.every((entry) => entry.confirmedAt === undefined)).toBe(true);
    expect(queueUpdates(h)).toHaveLength(updates);
    expect(h.requests).toEqual([]);
    expect((await snapshot(h, meta.id)).selection).toEqual([]);
  });

  test("validates steer against the original branch before the first commit", async () => {
    const ws = await workspaceDir("steer-before");
    const tool = await addTool(ws, join(root, "steer-before.log"));
    await writeWorkspaceConfig(ws, { defaultProvider: "p", defaultModel: "m" });
    const real = createExtensions(options);
    const frozen = await real.prepare(await realpath(ws));
    const current = definitionOf(frozen, tool);
    const historical = { ...current, kind: "wrapper" as const, definitionHash: "historical" };
    const h = await openHarness({
      extensions: real,
      newSessionId: sequentialIds(),
      execute: blockedExecute(),
      countOffsets: true,
    });
    const seeded = await seedTree(h, {
      meta: { id: "s-before" as SessionId, workspace: await realpath(ws) },
      nodes: [
        { draft: userNode("root") },
        { draft: userNode("target branch"), parent: 0 },
        {
          draft: declarationNode({ toggle: [tool], definitions: [historical] }),
          parent: 1,
        },
        { draft: declarationNode({ toggle: [tool] }), parent: 2 },
        { draft: userNode("default branch"), parent: 0 },
      ],
    });
    const meta = seeded.meta;
    const target = seeded.ids[3] as NodeId;
    const offsetBefore = await h.store.commitOffset(meta.id);
    const started = await turnStart(h, meta.id, { nodeId: target });
    expect(started.error).toBeUndefined();
    // The turn commits nothing (empty queue), so the offset never advances.
    expect(await h.store.commitOffset(meta.id)).toBe(offsetBefore);

    expect((await enqueue(h, meta.id, [declaration({ toggle: [tool] })])).error).toBeUndefined();
    const pending = (await readSession(h, meta.id)).queue;
    const updates = queueUpdates(h).length;
    const branchReadsBefore = h.branchReadNodeIds().length;
    const steer = await turnStart(h, meta.id);

    expect(steer.error?.code).toBe("queue.invalid_control");
    // The turn never appended, so steer re-read the branch it started from, not the default head.
    expect(h.branchReadNodeIds().slice(branchReadsBefore)).toContain(target);
    expect((await readSession(h, meta.id)).queue).toEqual(pending);
    expect(pending.every((entry) => entry.confirmedAt === undefined)).toBe(true);
    expect(queueUpdates(h)).toHaveLength(updates);
    expect((await h.markers.read(meta.id))?.startNodeId).toBe(target);
    expect(h.concurrency.activeTurns()).toHaveLength(1);

    await finishTurn(h, turnResult(started).turnId);
  });

  test("steers after the turn committed a node using the offset read back from storage", async () => {
    const ws = await workspaceDir("steer-after");
    const tool = await addTool(ws, join(root, "steer-after.log"));
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
      execute: blockedExecute(),
      countOffsets: true,
    });
    const seeded = await seedTree(h, {
      meta: { id: "s-after" as SessionId, workspace: await realpath(ws) },
      nodes: [
        { draft: userNode("root") },
        { draft: userNode("target"), parent: 0 },
        { draft: userNode("default"), parent: 0 },
      ],
    });
    const meta = seeded.meta;
    const target = seeded.ids[1] as NodeId;
    await readSession(h, meta.id);
    expect((await enqueue(h, meta.id, [agent("queued")])).error).toBeUndefined();
    const startOffset = await h.store.commitOffset(meta.id);

    const started = await turnStart(h, meta.id, { nodeId: target });
    expect(started.error).toBeUndefined();
    await waitFor(
      async () => (await h.store.commitOffset(meta.id)) > startOffset,
      "the turn commit",
    );
    const readsBefore = h.commitOffsetReads();
    expect((await enqueue(h, meta.id, [agent("steer")])).error).toBeUndefined();
    const branchReadsBefore = h.branchReadNodeIds().length;
    const steer = await turnStart(h, meta.id);

    expect(steer.error).toBeUndefined();
    expect(turnResult(steer).mode).toBe("steer");
    // The offset decision comes from storage, not from an append promise.
    expect(h.commitOffsetReads()).toBeGreaterThan(readsBefore);
    // The turn already appended, so the queue must be validated against the latest committed
    // branch (nodeId undefined) and never against the original target node.
    const steerBranchReads = h.branchReadNodeIds().slice(branchReadsBefore);
    expect(steerBranchReads.length).toBeGreaterThan(0);
    expect(steerBranchReads).not.toContain(target);
    expect(steerBranchReads.at(-1)).toBeUndefined();
    const queue = (await readSession(h, meta.id)).queue;
    expect(queue).toEqual([expect.objectContaining({ confirmedAt: expect.any(String) })]);
    expect((await h.markers.read(meta.id))?.startNodeId).toBe(target);
    expect(h.concurrency.activeTurns()).toHaveLength(1);

    await finishTurn(h, turnResult(started).turnId);
  });

  test("confirms a same-kind reopen on another branch after removing a queued declaration", async () => {
    const ws = await workspaceDir("same-kind");
    const tool = await addTool(ws, join(root, "same-kind.log"));
    await writeWorkspaceConfig(ws, { defaultProvider: "p", defaultModel: "m" });
    const real = createExtensions(options);
    const frozen = await real.prepare(await realpath(ws));
    const definition = definitionOf(frozen, tool);
    const h = await openHarness({ extensions: real, newSessionId: sequentialIds() });
    // Branch A (default head) selects the tool; branch B opens then closes it, keeping evidence.
    const seeded = await seedTree(h, {
      meta: { id: "s-kind" as SessionId, workspace: await realpath(ws) },
      nodes: [
        { draft: userNode("root") },
        { draft: userNode("branch b"), parent: 0 },
        {
          draft: declarationNode({ toggle: [tool], definitions: [definition] }),
          parent: 1,
        },
        { draft: declarationNode({ toggle: [tool] }), parent: 2 },
        { draft: userNode("branch a"), parent: 0 },
        {
          draft: declarationNode({ toggle: [tool], definitions: [definition] }),
          parent: 4,
        },
      ],
    });
    const meta = seeded.meta;
    await readSession(h, meta.id);
    const branchB = seeded.ids[3] as NodeId;

    const first = (await enqueue(h, meta.id, [declaration({ toggle: [tool] })]))
      .result as unknown as {
      ids: QueueEntryId[];
    };
    const second = (await enqueue(h, meta.id, [declaration({ toggle: [tool] })]))
      .result as unknown as {
      ids: QueueEntryId[];
    };
    expect((await queueRemove(h, meta.id, second.ids[0] as QueueEntryId)).error).toBeUndefined();
    expect((await readSession(h, meta.id)).queue.map((entry) => entry.id)).toEqual([first.ids[0]]);

    const started = await turnStart(h, meta.id, { nodeId: branchB });

    expect(started.error).toBeUndefined();
    expect(turnResult(started).mode).toBe("new");
    await waitFor(() => h.events.some((event) => event.type === "turn.ended"), "turn completion");
    expect((await readSession(h, meta.id)).queue).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });
});

describe("daemon route surface", () => {
  test("keeps unknown methods unknown and rejects malformed queue parameters", async () => {
    const ws = await workspaceDir("malformed");
    await addTool(ws, join(root, "malformed.log"));
    await writeWorkspaceConfig(ws, { extensions: [], defaultProvider: "p", defaultModel: "m" });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const meta = (await createSession(h, { workspace: ws })).result as unknown as SessionMeta;
    await readSession(h, meta.id);

    const unknown = await h.gateway.handle({
      id: "unknown",
      method: "entries.list",
      params: {} as unknown as JsonValue,
    });
    expect(unknown.error?.code).toBe("protocol.unknown_method");

    const malformed: [string, Record<string, unknown>][] = [
      ["entries.snapshot", {}],
      ["entries.snapshot", { sessionId: "not a session" }],
      ["queue.edit", { sessionId: meta.id, id: 5, content: [] }],
      ["queue.edit", { sessionId: meta.id, id: "x", content: "nope" }],
      ["queue.remove", { sessionId: meta.id }],
      ["queue.remove", { sessionId: meta.id, id: 5 }],
      ["queue.clear", {}],
    ];
    for (const [method, params] of malformed) {
      const response = await h.gateway.handle({
        id: "bad",
        method,
        params: params as unknown as JsonValue,
      });
      expect(response.error?.code).toBe("protocol.invalid_request");
    }
  });
});

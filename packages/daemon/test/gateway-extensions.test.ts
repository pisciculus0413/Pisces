import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextEntries,
  type ContextSourceRegistry,
  createProviderManagement,
  createSessions,
  createTools,
  type DefinitionSnapshot,
  type EngineEvent,
  type EntryName,
  type Exec,
  type JsonValue,
  type LlmAdapter,
  type NodeId,
  PiscesError,
  type ProviderManagement,
  type QueueEntry,
  type QueueEntryInput,
  type SessionId,
  type SessionMeta,
  type SessionNodeDraft,
  type Skills,
} from "@pisces/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createExtensions } from "../src/extensions/extensions.js";
import type { Extensions, ExtensionsOptions } from "../src/extensions/types.js";
import { createActiveTurnStore } from "../src/gateway/active-turn.js";
import { bootstrapGateway } from "../src/gateway/bootstrap.js";
import { prepareExtensionSession } from "../src/gateway/extension-session.js";
import type { Gateway, GatewayDeps } from "../src/gateway/gateway.js";
import type { SessionDefaults, SessionReadResult } from "../src/gateway/protocol.js";
import type { ProviderHost } from "../src/provider/provider-host.js";
import { createConcurrency } from "../src/runtime/concurrency.js";
import { createEventBus } from "../src/runtime/event-bus.js";
import { createSessionStore, type SessionStore } from "../src/session-store/session-store.js";
import { contextSource, makePackage, toolSource, writeJson } from "./extensions-fixtures.js";
import { descriptor, gatewayModel } from "./support/gateway-harness.js";

const RUN = "demo#run" as EntryName;
const WRAP = "demo#wrap" as EntryName;
const NOTE = "demo#note" as EntryName;
const GHOST = "ghost#missing" as EntryName;
const NOW = "2026-11-09T05:00:00.000Z";
const SAFE_CODE = "config.invalid";
const SAFE_MESSAGE = "Invalid extension configuration";

const roots: string[] = [];
const open: ExtHarness[] = [];
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

interface ExtHarness {
  gateway: Gateway;
  store: SessionStore;
  events: EngineEvent[];
  requests: string[];
  close(): void;
}

interface OpenOptions {
  extensions?: Extensions;
  newSessionId?: () => SessionId;
  adapter?: LlmAdapter;
  exec?: Exec;
}

function sequentialIds(): () => SessionId {
  let next = 0;
  return () => `s-${++next}` as SessionId;
}

async function openHarness(options: OpenOptions = {}): Promise<ExtHarness> {
  const dataDir = await mkdtemp(join(root, "data-"));
  const store = createSessionStore({ dataDir });
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
      return (request) => {
        requests.push(request.body);
        return (async function* () {
          yield "frame";
        })();
      };
    },
    async ready() {
      return true;
    },
  };
  const deps: GatewayDeps = {
    store,
    providers,
    providerHost,
    concurrency: createConcurrency(),
    events: {
      publish(event) {
        recorded.push(structuredClone(event));
        bus.publish(event);
      },
      subscribe: (handler) => bus.subscribe(handler),
    },
    markers: createActiveTurnStore({ dataDir }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    ...(options.newSessionId === undefined ? {} : { newSessionId: options.newSessionId }),
    ...(options.exec === undefined ? {} : { exec: options.exec }),
  };
  const { gateway } = await bootstrapGateway(deps);
  const harness: ExtHarness = {
    gateway,
    store,
    events: recorded,
    requests,
    close() {
      gateway.dispose();
    },
  };
  open.push(harness);
  return harness;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-gateway-ext-"));
  roots.push(root);
  configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  options = { configDir, builtinDir: join(root, "builtin") };
});

afterEach(async () => {
  for (const harness of open.splice(0)) harness.close();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspaceDir(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeGlobal(value: unknown): Promise<void> {
  await writeJson(join(configDir, "config.json"), value);
}

async function writeWorkspaceConfig(workspace: string, value: unknown): Promise<void> {
  await writeJson(join(workspace, ".pisces", "config.json"), value);
}

// Real extension modules: the top-level side effect leaves a sentinel only when imported.
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

async function addSource(workspace: string, sentinel: string) {
  await makePackage(join(workspace, ".pisces", "extensions", "demo"), {
    name: "demo",
    files: { "context/note.ts": contextSource(sentinel) },
  });
  return NOTE;
}

function createSession(harness: ExtHarness, params: Record<string, unknown>, id = "create") {
  return harness.gateway.handle({
    id,
    method: "session.create",
    params: params as unknown as JsonValue,
  });
}

async function readSession(harness: ExtHarness, sessionId: SessionId): Promise<SessionReadResult> {
  const response = await harness.gateway.handle({
    id: "read",
    method: "session.read",
    params: { sessionId } as unknown as JsonValue,
  });
  expect(response.error).toBeUndefined();
  return response.result as unknown as SessionReadResult;
}

function enqueue(
  harness: ExtHarness,
  sessionId: SessionId,
  entries: QueueEntryInput[],
  id = "enqueue",
) {
  return harness.gateway.handle({
    id,
    method: "queue.enqueue",
    params: { sessionId, entries } as unknown as JsonValue,
  });
}

function declaration(payload: unknown, source = "user"): QueueEntryInput {
  return {
    kind: "control",
    role: "declaration",
    source,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function agent(value: string): QueueEntryInput {
  return {
    kind: "agent",
    role: "user",
    source: "user",
    content: [{ type: "text", text: value }],
  };
}

const ENCODER = new TextEncoder();

// The queue payload without the id/createdAt that Core adds server-side.
function stripServerFields(entry: QueueEntry): Partial<QueueEntry> {
  const copy: Partial<QueueEntry> = structuredClone(entry);
  delete copy.id;
  delete copy.createdAt;
  return copy;
}

function wireBytes(value: unknown): number {
  return ENCODER.encode(JSON.stringify(value)).length;
}

function queueUpdates(harness: ExtHarness): EngineEvent[] {
  return harness.events.filter((event) => event.type === "queue.updated");
}

function declarationPayload(entry: QueueEntry | undefined): {
  toggle: EntryName[];
  definitions?: DefinitionSnapshot[];
} {
  expect(entry).toBeDefined();
  const block = (entry as QueueEntry).content[0];
  expect(block?.type).toBe("text");
  return JSON.parse((block as { text: string }).text) as {
    toggle: EntryName[];
    definitions?: DefinitionSnapshot[];
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function seed(
  harness: ExtHarness,
  drafts: SessionNodeDraft[],
  meta: Partial<SessionMeta> & { id: SessionId },
): Promise<SessionMeta> {
  let next = 0;
  const sessions = createSessions({
    repository: harness.store,
    newId: () => `seed-${++next}` as NodeId,
    now: () => NOW,
  });
  const full: SessionMeta = {
    model: "m",
    provider: "p",
    workspace: root,
    createdAt: NOW,
    schemaVersion: 1,
    ...meta,
  };
  await sessions.create(full, drafts);
  return full;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("prepareExtensionSession", () => {
  test("resolves workspace, defaults and extensions without importing modules", async () => {
    const ws = await workspaceDir("prepare");
    const sentinel = join(root, "prepare.log");
    const tool = await addTool(ws, sentinel);
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const real = createExtensions(options);
    const validated: string[] = [];

    const prepared = await prepareExtensionSession(real, { workspace: ws }, async (value) => {
      validated.push(value);
      return true;
    });

    expect(validated).toEqual([ws]);
    expect(prepared.workspace).toBe(await realpath(ws));
    expect(prepared.binding.workspace).toBe(await realpath(ws));
    expect(prepared.provider).toBe("p");
    expect(prepared.model).toBe("m");
    expect(prepared.extensions).toEqual([tool]);
    expect(prepared.binding.entries.kind(tool)).toBe("tool");
    expect(await exists(sentinel)).toBe(false);

    const overwritten = await prepareExtensionSession(
      real,
      { workspace: ws, provider: "p", model: "m2", extensions: [] },
      async () => true,
    );
    expect(overwritten.model).toBe("m2");
    expect(overwritten.extensions).toEqual([]);
    expect(overwritten.binding).not.toBe(prepared.binding);
  });

  test("rejects a failed workspace validation and a lone provider or model", async () => {
    const ws = await workspaceDir("prepare-invalid");
    await writeWorkspaceConfig(ws, { defaultProvider: "p", defaultModel: "m" });
    const real = createExtensions(options);

    await expect(
      prepareExtensionSession(real, { workspace: ws }, async () => false),
    ).rejects.toMatchObject({ code: "session.invalid_workspace" });
    await expect(
      prepareExtensionSession(real, { workspace: ws, provider: "p" }, async () => true),
    ).rejects.toMatchObject({ code: "session.model_required" });
    await expect(
      prepareExtensionSession(real, { workspace: ws, model: "m" }, async () => true),
    ).rejects.toMatchObject({ code: "session.model_required" });
  });
});

describe("session.create in configuration mode", () => {
  test("enqueues one unconfirmed declaration without running extension code", async () => {
    const ws = await workspaceDir("create");
    const sentinel = join(root, "create.log");
    const tool = await addTool(ws, sentinel);
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    const created = await createSession(h, { workspace: ws, systemPrompt: ["be brief"] });

    expect(created.error).toBeUndefined();
    const meta = created.result as unknown as SessionMeta;
    expect(meta).toMatchObject({
      model: "m",
      provider: "p",
      workspace: await realpath(ws),
      schemaVersion: 1,
    });
    const read = await readSession(h, meta.id);
    expect(read.selection).toEqual([]);
    const entry = read.queue.find((queued) => queued.role === "declaration");
    expect(entry?.kind).toBe("control");
    expect(entry?.source).toBe("create");
    expect(entry?.confirmedAt).toBeUndefined();
    expect(declarationPayload(entry)).toEqual({
      toggle: [tool],
      definitions: [
        expect.objectContaining({ name: tool, kind: "tool", description: "runs a tool" }),
      ],
    });
    expect(read.queue.filter((queued) => queued.kind === "agent")).toHaveLength(1);
    expect(queueUpdates(h)).toHaveLength(1);
    expect(await h.store.list()).toEqual([]);
    expect(await exists(sentinel)).toBe(false);
  });

  test("an explicit empty list replaces configured defaults and adds no declaration", async () => {
    const ws = await workspaceDir("empty");
    const tool = await addTool(ws, join(root, "empty.log"));
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    const created = await createSession(h, { workspace: ws, extensions: [] });

    expect(created.error).toBeUndefined();
    const meta = created.result as unknown as SessionMeta;
    const read = await readSession(h, meta.id);
    expect(read.queue).toEqual([]);
    expect(read.selection).toEqual([]);
    expect(queueUpdates(h)).toEqual([]);
    expect(await h.store.list()).toEqual([]);
  });

  test("an explicit list replaces configured defaults and the configured pair fills omissions", async () => {
    const ws = await workspaceDir("replace");
    const sentinel = join(root, "replace.log");
    const tool = await addTool(ws, sentinel);
    const wrap = await addWrap(ws, sentinel);
    await writeWorkspaceConfig(ws, {
      extensions: [wrap],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    const created = await createSession(h, { workspace: ws, extensions: [tool] });

    const meta = created.result as unknown as SessionMeta;
    expect(meta).toMatchObject({ model: "m", provider: "p" });
    const read = await readSession(h, meta.id);
    expect(
      declarationPayload(read.queue.find((entry) => entry.role === "declaration")),
    ).toMatchObject({ toggle: [tool] });
    expect(await exists(sentinel)).toBe(false);
  });

  test("requires a provider/model pair, prefers explicit values and validates the catalogue", async () => {
    const ws = await workspaceDir("models");
    await addTool(ws, join(root, "models.log"));
    await writeWorkspaceConfig(ws, { defaultProvider: "p", defaultModel: "m" });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    const configured = await createSession(h, { workspace: ws });
    expect((configured.result as unknown as SessionMeta).model).toBe("m");

    const explicit = await createSession(h, { workspace: ws, provider: "p", model: "m2" });
    expect((explicit.result as unknown as SessionMeta).model).toBe("m2");

    for (const params of [
      { workspace: ws, provider: "p" },
      { workspace: ws, model: "m2" },
      { workspace: ws, provider: "p", model: "unknown" },
    ]) {
      const response = await createSession(h, params);
      expect(response.error?.code).toBe(
        params.model === "unknown" ? "session.invalid_model" : "session.model_required",
      );
    }
    expect(await h.store.list()).toEqual([]);
    expect(queueUpdates(h)).toEqual([]);
  });

  test("takes the default workspace only from global configuration", async () => {
    const wsA = await workspaceDir("ws-a");
    const wsB = await workspaceDir("ws-b");
    await addTool(wsA, join(root, "ws-a.log"));
    await writeWorkspaceConfig(wsA, { defaultProvider: "p", defaultModel: "m" });
    await writeGlobal({ defaultWorkspace: wsA });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    const fromDefault = await createSession(h, {});
    expect((fromDefault.result as unknown as SessionMeta).workspace).toBe(await realpath(wsA));

    const explicit = await createSession(h, { workspace: wsB, provider: "p", model: "m" });
    expect((explicit.result as unknown as SessionMeta).workspace).toBe(await realpath(wsB));

    const missing = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    await writeGlobal({});
    const response = await createSession(missing, {});
    expect(response.error?.code).toBe("session.workspace_required");
    expect(await missing.store.list()).toEqual([]);
  });

  test("rejects unknown declarations without leaving a runtime behind", async () => {
    const ws = await workspaceDir("reject-create");
    const sentinel = join(root, "reject-create.log");
    const tool = await addTool(ws, sentinel);
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    const response = await createSession(h, { workspace: ws, extensions: [GHOST] });

    expect(response.error?.code).toBe("queue.invalid_control");
    expect(queueUpdates(h)).toEqual([]);
    expect(await h.store.list()).toEqual([]);
    expect(await exists(sentinel)).toBe(false);
    const follow = await enqueue(h, "s-1" as SessionId, [agent("probe")]);
    expect(follow.error?.code).toBe("session.not_found");
  });

  test("fails atomically when the initial declaration exceeds the queue budget", async () => {
    const ws = await workspaceDir("create-too-large");
    const sentinel = join(root, "create-too-large.log");
    const tool = await addTool(ws, sentinel, "x".repeat(300_000));
    await writeWorkspaceConfig(ws, {
      extensions: [tool],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    const response = await createSession(h, { workspace: ws });

    // The enriched declaration only fails inside Context.enqueue, after the runtime exists.
    expect(response.error?.code).toBe("queue.entry_too_large");
    expect(h.events).toEqual([]);
    expect(await h.store.list()).toEqual([]);
    const follow = await h.gateway.handle({
      id: "read",
      method: "session.read",
      params: { sessionId: "s-1" } as unknown as JsonValue,
    });
    // A cached runtime would answer this read instead of consulting the empty store.
    expect(follow.error?.code).toBe("session.not_found");
    expect(await exists(sentinel)).toBe(false);
  });

  test("two concurrent creates of one workspace keep independent frozen bindings", async () => {
    const ws = await workspaceDir("concurrent");
    const sentinel = join(root, "concurrent.log");
    const metaPath = join(ws, ".pisces", "extensions", "demo", "tools", "run.ts.meta.json");
    await addTool(ws, sentinel, "version one");
    await writeWorkspaceConfig(ws, {
      extensions: [RUN],
      defaultProvider: "p",
      defaultModel: "m",
    });
    const real = createExtensions(options);
    let prepared = 0;
    let chain: Promise<unknown> = Promise.resolve();
    const ordered: Extensions = {
      readGlobalConfig: () => real.readGlobalConfig(),
      prepare(workspace) {
        const call = ++prepared;
        const run = chain.then(async () => {
          if (call === 2) await writeJson(metaPath, { description: "version two" });
          return real.prepare(workspace);
        });
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    const h = await openHarness({ extensions: ordered, newSessionId: sequentialIds() });

    const [first, second] = await Promise.all([
      createSession(h, { workspace: ws }, "first"),
      createSession(h, { workspace: ws }, "second"),
    ]);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    const left = await readSession(h, (first.result as unknown as SessionMeta).id);
    const right = await readSession(h, (second.result as unknown as SessionMeta).id);
    const leftDefinitions = declarationPayload(
      left.queue.find((entry) => entry.role === "declaration"),
    ).definitions;
    const rightDefinitions = declarationPayload(
      right.queue.find((entry) => entry.role === "declaration"),
    ).definitions;
    expect(leftDefinitions?.map((definition) => definition.description)).toEqual(["version one"]);
    expect(rightDefinitions?.map((definition) => definition.description)).toEqual(["version two"]);
    expect(leftDefinitions?.[0]?.definitionHash).not.toBe(rightDefinitions?.[0]?.definitionHash);
    expect(await exists(sentinel)).toBe(false);
  });
});

describe("session lifecycle in configuration mode", () => {
  test("a persisted session prepares once from meta.workspace and keeps its meta and history", async () => {
    const wsA = await workspaceDir("restart-a");
    const wsB = await workspaceDir("restart-b");
    const tool = await addTool(wsA, join(root, "restart.log"), "version one");
    await writeWorkspaceConfig(wsA, { defaultProvider: "p", defaultModel: "m" });
    await addSource(wsB, join(root, "restart-b.log"));
    await writeWorkspaceConfig(wsB, { extensions: [NOTE] });
    await writeGlobal({ defaultWorkspace: wsB, defaultProvider: "p", defaultModel: "m2" });

    const real = createExtensions(options);
    const frozen = await real.prepare(await realpath(wsA));
    const defined = frozen.inventory.entries.find((entry) => entry.name === tool)?.definition;
    expect(defined).toBeDefined();
    const seededText = JSON.stringify({ toggle: [tool], definitions: [defined] });
    const h = await openHarness({ extensions: real, newSessionId: sequentialIds() });
    const meta = await seed(
      h,
      [
        {
          kind: "agent",
          role: "user",
          source: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          kind: "control",
          role: "declaration",
          source: "create",
          content: [{ type: "text", text: seededText }],
        },
      ],
      { id: "s-restart" as SessionId, workspace: await realpath(wsA) },
    );

    // The package disappears after the reviewed declaration was frozen.
    await rm(join(wsA, ".pisces", "extensions", "demo"), { recursive: true, force: true });

    const read = await readSession(h, meta.id);
    expect(read.meta).toEqual(meta);
    expect(read.selection).toEqual([tool]);
    const declarationNode = read.records.find((node) => node.role === "declaration");
    expect(declarationNode?.content).toEqual([{ type: "text", text: seededText }]);

    // meta.workspace is wsA, so wsB's entry is unknown even though global defaults point there.
    const wrongWorkspace = await enqueue(h, meta.id, [declaration({ toggle: [NOTE] })]);
    expect(wrongWorkspace.error?.code).toBe("queue.invalid_control");

    const started = await h.gateway.handle({
      id: "start",
      method: "turn.start",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });
    expect(started.error).toBeUndefined();
    await waitFor(() => h.requests.length === 1, "turn request");
    const body = JSON.parse(h.requests[0] as string) as {
      tools?: unknown[];
      messages: unknown[];
    };
    // The frozen definition no longer matches the binding: stale, never executed.
    expect(body.tools).toBeUndefined();
    expect(body.messages.length).toBeGreaterThan(0);
    await waitFor(() => h.events.some((event) => event.type === "turn.ended"), "turn completion");
  });

  test("keeps a persisted session readable only while its workspace resolves", async () => {
    const ws = await workspaceDir("gone-workspace");
    await addTool(ws, join(root, "gone-workspace.log"));
    await writeWorkspaceConfig(ws, { extensions: [RUN], defaultProvider: "p", defaultModel: "m" });
    const canonical = await realpath(ws);
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const meta = await seed(
      h,
      [
        {
          kind: "agent",
          role: "user",
          source: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      { id: "s-gone" as SessionId, workspace: canonical },
    );
    await rm(ws, { recursive: true, force: true });

    const response = await h.gateway.handle({
      id: "read",
      method: "session.read",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });

    // The binding cannot resolve the workspace, so the gateway reports the existing safe
    // workspace code rather than the generic configuration error or a degrading read.
    expect(response.error).toEqual({
      code: "session.invalid_workspace",
      message: "Invalid workspace",
    });
    const wire = JSON.stringify(response);
    expect(wire).not.toContain(canonical);
    expect(wire).not.toContain("ENOENT");
    expect(wire).not.toContain("Invalid extension configuration");
    expect(h.events).toEqual([]);
  });

  test("prepares a persisted session exactly once, under the lock and without imports", async () => {
    const ws = await workspaceDir("lock-prepare");
    const sentinel = join(root, "lock-prepare.log");
    await addTool(ws, sentinel);
    await writeWorkspaceConfig(ws, { defaultProvider: "p", defaultModel: "m" });
    const real = createExtensions(options);
    let prepares = 0;
    const counting: Extensions = {
      readGlobalConfig: () => real.readGlobalConfig(),
      prepare(workspace) {
        prepares += 1;
        return real.prepare(workspace);
      },
    };
    const h = await openHarness({
      extensions: counting,
      newSessionId: sequentialIds(),
    });
    const meta = await seed(
      h,
      [
        {
          kind: "agent",
          role: "user",
          source: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      { id: "s-lock" as SessionId, workspace: await realpath(ws) },
    );

    const first = await readSession(h, meta.id);
    const second = await readSession(h, meta.id);
    const accepted = await enqueue(h, meta.id, [agent("more")]);

    expect(first.meta).toEqual(meta);
    expect(second.meta).toEqual(meta);
    expect(accepted.error).toBeUndefined();
    expect(prepares).toBe(1);
    expect(await exists(sentinel)).toBe(false);
  });

  test("a new turn invokes tools through the frozen binding, not empty per-turn Tools", async () => {
    const ws = await workspaceDir("turn-tools");
    const sentinel = join(root, "turn-tools.log");
    await addTool(ws, sentinel);
    await writeWorkspaceConfig(ws, {
      extensions: [RUN],
      defaultProvider: "p",
      defaultModel: "m",
    });
    let step = 0;
    const toolCalling: LlmAdapter = {
      dialect: "test",
      buildRequest(request) {
        return { path: "/v1/chat/completions", body: JSON.stringify(request) };
      },
      parseChunk() {
        step += 1;
        if (step === 1)
          return [
            { type: "toolCall", call: { id: "call_1", name: RUN, arguments: {} } },
            { type: "stop", reason: "toolCall" },
          ];
        return [
          { type: "content", delta: "done" },
          { type: "stop", reason: "stop" },
        ];
      },
    };
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
      adapter: toolCalling,
    });
    const created = await createSession(h, { workspace: ws, systemPrompt: ["use the tool"] });
    const meta = created.result as unknown as SessionMeta;
    await readSession(h, meta.id);

    const started = await h.gateway.handle({
      id: "start",
      method: "turn.start",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });

    expect(started.error).toBeUndefined();
    await waitFor(() => h.events.some((event) => event.type === "turn.ended"), "turn completion");
    // Only the binding's Tools can load the frozen module and return its result.
    expect(h.requests).toHaveLength(2);
    const read = await readSession(h, meta.id);
    const result = read.records.find((node) => node.role === "tool");
    expect(result?.content).toEqual([
      expect.objectContaining({
        type: "toolResult",
        content: [{ type: "text", text: "ran" }],
      }),
    ]);
    expect(await exists(sentinel)).toBe(true);
  });

  test("injects exec and canonical workspace access into a bound tool context", async () => {
    const ws = await workspaceDir("turn-context");
    const sentinel = join(root, "turn-context.json");
    await makePackage(join(ws, ".pisces", "extensions", "demo"), {
      name: "demo",
      files: {
        "tools/run.ts": [
          'import { writeFileSync } from "node:fs";',
          "export default async function run(_args, context) {",
          '  const result = await context.exec.run("probe", []);',
          '  await context.files.writeFile("files-probe.txt", "files-rooted");',
          `  writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({`,
          "    workspace: context.workspace,",
          '    files: context.files.resolve("."),',
          "    exec: result.stdout,",
          "  }));",
          '  return { content: [{ type: "text", text: "ran" }] };',
          "}",
          "",
        ].join("\n"),
        "tools/run.ts.meta.json": JSON.stringify({ description: "probes context" }),
      },
    });
    await writeWorkspaceConfig(ws, {
      extensions: [RUN],
      defaultProvider: "p",
      defaultModel: "m",
    });
    let step = 0;
    const toolCalling: LlmAdapter = {
      dialect: "test",
      buildRequest(request) {
        return { path: "/v1/chat/completions", body: JSON.stringify(request) };
      },
      parseChunk() {
        step += 1;
        if (step === 1)
          return [
            { type: "toolCall", call: { id: "call_1", name: RUN, arguments: {} } },
            { type: "stop", reason: "toolCall" },
          ];
        return [
          { type: "content", delta: "done" },
          { type: "stop", reason: "stop" },
        ];
      },
    };
    const exec: Exec = {
      run: async () => ({
        exitCode: 0,
        stdout: "injected-exec",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    };
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
      adapter: toolCalling,
      exec,
    });
    const created = await createSession(h, { workspace: ws, systemPrompt: ["use the tool"] });
    const meta = created.result as unknown as SessionMeta;
    await readSession(h, meta.id);

    const started = await h.gateway.handle({
      id: "start",
      method: "turn.start",
      params: { sessionId: meta.id } as unknown as JsonValue,
    });

    expect(started.error).toBeUndefined();
    await waitFor(() => h.events.some((event) => event.type === "turn.ended"), "turn completion");
    const canonical = await realpath(ws);
    const probe = JSON.parse(await readFile(sentinel, "utf8")) as {
      workspace: string;
      files: string;
      exec: string;
    };
    expect(probe).toEqual({ workspace: canonical, files: canonical, exec: "injected-exec" });
    expect(await readFile(join(canonical, "files-probe.txt"), "utf8")).toBe("files-rooted");
  });

  test("counts server ids and timestamps when rejecting an entry over 256 KiB", async () => {
    const ws = await workspaceDir("budget-entry");
    const sentinel = join(root, "budget-entry.log");
    const metaPath = join(ws, ".pisces", "extensions", "demo", "tools", "run.ts.meta.json");
    const tool = await addTool(ws, sentinel, "x".repeat(200_000));
    await writeWorkspaceConfig(ws, { extensions: [], defaultProvider: "p", defaultModel: "m" });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });

    // Probe the exact entry Core stores, including the id and createdAt it assigns.
    const probe = (await createSession(h, { workspace: ws, extensions: [] }))
      .result as unknown as SessionMeta;
    await readSession(h, probe.id);
    expect((await enqueue(h, probe.id, [declaration({ toggle: [tool] })])).error).toBeUndefined();
    const probed = (await readSession(h, probe.id)).queue[0] as QueueEntry;
    const payload = wireBytes(stripServerFields(probed));
    const overhead = wireBytes(probed) - payload;
    expect(overhead).toBeGreaterThan(8);

    // Grow the description until the payload alone sits just under 256 KiB; the server
    // metadata above then pushes the stored entry over the limit.
    const target = 262144 - 4;
    await writeJson(metaPath, { description: "x".repeat(200_000 + target - payload) });
    const created = (await createSession(h, { workspace: ws, extensions: [] }))
      .result as unknown as SessionMeta;
    await readSession(h, created.id);
    const before = queueUpdates(h).length;

    const tooLarge = await enqueue(h, created.id, [declaration({ toggle: [tool] })]);

    expect(tooLarge.error?.code).toBe("queue.entry_too_large");
    expect(queueUpdates(h)).toHaveLength(before);
    expect((await readSession(h, created.id)).queue).toEqual([]);

    const small = await enqueue(h, created.id, [agent("still works")]);
    expect(small.error).toBeUndefined();
    expect(await exists(sentinel)).toBe(false);
  });

  test("counts server ids and timestamps when rejecting a batch over 1 MiB", async () => {
    const ws = await workspaceDir("budget-queue");
    await addTool(ws, join(root, "budget-queue.log"));
    await writeWorkspaceConfig(ws, { extensions: [], defaultProvider: "p", defaultModel: "m" });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const big = "b".repeat(200_000);
    const batch = (last: string): QueueEntryInput[] => [
      declaration({ toggle: [RUN] }),
      ...[big, big, big, big, last].map((text) => agent(text)),
    ];

    // Probe a batch that fits, then measure its payload without server metadata.
    const probe = (await createSession(h, { workspace: ws, extensions: [] }))
      .result as unknown as SessionMeta;
    await readSession(h, probe.id);
    expect((await enqueue(h, probe.id, batch(big))).error).toBeUndefined();
    const probed = (await readSession(h, probe.id)).queue;
    expect(probed).toHaveLength(6);
    const payload = wireBytes(probed.map(stripServerFields));
    expect(wireBytes(probed) - payload).toBeGreaterThan(8);

    const target = 1048576 - 4;
    const grownLength = 200_000 + target - payload;
    // The batch limit must fire, not a single-entry limit.
    expect(grownLength).toBeLessThan(262144);
    const created = (await createSession(h, { workspace: ws, extensions: [] }))
      .result as unknown as SessionMeta;
    await readSession(h, created.id);
    const before = queueUpdates(h).length;

    const batchResult = await enqueue(h, created.id, batch("b".repeat(grownLength)));

    expect(batchResult.error?.code).toBe("queue.too_large");
    expect(queueUpdates(h)).toHaveLength(before);
    expect((await readSession(h, created.id)).queue).toEqual([]);
  });

  test("enriches declarations in one batch and keeps other controls rejected", async () => {
    const ws = await workspaceDir("enqueue");
    const sentinel = join(root, "enqueue.log");
    const tool = await addTool(ws, sentinel);
    await writeWorkspaceConfig(ws, { extensions: [], defaultProvider: "p", defaultModel: "m" });
    const h = await openHarness({
      extensions: createExtensions(options),
      newSessionId: sequentialIds(),
    });
    const created = await createSession(h, { workspace: ws, extensions: [] });
    const meta = created.result as unknown as SessionMeta;
    await readSession(h, meta.id);

    const accepted = await enqueue(h, meta.id, [agent("before"), declaration({ toggle: [tool] })]);
    expect(accepted.error).toBeUndefined();
    const queue = (await readSession(h, meta.id)).queue;
    expect(queue).toHaveLength(2);
    expect(declarationPayload(queue[1])).toMatchObject({
      toggle: [tool],
      definitions: [expect.objectContaining({ name: tool, definitionHash: expect.any(String) })],
    });

    const inline = declaration({
      toggle: [tool],
      definitions: [
        {
          name: tool,
          kind: "tool",
          description: "inline",
          parameters: {},
          definitionHash: "inline",
        },
      ],
    });
    const invalid: [QueueEntryInput, string][] = [
      [declaration({ toggle: [GHOST] }), "queue.invalid_control"],
      [inline, "queue.invalid_control"],
      [declaration({ toggle: [tool, tool] }), "queue.duplicate_name"],
      [
        {
          kind: "control",
          role: "declaration",
          source: "user",
          content: [{ type: "text", text: JSON.stringify({ toggle: [tool], extra: true }) }],
        },
        "queue.invalid_control",
      ],
      [
        {
          kind: "control",
          role: "compaction",
          source: "user",
          content: [{ type: "text", text: "{}" }],
        } as unknown as QueueEntryInput,
        "queue.invalid_control",
      ],
    ];
    const before = queueUpdates(h).length;
    const readBefore = (await readSession(h, meta.id)).queue;
    for (const [entry, code] of invalid) {
      const response = await enqueue(h, meta.id, [entry]);
      expect(response.error?.code).toBe(code);
    }
    expect(queueUpdates(h)).toHaveLength(before);
    expect((await readSession(h, meta.id)).queue).toEqual(readBefore);
    expect(await exists(sentinel)).toBe(false);
  });
});

describe("daemon safety boundaries", () => {
  test("refuses configuration mode mixed with manual injection at startup", async () => {
    const dataDir = await mkdtemp(join(root, "conflict-"));
    const store = createSessionStore({ dataDir });
    const recorded: EngineEvent[] = [];
    const bus = createEventBus();
    const base: GatewayDeps = {
      store,
      providers: createProviderManagement(),
      providerHost: {
        execute: () =>
          async function* () {
            yield "frame";
          },
        ready: async () => true,
      },
      concurrency: createConcurrency(),
      events: {
        publish(event) {
          recorded.push(structuredClone(event));
          bus.publish(event);
        },
        subscribe: (handler) => bus.subscribe(handler),
      },
      markers: createActiveTurnStore({ dataDir }),
      extensions: createExtensions(options),
    };
    const defaults: SessionDefaults = { workspace: root, provider: "p", model: "m" };
    const manual: Partial<GatewayDeps>[] = [
      { defaults },
      { createTools: () => createTools() },
      { entries: { kind: () => undefined } as ContextEntries },
      { skills: { selected: () => [] } as Skills },
      { sources: { get: () => undefined } as ContextSourceRegistry },
    ];

    for (const injection of manual) {
      await expect(bootstrapGateway({ ...base, ...injection })).rejects.toMatchObject({
        code: "daemon.start_failed",
      });
    }
    expect(await store.list()).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test("maps extension service failures to one fixed safe error", async () => {
    const ws = await workspaceDir("safe");
    await addTool(ws, join(root, "safe.log"));
    const real = createExtensions(options);
    const leakingPrepare: Extensions = {
      readGlobalConfig: () => real.readGlobalConfig(),
      prepare() {
        throw new Error("secret /etc/passwd leaked from prepare");
      },
    };
    const leakingGlobal: Extensions = {
      readGlobalConfig() {
        throw new Error("secret /etc/passwd leaked from config");
      },
      prepare: (workspace) => real.prepare(workspace),
    };

    const leakingPisces: Extensions = {
      readGlobalConfig: () => real.readGlobalConfig(),
      prepare() {
        throw new PiscesError("extensions.invalid", "loader leaked /etc/passwd", {
          data: { path: "/etc/passwd" },
        });
      },
    };
    const leakingSafeCode: Extensions = {
      readGlobalConfig: () => real.readGlobalConfig(),
      prepare() {
        throw new PiscesError("config.invalid", "conflict at /etc/passwd");
      },
    };

    for (const broken of [leakingPrepare, leakingGlobal, leakingPisces, leakingSafeCode]) {
      const h = await openHarness({ extensions: broken, newSessionId: sequentialIds() });
      const response = await createSession(h, { workspace: ws });
      // Only the fixed code/message reaches the wire, even for loader-built PiscesErrors.
      expect(response.error).toEqual({ code: SAFE_CODE, message: SAFE_MESSAGE });
      expect(JSON.stringify(response)).not.toContain("/etc/passwd");
      expect(queueUpdates(h)).toEqual([]);
      expect(await h.store.list()).toEqual([]);
    }
  });
});

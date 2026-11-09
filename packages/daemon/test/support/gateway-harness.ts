import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextEntries,
  createProviderManagement,
  createSessions,
  type EngineEvent,
  type EntryName,
  type EventBus,
  type Exec,
  type ExecuteProvider,
  type JsonValue,
  type LlmAdapter,
  type ModelDescriptor,
  type NodeId,
  PiscesError,
  type ProviderDescriptor,
  type ProviderManagement,
  type QueueEntryId,
  type QueueEntryInput,
  type SessionId,
  type SessionMeta,
  type SessionNode,
  type SessionNodeDraft,
  type Tools,
  type TurnEndedEvent,
  type TurnId,
  type WorkspaceAccess,
} from "@pisces/core";
import { type ActiveTurnStore, createActiveTurnStore } from "../../src/gateway/active-turn.js";
import { bootstrapGateway } from "../../src/gateway/bootstrap.js";
import type { Gateway, GatewayDeps } from "../../src/gateway/gateway.js";
import type { QueueEnqueueResult, SessionDefaults } from "../../src/gateway/protocol.js";
import type { ProviderHost } from "../../src/provider/provider-host.js";
import { type Concurrency, createConcurrency } from "../../src/runtime/concurrency.js";
import { createEventBus } from "../../src/runtime/event-bus.js";
import { createSessionStore, type SessionStore } from "../../src/session-store/session-store.js";

const NOW = "2026-11-08T05:00:00.000Z";

export interface GatewayHarnessOptions {
  defaults?: SessionDefaults;
  execute?: ExecuteProvider;
  adapter?: LlmAdapter;
  validateWorkspace?: (workspace: string) => Promise<boolean>;
  markerStore?: ActiveTurnStore;
  bus?: EventBus;
  dataDir?: string;
  newSessionId?: () => SessionId;
  providers?: ProviderManagement;
  createTools?: () => Tools;
  entries?: ContextEntries;
  exec?: Exec;
  createWorkspaceAccess?: (workspace: string) => WorkspaceAccess;
}

export interface GatewayHarness {
  gateway: Gateway;
  store: SessionStore;
  markers: ActiveTurnStore;
  concurrency: Concurrency;
  bus: EventBus;
  providers: ProviderManagement;
  dataDir: string;
  executed: string[];
  events(): EngineEvent[];
  waitForEvent(type: string): Promise<EngineEvent>;
  waitForTurnEnd(turnId: TurnId): Promise<TurnEndedEvent>;
  seed(
    drafts: SessionNodeDraft[],
    meta?: SessionMeta,
  ): Promise<{ meta: SessionMeta; nodes: SessionNode[] }>;
  enqueue(sessionId: SessionId, entries: QueueEntryInput[]): Promise<QueueEntryId[]>;
  close(): Promise<void>;
}

export interface BootstrapRecoveryFixture {
  harness: GatewayHarness;
  sessionId: SessionId;
}

export function gatewayModel(id: string): ModelDescriptor {
  return { id, contextWindow: 1000, maxOutput: 100, modalities: ["text"] };
}

export function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: "p",
    dialect: "test",
    baseUrl: "https://provider.test/v1",
    auth: { type: "apiKey", credentialRef: "test" },
    models: [gatewayModel("m")],
    ...overrides,
  };
}

export function draftUser(value: string): SessionNodeDraft {
  return {
    kind: "agent",
    role: "user",
    source: "create",
    content: [{ type: "text", text: value }],
  };
}

export function draftDeclaration(toggle: EntryName[]): SessionNodeDraft {
  return {
    kind: "control",
    role: "declaration",
    source: "test",
    content: [{ type: "text", text: JSON.stringify({ toggle }) }],
  };
}

export function draftQueueUser(value: string): QueueEntryInput {
  return {
    kind: "agent",
    role: "user",
    source: "test",
    content: [{ type: "text", text: value }],
  };
}

const defaultAdapter: LlmAdapter = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventTurnId(event: EngineEvent): unknown {
  return isRecord(event.data) ? event.data.turnId : undefined;
}

export async function createGatewayHarness(
  options: GatewayHarnessOptions = {},
): Promise<GatewayHarness> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "pisces-gateway-")));
  const store = createSessionStore({ dataDir });
  const concurrency = createConcurrency();
  const providers = options.providers ?? createProviderManagement();
  if (!options.providers) {
    providers.registerProvider(descriptor());
    providers.registerDialect("test", () => options.adapter ?? defaultAdapter);
  }
  const markers = options.markerStore ?? createActiveTurnStore({ dataDir });
  const executed: string[] = [];
  const providerHost: ProviderHost = {
    execute(providerId) {
      return (request, signal) => {
        executed.push(providerId);
        if (options.execute) return options.execute(request, signal);
        return (async function* () {
          yield "frame";
        })();
      };
    },
    async ready(providerId) {
      const provider = providers.get(providerId);
      return provider !== undefined && provider.models.length > 0;
    },
  };

  const baseBus = options.bus ?? createEventBus();
  const recorded: EngineEvent[] = [];
  type Waiter = { match: (event: EngineEvent) => boolean; resolve: (event: EngineEvent) => void };
  const waiters: Waiter[] = [];
  function publish(event: EngineEvent): void {
    const clone = structuredClone(event);
    recorded.push(clone);
    const pending = waiters.splice(0);
    for (const waiter of pending) {
      if (waiter.match(clone)) waiter.resolve(structuredClone(clone));
      else waiters.push(waiter);
    }
    baseBus.publish(event);
  }
  const gatewayBus = {
    publish,
    subscribe(handler: (event: EngineEvent) => void) {
      return baseBus.subscribe(handler);
    },
  };
  function nextEvent(match: (event: EngineEvent) => boolean): Promise<EngineEvent> {
    const found = recorded.find(match);
    if (found) return Promise.resolve(structuredClone(found));
    return new Promise((resolve) => waiters.push({ match, resolve }));
  }

  const deps: GatewayDeps = {
    store,
    providers,
    providerHost,
    concurrency,
    events: gatewayBus,
    markers,
    ...(options.defaults ? { defaults: options.defaults } : {}),
    ...(options.validateWorkspace ? { validateWorkspace: options.validateWorkspace } : {}),
    ...(options.newSessionId ? { newSessionId: options.newSessionId } : {}),
    ...(options.createTools ? { createTools: options.createTools } : {}),
    ...(options.entries ? { entries: options.entries } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.createWorkspaceAccess
      ? { createWorkspaceAccess: options.createWorkspaceAccess }
      : {}),
  };
  const { gateway } = await bootstrapGateway(deps);

  let seeded = 0;
  let requests = 0;
  const now = () => new Date().toISOString();

  return {
    gateway,
    store,
    markers,
    concurrency,
    bus: gatewayBus,
    providers,
    dataDir,
    executed,
    events() {
      return recorded.map((event) => structuredClone(event));
    },
    waitForEvent(type) {
      return nextEvent((event) => event.type === type);
    },
    waitForTurnEnd(turnId) {
      return nextEvent(
        (event) => event.type === "turn.ended" && eventTurnId(event) === turnId,
      ) as Promise<TurnEndedEvent>;
    },
    async seed(drafts, meta) {
      const id = meta?.id ?? options.newSessionId?.() ?? (randomUUID() as SessionId);
      const sessionMeta: SessionMeta = {
        id,
        model: "m",
        provider: "p",
        workspace: dataDir,
        createdAt: now(),
        schemaVersion: 1,
        ...meta,
      };
      let parent: NodeId | undefined;
      const nodes = drafts.map((draft) => {
        const nodeId = `seed-${++seeded}` as NodeId;
        const node: SessionNode = {
          ...draft,
          id: nodeId,
          parentId: parent ?? nodeId,
          createdAt: now(),
          schemaVersion: 1,
        };
        parent = nodeId;
        return node;
      });
      await store.create(sessionMeta, nodes);
      return { meta: sessionMeta, nodes };
    },
    async enqueue(sessionId, entries) {
      const response = await gateway.handle({
        id: `harness-${++requests}`,
        method: "queue.enqueue",
        params: { sessionId, entries } as unknown as JsonValue,
      });
      if (response.error) throw new PiscesError(response.error.code, response.error.message);
      const result = response.result as QueueEnqueueResult | undefined;
      if (!result) throw new PiscesError("internal.error", "Missing queue.enqueue result");
      return result.ids;
    },
    async close() {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function createBootstrapRecoveryFixture(
  options: GatewayHarnessOptions = {},
): Promise<BootstrapRecoveryFixture> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "pisces-gateway-recovery-")));
  const store = createSessionStore({ dataDir });
  await store.initialize();
  const sessionId = options.newSessionId?.() ?? (randomUUID() as SessionId);
  let nodes = 0;
  const sessions = createSessions({
    repository: store,
    newId: () => `fixture-${++nodes}` as NodeId,
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
  if (!root) throw new Error("Expected a committed root node");
  const startOffset = await store.commitOffset(sessionId);
  await sessions.append(
    sessionId,
    [
      {
        kind: "agent",
        role: "assistant",
        source: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "pkg#tool" as EntryName,
            arguments: {},
          },
        ],
      },
    ],
    root.id,
  );
  const markers = options.markerStore ?? createActiveTurnStore({ dataDir });
  await markers.write(sessionId, {
    turnId: "t-recovered" as TurnId,
    startedAt: NOW,
    startOffset,
    startNodeId: root.id,
  });
  const harness = await createGatewayHarness({ ...options, dataDir, markerStore: markers });
  return { harness, sessionId };
}

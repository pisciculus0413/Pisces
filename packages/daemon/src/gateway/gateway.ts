import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type AgentLoopDriver,
  type Context,
  type ContextEntries,
  type ContextSourceRegistry,
  createAgentLoopDriver,
  createContext,
  createSessions,
  type EngineEvent,
  type EntryName,
  type EventBus,
  type JsonValue,
  type NodeId,
  PiscesError,
  type ProviderManagement,
  type QueueEntryId,
  type QueueEntryInput,
  type SessionEventClock,
  type SessionId,
  type SessionMeta,
  type SessionNode,
  type Sessions,
  type Skills,
  type Tools,
  type TurnId,
} from "@pisces/core";
import type { ProviderHost } from "../provider/provider-host.js";
import type { Concurrency } from "../runtime/concurrency.js";
import { createSessionEventClock } from "../runtime/event-clock.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { ActiveTurnStore } from "./active-turn.js";
import type {
  GatewayRequest,
  GatewayResponse,
  ModelInfo,
  ProviderInfo,
  ProviderListResult,
  QueueEnqueueResult,
  SessionDefaults,
  SessionReadResult,
} from "./protocol.js";

export interface GatewayDeps {
  store: SessionStore;
  providers: ProviderManagement;
  providerHost: ProviderHost;
  concurrency: Concurrency;
  events: EventBus;
  markers: ActiveTurnStore;
  defaults?: SessionDefaults;
  createTools?: () => Tools;
  entries?: ContextEntries;
  skills?: Skills;
  sources?: ContextSourceRegistry;
  validateWorkspace?: (workspace: string) => Promise<boolean>;
  newSessionId?: () => SessionId;
  newTurnId?: () => TurnId;
  newQueueEntryId?: () => QueueEntryId;
  newNodeId?: () => NodeId;
  now?: () => string;
}

export interface Gateway {
  handle(request: GatewayRequest): Promise<GatewayResponse>;
}

interface PendingMarker {
  turnId: TurnId;
  startedAt: string;
}

/** One per session for the process lifetime; never evicted or re-created. */
interface SessionRuntime {
  meta: SessionMeta;
  persisted: boolean;
  context: Context;
  sessions: Sessions;
  driver: AgentLoopDriver;
  eventClock: SessionEventClock;
  pendingMarker?: PendingMarker;
}

const EMPTY_ENTRIES: ContextEntries = { kind: () => undefined };
const EMPTY_SKILLS: Skills = { selected: () => [] };
const EMPTY_SOURCES: ContextSourceRegistry = { get: () => undefined };
const ENTRY_NAME = /^[^#\s]+#[^#\s]+$/u;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): never {
  throw new PiscesError("protocol.invalid_request", "Invalid request parameters");
}

async function collect(source: AsyncIterable<SessionNode>): Promise<SessionNode[]> {
  const nodes: SessionNode[] = [];
  for await (const node of source) nodes.push(node);
  return nodes;
}

async function defaultValidateWorkspace(workspace: string): Promise<boolean> {
  if (!isAbsolute(workspace)) return false;
  try {
    const info = await stat(workspace);
    if (!info.isDirectory()) return false;
    await access(workspace, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function modelInfo(model: {
  id: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
  pricing?: { input: number; output: number; currency: string };
}): ModelInfo {
  return {
    id: model.id,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    modalities: [...model.modalities],
    ...(model.pricing
      ? {
          pricing: {
            input: model.pricing.input,
            output: model.pricing.output,
            currency: model.pricing.currency,
          },
        }
      : {}),
  };
}

export function createGateway(deps: GatewayDeps): Gateway {
  const now = deps.now ?? (() => new Date().toISOString());
  const newNodeId = deps.newNodeId ?? (() => randomUUID() as NodeId);
  const newQueueEntryId = deps.newQueueEntryId ?? (() => randomUUID() as QueueEntryId);
  const newSessionId = deps.newSessionId ?? (() => randomUUID() as SessionId);
  const baseSessions = createSessions({ repository: deps.store, newId: newNodeId, now });
  const runtimes = new Map<SessionId, SessionRuntime>();

  function createRuntime(meta: SessionMeta, persisted: boolean): SessionRuntime {
    const sessionId = meta.id;
    const eventClock = createSessionEventClock();
    let runtime: SessionRuntime | undefined;

    function current(): SessionRuntime {
      if (runtime === undefined)
        throw new PiscesError("internal.error", "Session runtime is not initialized");
      return runtime;
    }

    const sessions: Sessions = {
      async create(sessionMeta, drafts, options) {
        const nodes = await baseSessions.create(sessionMeta, drafts, options);
        const owner = current();
        owner.persisted = true;
        owner.meta = sessionMeta;
        const pending = owner.pendingMarker;
        if (pending) {
          try {
            await deps.markers.write(sessionId, {
              turnId: pending.turnId,
              startedAt: pending.startedAt,
              startOffset: 0,
            });
          } catch (cause) {
            throw new PiscesError("storage.io", "Active turn marker could not be written", {
              cause,
            });
          }
        }
        return nodes;
      },
      append: (sessionId, drafts, parentId, options) =>
        baseSessions.append(sessionId, drafts, parentId, options),
      readBranch: (sessionId, nodeId) => baseSessions.readBranch(sessionId, nodeId),
      readTree: (sessionId) => baseSessions.readTree(sessionId),
      list: () => baseSessions.list(),
      updateMeta: (sessionId, nextMeta) => baseSessions.updateMeta(sessionId, nextMeta),
    };

    const context = createContext({
      sessionId,
      meta,
      persisted,
      sessions,
      entries: deps.entries ?? EMPTY_ENTRIES,
      skills: deps.skills ?? EMPTY_SKILLS,
      sources: deps.sources ?? EMPTY_SOURCES,
      events: deps.events,
      eventClock,
      runExclusive: (task) => deps.concurrency.runExclusive(sessionId, task),
      newId: newQueueEntryId,
      now,
    });

    const driver = createAgentLoopDriver({
      runExclusive: (_id, task) => deps.concurrency.runExclusive(sessionId, task),
      now,
    });

    runtime = { meta, persisted, context, sessions, driver, eventClock };
    return runtime;
  }

  async function runtimeFor(sessionId: SessionId): Promise<SessionRuntime> {
    const existing = runtimes.get(sessionId);
    if (existing) return existing;
    const meta = await deps.store.getMeta(sessionId);
    const runtime = createRuntime(meta, true);
    runtimes.set(sessionId, runtime);
    return runtime;
  }

  const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    async "provider.list"(): Promise<ProviderListResult> {
      const providers: ProviderInfo[] = [];
      for (const descriptor of deps.providers.list()) {
        providers.push({
          id: descriptor.id,
          ready:
            descriptor.models.length > 0 ? await deps.providerHost.ready(descriptor.id) : false,
          models: descriptor.models.map(modelInfo),
        });
      }
      return { providers };
    },

    async "session.create"(params): Promise<SessionMeta> {
      if (params.templateId !== undefined) invalidRequest();
      const workspace = params.workspace;
      if (workspace !== undefined && typeof workspace !== "string") invalidRequest();
      const explicitProvider = params.provider;
      if (explicitProvider !== undefined && typeof explicitProvider !== "string") invalidRequest();
      const explicitModel = params.model;
      if (explicitModel !== undefined && typeof explicitModel !== "string") invalidRequest();
      const systemPrompt = params.systemPrompt;
      if (
        systemPrompt !== undefined &&
        (!Array.isArray(systemPrompt) || !systemPrompt.every((entry) => typeof entry === "string"))
      )
        invalidRequest();
      const explicitExtensions = params.extensions;
      if (
        explicitExtensions !== undefined &&
        (!Array.isArray(explicitExtensions) ||
          !explicitExtensions.every((name) => typeof name === "string"))
      )
        invalidRequest();

      const resolvedWorkspace = workspace ?? deps.defaults?.workspace;
      if (resolvedWorkspace === undefined)
        throw new PiscesError("session.workspace_required", "Workspace is required");
      const validateWorkspace = deps.validateWorkspace ?? defaultValidateWorkspace;
      if (!(await validateWorkspace(resolvedWorkspace)))
        throw new PiscesError("session.invalid_workspace", "Invalid workspace");

      const resolvedProvider = explicitProvider ?? deps.defaults?.provider;
      const resolvedModel = explicitModel ?? deps.defaults?.model;
      if (resolvedProvider === undefined || resolvedModel === undefined)
        throw new PiscesError("session.model_required", "Provider and model are required");
      if (!deps.providers.select(resolvedProvider, resolvedModel))
        throw new PiscesError("session.invalid_model", "Invalid model");

      const extensions = (explicitExtensions ?? deps.defaults?.extensions ?? []) as EntryName[];
      const names = new Set<string>();
      for (const extension of extensions) {
        if (!ENTRY_NAME.test(extension))
          throw new PiscesError("queue.invalid_control", "Invalid extension name");
        if (names.has(extension))
          throw new PiscesError("queue.duplicate_name", "Duplicate extension name");
        names.add(extension);
      }
      if (extensions.length)
        throw new PiscesError("queue.invalid_control", "Extensions are not available");

      const sessionId = newSessionId();
      const meta: SessionMeta = {
        id: sessionId,
        model: resolvedModel,
        provider: resolvedProvider,
        workspace: resolvedWorkspace,
        createdAt: now(),
        schemaVersion: 1,
      };
      const prompts = (systemPrompt as string[] | undefined) ?? [];
      const entries: QueueEntryInput[] = prompts.map((text) => ({
        kind: "agent",
        role: "system",
        source: "create",
        content: [{ type: "text", text }],
      }));

      return deps.concurrency.runExclusive(sessionId, async () => {
        const runtime = createRuntime(meta, false);
        runtimes.set(sessionId, runtime);
        try {
          runtime.context.enqueue(entries);
        } catch (error) {
          runtimes.delete(sessionId);
          throw error;
        }
        return meta;
      });
    },

    async "session.read"(params): Promise<SessionReadResult> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const nodeId = params.nodeId;
      if (nodeId !== undefined && typeof nodeId !== "string") invalidRequest();
      const cursor = params.cursor;
      if (cursor !== undefined && typeof cursor !== "string") invalidRequest();
      const limit = params.limit;
      if (
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
      )
        invalidRequest();
      const id = sessionId as SessionId;

      return deps.concurrency.runExclusive(id, async () => {
        const runtime = await runtimeFor(id);
        await runtime.context.initialize();
        const target = nodeId as NodeId | undefined;
        if (target !== undefined && !runtime.persisted)
          throw new PiscesError("session.node_not_found", "Node not in session");
        const records = !runtime.persisted
          ? []
          : await collect(
              target === undefined
                ? runtime.sessions.readTree(id)
                : runtime.sessions.readBranch(id, target),
            );
        let start = 0;
        if (cursor !== undefined) {
          const index = records.findIndex((node) => node.id === cursor);
          if (index === -1) throw new PiscesError("session.node_not_found", "Node not in session");
          start = index + 1;
        }
        const page: SessionNode[] = [];
        let bytes = 0;
        for (let index = start; index < records.length; index++) {
          const node = records[index] as SessionNode;
          const size = ENCODER.encode(JSON.stringify(node)).length;
          if (limit !== undefined && page.length > 0 && bytes + size > limit) break;
          page.push(node);
          bytes += size;
        }
        const snapshot = runtime.context.snapshot();
        const first = cursor === undefined;
        return {
          meta: runtime.meta,
          seq: snapshot.seq,
          records: page,
          queue: first ? snapshot.queue : [],
          selection: first ? await runtime.context.selectionFor(target) : [],
          ...(start + page.length < records.length
            ? { nextCursor: (page.at(-1) as SessionNode).id }
            : {}),
        };
      });
    },

    async "queue.enqueue"(params): Promise<QueueEnqueueResult> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const entries = params.entries;
      if (!Array.isArray(entries)) invalidRequest();
      const id = sessionId as SessionId;

      return deps.concurrency.runExclusive(id, async () => {
        const runtime = await runtimeFor(id);
        await runtime.context.initialize();
        if (entries.some((entry) => isRecord(entry) && entry.kind === "control"))
          throw new PiscesError("queue.invalid_control", "Invalid queue entry");
        return { ids: runtime.context.enqueue(entries as QueueEntryInput[]) };
      });
    },
  };

  // Installed once per Gateway; turn-lifecycle routing is added with the turn routes.
  const handler = (event: EngineEvent): void => {
    if (event.sessionId === undefined) return;
  };
  deps.events.subscribe(handler);

  return {
    async handle(request) {
      if (!isRecord(request.params))
        return {
          id: request.id,
          error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
        };

      const route = handlers[request.method];
      if (!route)
        return {
          id: request.id,
          error: { code: "protocol.unknown_method", message: "Unknown protocol method" },
        };

      try {
        return { id: request.id, result: (await route(request.params)) as JsonValue };
      } catch (error) {
        if (error instanceof PiscesError)
          return { id: request.id, error: { code: error.code, message: error.message } };
        return {
          id: request.id,
          error: { code: "internal.error", message: "Internal error" },
        };
      }
    },
  };
}

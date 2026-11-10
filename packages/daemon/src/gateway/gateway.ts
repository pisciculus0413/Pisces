import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type AgentLoopDriver,
  type ContentBlock,
  type Context,
  type ContextEntries,
  type ContextSourceRegistry,
  createAgentLoopDriver,
  createContext,
  createSessions,
  createTools,
  type EngineEvent,
  type EntryName,
  type EventBus,
  type Exec,
  type JsonValue,
  type NodeId,
  PiscesError,
  type ProviderManagement,
  type QueueEntryId,
  type QueueEntryInput,
  type RunTurnInput,
  type SessionEventClock,
  type SessionId,
  type SessionMeta,
  type SessionNode,
  type Sessions,
  type Skills,
  type TemplatePreview,
  type Tools,
  type TurnId,
  type WorkspaceAccess,
} from "@pisces/core";
import type { ProtocolEvent } from "@pisces/protocol";
import { MAX_RESPONSE_BYTES } from "@pisces/protocol";
import { createExecHost } from "../exec/exec-host.js";
import type { ExtensionBinding, Extensions } from "../extensions/types.js";
import type { ProviderHost } from "../provider/provider-host.js";
import type { Concurrency } from "../runtime/concurrency.js";
import { createSessionEventClock } from "../runtime/event-clock.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { TemplateDefaults, TemplateStore } from "../templates/store.js";
import { createWorkspaceAccess } from "../workspace/access.js";
import type { ActiveTurnStore } from "./active-turn.js";
import {
  enrichForBinding,
  extensionDefaultWorkspace,
  initialDeclarationEntries,
  prepareExtensionSession,
  preparePersistedBinding,
  resolvedModelPair,
} from "./extension-session.js";
import { extensionSnapshot } from "./extension-view.js";
import type {
  EntriesSnapshotResult,
  GatewayRequest,
  GatewayResponse,
  ModelInfo,
  ProviderInfo,
  ProviderListResult,
  QueueClearResult,
  QueueEditResult,
  QueueEnqueueResult,
  QueueRemoveResult,
  SessionDefaults,
  SessionReadResult,
  TemplateApplyResult,
  TemplateListResult,
  TurnListResult,
  TurnStartResult,
} from "./protocol.js";
import { CREATE_ENTRY_SOURCE, TEMPLATE_ENTRY_SOURCE } from "./protocol.js";

export interface GatewayDeps {
  store: SessionStore;
  providers: ProviderManagement;
  providerHost: ProviderHost;
  concurrency: Concurrency;
  events: EventBus;
  markers: ActiveTurnStore;
  /** Configuration-driven mode; mutually exclusive with the manual injections below. */
  extensions?: Extensions;
  /** Declarative templates; absent means every `template.*` method is unknown. */
  templates?: Templates;
  defaults?: SessionDefaults;
  createTools?: () => Tools;
  entries?: ContextEntries;
  skills?: Skills;
  sources?: ContextSourceRegistry;
  validateWorkspace?: (workspace: string) => Promise<boolean>;
  /** Test seam: overrides the daemon-wide exec host. */
  exec?: Exec;
  /** Test seam: overrides the workspace access factory. */
  createWorkspaceAccess?: (workspace: string) => WorkspaceAccess;
  newSessionId?: () => SessionId;
  newTurnId?: () => TurnId;
  newQueueEntryId?: () => QueueEntryId;
  newNodeId?: () => NodeId;
  now?: () => string;
}

export interface Gateway {
  handle(request: GatewayRequest, connectionId?: string): Promise<GatewayResponse>;
  attach(connectionId: string, enqueue: (event: ProtocolEvent) => void): void;
  detach(connectionId: string): void;
  dispose(): void;
}

/** The narrow template surface the Gateway needs; the store owns every side effect. */
export type Templates = Pick<TemplateStore, "list" | "preview" | "inspect" | "resolve" | "apply">;

/** One new session after template and host defaults are layered under explicit values. */
interface SessionSpec {
  workspace?: string;
  provider?: string;
  model?: string;
  extensions?: EntryName[];
  /** Final prompt list; an explicit prompt list already suppresses the template prompt. */
  prompts: Prompt[];
}

/** One host-created prompt with the provenance recorded on its queue entry. */
interface Prompt {
  text: string;
  source: string;
}

/** A fully validated session: turning it into a runtime performs no further validation. */
interface NewSession {
  workspace: string;
  provider: string;
  model: string;
  prompts: Prompt[];
  binding?: ExtensionBinding;
  initial?: QueueEntryInput[];
}

interface SessionParams {
  workspace?: string;
  provider?: string;
  model?: string;
  extensions?: EntryName[];
  systemPrompt?: string[];
}

function promptsFor(explicit: string[] | undefined, templatePrompt: string | undefined): Prompt[] {
  // Explicit prompts are user-supplied and keep the create provenance; a template prompt is
  // marked with its own source so the wire tells the two apart.
  if (explicit !== undefined)
    return explicit.map((text) => ({ text, source: CREATE_ENTRY_SOURCE }));
  if (templatePrompt === undefined) return [];
  return [{ text: templatePrompt, source: TEMPLATE_ENTRY_SOURCE }];
}

/** Template defaults sit under explicit request values but over host defaults. */
function sessionSpec(params: SessionParams, template?: TemplateDefaults): SessionSpec {
  const provider = params.provider ?? template?.provider;
  const model = params.model ?? template?.model;
  const extensions = params.extensions ?? (template?.extensions as EntryName[] | undefined);
  return {
    ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(extensions === undefined ? {} : { extensions }),
    prompts: promptsFor(params.systemPrompt, template?.systemPrompt),
  };
}

interface Connection {
  enqueue: (event: ProtocolEvent) => void;
  subscriptions: Set<SessionId>;
}

interface PendingMarker {
  turnId: TurnId;
  startedAt: string;
}

type TurnPhase = "running" | "cleanup" | "cleanup_failed";

/** One per session for the process lifetime; never evicted or re-created. */
interface SessionRuntime {
  meta: SessionMeta;
  persisted: boolean;
  context: Context;
  sessions: Sessions;
  driver: AgentLoopDriver;
  eventClock: SessionEventClock;
  pendingMarker?: PendingMarker;
  phase?: TurnPhase;
  /** Frozen per-session view; absent only in the legacy manual-injection mode. */
  binding?: ExtensionBinding;
  /** Branch and commit offset this turn started from; used to validate steer before appending. */
  turnStart?: { nodeId?: NodeId; offset: number };
  /** Canonical-workspace access, resolved lazily and cached per runtime. */
  files?: WorkspaceAccess;
  /** Runtime-local only; a failing cancel handle is never rethrown or exported. */
  cancelHandleError?: unknown;
}

const EMPTY_ENTRIES: ContextEntries = { kind: () => undefined };
const EMPTY_SKILLS: Skills = { selected: () => [] };
const EMPTY_SOURCES: ContextSourceRegistry = { get: () => undefined };
// One process-wide exec host; `deps.exec` exists only as a test seam.
const daemonExec: Exec = createExecHost();
const ENTRY_NAME = /^[^#\s]+#[^#\s]+$/u;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
// Turn ids use the same permitted ASCII set as session ids.
const TURN_ID = SESSION_ID;
const CLEANUP_FAILED_CODE = "storage.io";
const CLEANUP_FAILED_MESSAGE = "Active turn marker could not be removed";
const RESPONSE_TOO_LARGE_MESSAGE = "Response exceeds the size limit";
const ACTIVE_TURN_MESSAGE = "A turn is active for this session";
// Only client-meaningful turn failure codes are allowed on the wire, each with its own
// fixed safe message; every other code is replaced so raw adapter/upstream details never leak.
const TURN_ENDED_ERROR_MESSAGES: Record<string, string> = {
  "turn.empty": "Context has no visible messages",
};
const TURN_ENDED_FALLBACK_CODE = "internal.error";
const TURN_ENDED_FALLBACK_MESSAGE = "Turn failed";
const ROUTING_KEYS = new Set(["sessionId", "seq", "at"]);
const ENCODER = new TextEncoder();
const SESSION_EVENT_TYPES = new Set([
  "session.updated",
  "queue.updated",
  "selection.updated",
  "turn.started",
  "turn.delta",
  "turn.step",
  "turn.ended",
  "turn.cleanup_failed",
]);

function projectSessionEvent(event: EngineEvent): ProtocolEvent | undefined {
  if (!SESSION_EVENT_TYPES.has(event.type)) return undefined;
  if (event.sessionId === undefined || typeof event.seq !== "number") return undefined;
  if (typeof event.at !== "string") return undefined;
  if (event.data === null || typeof event.data !== "object" || Array.isArray(event.data))
    return undefined;
  const payload = event.data as { [key: string]: JsonValue };

  if (event.type === "turn.cleanup_failed") {
    const turnId = payload.turnId;
    if (typeof turnId !== "string" || !TURN_ID.test(turnId)) return undefined;
    // Never copy untrusted cleanup details such as a raw cause or arbitrary code/message.
    return {
      event: event.type,
      data: {
        sessionId: event.sessionId,
        seq: event.seq,
        at: event.at,
        turnId,
        code: CLEANUP_FAILED_CODE,
        message: CLEANUP_FAILED_MESSAGE,
      },
    };
  }

  if (event.type === "turn.ended") {
    const turnId = payload.turnId;
    if (typeof turnId !== "string" || !TURN_ID.test(turnId)) return undefined;
    const reason = payload.reason;
    if (reason !== "completed" && reason !== "cancelled" && reason !== "failed") return undefined;
    const endedAt = payload.endedAt;
    if (typeof endedAt !== "string") return undefined;
    const data: { [key: string]: JsonValue } = {
      sessionId: event.sessionId,
      seq: event.seq,
      at: event.at,
      turnId,
      reason,
      endedAt,
    };
    if (reason === "failed") {
      // Never copy the raw code, message, cause or extra fields: the adapter controls them.
      const error = payload.error;
      const requested = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      const code =
        requested !== undefined && Object.hasOwn(TURN_ENDED_ERROR_MESSAGES, requested)
          ? requested
          : TURN_ENDED_FALLBACK_CODE;
      data.error = {
        code,
        message: TURN_ENDED_ERROR_MESSAGES[code] ?? TURN_ENDED_FALLBACK_MESSAGE,
      };
    }
    return { event: event.type, data };
  }

  // Routing metadata is authoritative: payload copies of these keys are discarded.
  const safePayload: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(payload)) {
    if (ROUTING_KEYS.has(key)) continue;
    safePayload[key] = value;
  }
  return {
    event: event.type,
    data: {
      sessionId: event.sessionId,
      seq: event.seq,
      at: event.at,
      ...safePayload,
    },
  };
}

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
  // Configuration-driven and manual-injection modes never merge: mixing them is a
  // startup failure, not an implicit precedence rule.
  if (
    deps.extensions !== undefined &&
    (deps.defaults !== undefined ||
      deps.createTools !== undefined ||
      deps.entries !== undefined ||
      deps.skills !== undefined ||
      deps.sources !== undefined)
  )
    throw new PiscesError("daemon.start_failed", "Invalid gateway configuration");
  const now = deps.now ?? (() => new Date().toISOString());
  const newNodeId = deps.newNodeId ?? (() => randomUUID() as NodeId);
  const newQueueEntryId = deps.newQueueEntryId ?? (() => randomUUID() as QueueEntryId);
  const newSessionId = deps.newSessionId ?? (() => randomUUID() as SessionId);
  const newTurnId = deps.newTurnId ?? (() => randomUUID() as TurnId);
  const validateWorkspace = deps.validateWorkspace ?? defaultValidateWorkspace;
  const templateService = deps.templates;
  const baseSessions = createSessions({ repository: deps.store, newId: newNodeId, now });
  const runtimes = new Map<SessionId, SessionRuntime>();
  const connections = new Map<string, Connection>();

  function createRuntime(
    meta: SessionMeta,
    persisted: boolean,
    binding?: ExtensionBinding,
  ): SessionRuntime {
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
      entries: binding?.entries ?? deps.entries ?? EMPTY_ENTRIES,
      skills: binding?.skills ?? deps.skills ?? EMPTY_SKILLS,
      sources: binding?.sources ?? deps.sources ?? EMPTY_SOURCES,
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

    runtime = {
      meta,
      persisted,
      context,
      sessions,
      driver,
      eventClock,
      ...(binding === undefined ? {} : { binding }),
    };
    return runtime;
  }

  async function runtimeFor(sessionId: SessionId): Promise<SessionRuntime> {
    const existing = runtimes.get(sessionId);
    if (existing) return existing;
    const meta = await deps.store.getMeta(sessionId);
    // Callers hold the session lock: this is file I/O only, never plugin loading, and a
    // failed prepare caches no half-built runtime. Persisted meta is never rewritten.
    const binding =
      deps.extensions === undefined
        ? undefined
        : await preparePersistedBinding(deps.extensions, meta.workspace);
    const runtime = createRuntime(meta, true, binding);
    runtimes.set(sessionId, runtime);
    return runtime;
  }

  /** Absent configuration keeps the existing `protocol.unknown_method` answer. */
  function templateStore(): Templates {
    if (templateService === undefined)
      throw new PiscesError("protocol.unknown_method", "Unknown protocol method");
    return templateService;
  }

  /**
   * The single session-creation path shared by `session.create` and `template.apply`.
   * Every caller passes an already validated `NewSession`; nothing here re-validates, so
   * `template.apply` can run all preflight checks before the store writes anything.
   */
  function createSessionFrom(input: NewSession): Promise<SessionMeta> {
    const sessionId = newSessionId();
    const meta: SessionMeta = {
      id: sessionId,
      model: input.model,
      provider: input.provider,
      workspace: input.workspace,
      createdAt: now(),
      schemaVersion: 1,
    };
    const entries: QueueEntryInput[] = input.prompts.map((prompt) => ({
      kind: "agent",
      role: "system",
      source: prompt.source,
      content: [{ type: "text", text: prompt.text }],
    }));
    if (input.initial !== undefined) entries.push(...input.initial);
    return deps.concurrency.runExclusive(sessionId, async () => {
      const runtime = createRuntime(meta, false, input.binding);
      runtimes.set(sessionId, runtime);
      try {
        // Prompts and the single declaration enter the queue in one atomic call.
        runtime.context.enqueue(entries);
      } catch (error) {
        runtimes.delete(sessionId);
        throw error;
      }
      return structuredClone(meta);
    });
  }

  /** Validates a configured-mode session and freezes its binding; creates nothing. */
  async function prepareConfiguredSession(
    extensions: Extensions,
    spec: SessionSpec,
  ): Promise<NewSession> {
    const prepared = await prepareExtensionSession(
      extensions,
      {
        ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
        ...(spec.provider === undefined ? {} : { provider: spec.provider }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
      },
      validateWorkspace,
    );
    const { provider, model } = resolvedModelPair(prepared);
    if (!deps.providers.select(provider, model))
      throw new PiscesError("session.invalid_model", "Invalid model");
    // Enrichment is pure and runs before the runtime exists: a failure leaves no session.
    return {
      workspace: prepared.workspace,
      provider,
      model,
      prompts: spec.prompts,
      binding: prepared.binding,
      initial: initialDeclarationEntries(prepared.binding, prepared.extensions),
    };
  }

  /** Validates a manual-mode session from explicit values and host defaults; creates nothing. */
  async function prepareManualSession(spec: SessionSpec): Promise<NewSession> {
    const workspace = spec.workspace ?? deps.defaults?.workspace;
    if (workspace === undefined)
      throw new PiscesError("session.workspace_required", "Workspace is required");
    if (!(await validateWorkspace(workspace)))
      throw new PiscesError("session.invalid_workspace", "Invalid workspace");

    const provider = spec.provider ?? deps.defaults?.provider;
    const model = spec.model ?? deps.defaults?.model;
    if (provider === undefined || model === undefined)
      throw new PiscesError("session.model_required", "Provider and model are required");
    if (!deps.providers.select(provider, model))
      throw new PiscesError("session.invalid_model", "Invalid model");

    const extensions = (spec.extensions ?? deps.defaults?.extensions ?? []) as EntryName[];
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

    return { workspace, provider, model, prompts: spec.prompts };
  }

  /** The one session-validation branch; both callers create nothing until it succeeds. */
  function prepareSession(spec: SessionSpec): Promise<NewSession> {
    if (deps.extensions !== undefined) return prepareConfiguredSession(deps.extensions, spec);
    return prepareManualSession(spec);
  }

  function hasCancel(nodes: SessionNode[], turnId: TurnId): boolean {
    for (const node of nodes) {
      if (node.kind !== "control" || node.role !== "cancel") continue;
      const block = node.content[0];
      if (block?.type !== "text") continue;
      try {
        const value: unknown = JSON.parse(block.text);
        if (isRecord(value) && value.turnId === turnId) return true;
      } catch {
        // A malformed cancel payload does not match any turn.
      }
    }
    return false;
  }

  async function finishCleanup(
    sessionId: SessionId,
    turnId: TurnId,
    runtime: SessionRuntime,
  ): Promise<void> {
    await deps.concurrency.runExclusive(sessionId, async () => {
      deps.concurrency.unregisterTurn(sessionId, turnId);
      delete runtime.phase;
      delete runtime.turnStart;
    });
  }

  async function handleCleanupFailure(
    runtime: SessionRuntime,
    sessionId: SessionId,
    turnId: TurnId,
  ): Promise<void> {
    let appended = true;
    await deps.concurrency.runExclusive(sessionId, async () => {
      const event: EngineEvent = {
        type: "turn.cleanup_failed",
        sessionId,
        seq: runtime.eventClock.next(),
        at: now(),
        data: {
          turnId,
          code: CLEANUP_FAILED_CODE,
          message: CLEANUP_FAILED_MESSAGE,
        },
      };
      try {
        deps.events.publish(structuredClone(event));
      } catch {
        // Publication failures must not abort cleanup.
      }
      try {
        const branch = await collect(runtime.sessions.readBranch(sessionId));
        const last = branch.at(-1);
        if (last !== undefined && !hasCancel(branch, turnId)) {
          await runtime.sessions.append(
            sessionId,
            [
              {
                kind: "control",
                role: "cancel",
                source: "driver",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ turnId, reason: "cleanup_failed", at: last.id }),
                  },
                ],
              },
            ],
            last.id,
          );
        }
      } catch {
        appended = false;
        runtime.phase = "cleanup_failed";
      }
    });
    if (!appended) return;
    try {
      await deps.markers.remove(sessionId, turnId);
    } catch {
      await deps.concurrency.runExclusive(sessionId, async () => {
        runtime.phase = "cleanup_failed";
      });
      return;
    }
    await finishCleanup(sessionId, turnId, runtime);
  }

  async function launch(
    input: RunTurnInput,
    runtime: SessionRuntime,
    sessionId: SessionId,
    turnId: TurnId,
  ): Promise<void> {
    try {
      try {
        await runtime.driver.run(input);
      } catch {
        // The driver publishes its own terminal state; cleanup still runs.
      } finally {
        delete runtime.pendingMarker;
        await deps.concurrency.runExclusive(sessionId, async () => {
          if (runtime.phase === "running") runtime.phase = "cleanup";
        });
      }
      try {
        await deps.markers.remove(sessionId, turnId);
      } catch {
        await handleCleanupFailure(runtime, sessionId, turnId);
        return;
      }
      await finishCleanup(sessionId, turnId, runtime);
    } catch {
      // Detached cleanup must not reject: state stays observable via events and markers.
    }
  }

  type Route = (params: Record<string, unknown>, connection?: Connection) => Promise<unknown>;

  const handlers: Record<string, Route> = {
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

    async "template.list"(): Promise<TemplateListResult> {
      return { templates: await templateStore().list() };
    },

    async "template.preview"(params): Promise<TemplatePreview> {
      const templates = templateStore();
      const templateId = params.templateId;
      if (typeof templateId !== "string" || templateId.length === 0) invalidRequest();
      const workspace = params.workspace;
      if (typeof workspace !== "string" || workspace.length === 0) invalidRequest();
      return templates.preview(templateId, workspace);
    },

    async "template.apply"(params): Promise<TemplateApplyResult> {
      const templates = templateStore();
      const templateId = params.templateId;
      if (typeof templateId !== "string" || templateId.length === 0) invalidRequest();
      const workspace = params.workspace;
      if (typeof workspace !== "string" || workspace.length === 0) invalidRequest();
      const overwrite = params.overwrite;
      if (overwrite !== undefined && typeof overwrite !== "boolean") invalidRequest();
      // Confirmation is checked before any store call: a refused apply must write nothing.
      if (params.confirmed !== true) invalidRequest();

      // Preflight: `inspect` writes nothing and never reads the prompt file, so every
      // session-configuration failure happens before the first file or directory exists.
      const plan = await templates.inspect(templateId, workspace);
      await prepareSession(sessionSpec({ workspace }, plan.defaults));

      const resolution = await templates.apply(templateId, workspace, {
        confirmed: true,
        ...(overwrite === undefined ? {} : { overwrite }),
      });
      // The session takes provider/model/extensions/systemPrompt from apply's resolution:
      // only its post-write read can see a prompt file the template itself created. The
      // workspace stays the preflight one, since template defaults never carry a workspace.
      const meta = await createSessionFrom(
        await prepareSession(sessionSpec({ workspace }, resolution.defaults)),
      );
      return { projectId: resolution.projectId, sessionId: meta.id };
    },

    async "session.create"(params): Promise<SessionMeta> {
      const workspace = params.workspace;
      if (workspace !== undefined && typeof workspace !== "string") invalidRequest();
      const templateId = params.templateId;
      if (templateId !== undefined && (typeof templateId !== "string" || templateId.length === 0))
        invalidRequest();
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

      // Without a template store the existing rejection stands, before any store access.
      if (templateId !== undefined && templateService === undefined) invalidRequest();

      // A template contributes defaults beneath the explicit request. Resolving it reads the
      // prompt file and never writes; the workspace must already be valid when it happens.
      let template: TemplateDefaults | undefined;
      if (templateId !== undefined && templateService !== undefined) {
        // Configured mode falls back to the extension global workspace, exactly as the same
        // request without a template does; manual mode keeps the host-default fallback.
        const resolvedWorkspace =
          workspace ??
          (deps.extensions === undefined
            ? deps.defaults?.workspace
            : await extensionDefaultWorkspace(deps.extensions));
        if (resolvedWorkspace === undefined)
          throw new PiscesError("session.workspace_required", "Workspace is required");
        if (!(await validateWorkspace(resolvedWorkspace)))
          throw new PiscesError("session.invalid_workspace", "Invalid workspace");
        template = (await templateService.resolve(templateId, resolvedWorkspace)).defaults;
      }

      const spec = sessionSpec(
        {
          ...(workspace === undefined ? {} : { workspace }),
          ...(explicitProvider === undefined ? {} : { provider: explicitProvider }),
          ...(explicitModel === undefined ? {} : { model: explicitModel }),
          ...(explicitExtensions === undefined
            ? {}
            : { extensions: explicitExtensions as EntryName[] }),
          ...(systemPrompt === undefined ? {} : { systemPrompt: systemPrompt as string[] }),
        },
        template,
      );

      return createSessionFrom(await prepareSession(spec));
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
          meta: structuredClone(runtime.meta),
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

    async "session.configure"(params): Promise<SessionMeta> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const model = params.model;
      if (model !== undefined && typeof model !== "string") invalidRequest();
      const provider = params.provider;
      if (provider !== undefined && typeof provider !== "string") invalidRequest();
      const systemPrompt = params.systemPrompt;
      if (systemPrompt !== undefined && typeof systemPrompt !== "string") invalidRequest();
      const id = sessionId as SessionId;

      return deps.concurrency.runExclusive(id, async () => {
        const runtime = await runtimeFor(id);
        // Reject the whole configuration before mutating meta, queue, or records.
        if (deps.concurrency.activeTurn(id) !== undefined)
          throw new PiscesError("turn.active", ACTIVE_TURN_MESSAGE);
        const hasModel = model !== undefined;
        const hasProvider = provider !== undefined;
        if (hasModel !== hasProvider)
          throw new PiscesError("session.model_required", "Provider and model are required");
        if (hasModel && !deps.providers.select(provider as string, model as string))
          throw new PiscesError("session.invalid_model", "Invalid model");

        if (hasModel) {
          const meta = { ...runtime.meta, model: model as string, provider: provider as string };
          // Persist first so a storage failure leaves memory untouched.
          if (runtime.persisted) await deps.store.updateMeta(id, meta);
          runtime.context.updateMeta(meta);
          runtime.meta = meta;
        }

        if (systemPrompt !== undefined) {
          const queue = runtime.context.snapshot().queue;
          const existing = queue.findLast(
            (entry) =>
              entry.kind === "agent" &&
              entry.role === "system" &&
              entry.source === "instruction" &&
              entry.confirmedAt === undefined,
          );
          const content: ContentBlock[] = [{ type: "text", text: systemPrompt }];
          if (existing) runtime.context.edit(existing.id, content);
          else
            runtime.context.enqueue([
              { kind: "agent", role: "system", source: "instruction", content },
            ]);
        }

        return structuredClone(runtime.meta);
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
        const inputs = entries as QueueEntryInput[];
        const hasControl = inputs.some((entry) => isRecord(entry) && entry.kind === "control");
        if (!hasControl) return { ids: runtime.context.enqueue(inputs) };
        // Without a frozen binding the legacy rule stands: no client controls at all.
        const binding = runtime.binding;
        if (binding === undefined)
          throw new PiscesError("queue.invalid_control", "Invalid queue entry");
        // Resolve, replay and enrich the whole batch before one enqueue; errors change nothing.
        const view = await runtime.context.viewFor();
        const pending = runtime.context
          .snapshot()
          .queue.filter((entry) => entry.confirmedAt === undefined);
        const enriched = enrichForBinding(binding, view, pending, inputs);
        return { ids: runtime.context.enqueue(enriched) };
      });
    },

    async "entries.snapshot"(params): Promise<EntriesSnapshotResult> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const id = sessionId as SessionId;
      return deps.concurrency.runExclusive(id, async () => {
        const runtime = await runtimeFor(id);
        await runtime.context.initialize();
        // Pure branch replay: no queued toggle, no extension code, no source resolution.
        const view = await runtime.context.viewFor();
        return extensionSnapshot(runtime.binding, view);
      });
    },

    async "queue.edit"(params): Promise<QueueEditResult> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const entryId = params.id;
      if (typeof entryId !== "string") invalidRequest();
      const content = params.content;
      if (!Array.isArray(content)) invalidRequest();
      const id = sessionId as SessionId;
      return deps.concurrency.runExclusive(id, async () => {
        const runtime = await runtimeFor(id);
        await runtime.context.initialize();
        // Core owns the single client-visible change: content/size checks and one queue.updated.
        runtime.context.edit(entryId as QueueEntryId, content as ContentBlock[]);
        return { id: entryId as QueueEntryId };
      });
    },

    async "queue.remove"(params): Promise<QueueRemoveResult> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const entryId = params.id;
      if (typeof entryId !== "string") invalidRequest();
      const id = sessionId as SessionId;
      return deps.concurrency.runExclusive(id, async () => {
        const runtime = await runtimeFor(id);
        await runtime.context.initialize();
        runtime.context.remove(entryId as QueueEntryId);
        return { id: entryId as QueueEntryId };
      });
    },

    async "queue.clear"(params): Promise<QueueClearResult> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const id = sessionId as SessionId;
      return deps.concurrency.runExclusive(id, async () => {
        // A registered turn (running, cleanup or failed cleanup) rejects the whole request.
        if (deps.concurrency.activeTurn(id) !== undefined)
          throw new PiscesError("turn.active", ACTIVE_TURN_MESSAGE);
        const runtime = await runtimeFor(id);
        await runtime.context.initialize();
        return { ids: runtime.context.clear() };
      });
    },

    async "turn.start"(params): Promise<TurnStartResult> {
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const nodeId = params.nodeId;
      if (nodeId !== undefined && typeof nodeId !== "string") invalidRequest();
      const id = sessionId as SessionId;
      const target = nodeId as NodeId | undefined;

      const outcome = await deps.concurrency.runExclusive(
        id,
        async (): Promise<
          | { input: RunTurnInput; runtime: SessionRuntime; turnId: TurnId }
          | { steer: TurnStartResult }
        > => {
          const active = deps.concurrency.activeTurn(id);
          if (active !== undefined) {
            const runtime = runtimes.get(id);
            if (runtime?.phase !== "running")
              throw new PiscesError("turn.active", "Previous turn is still finalizing");
            if (target !== undefined)
              throw new PiscesError(
                "turn.node_id_forbidden",
                "Cannot select a node while steering",
              );
            // Reconcile any pending commit, then validate the branch this turn actually
            // executes: the original start branch until the turn appends, then the latest
            // committed branch. Validation precedes confirmation and never changes state.
            await runtime.context.initialize();
            const start = runtime.turnStart;
            let offset = 0;
            if (runtime.persisted) offset = await deps.store.commitOffset(id);
            const branch = start !== undefined && offset > start.offset ? undefined : start?.nodeId;
            await runtime.context.validateQueue(branch);
            runtime.context.confirm();
            return { steer: { turnId: active, mode: "steer" } };
          }

          const runtime = await runtimeFor(id);
          if (target !== undefined && !runtime.persisted)
            throw new PiscesError("session.node_not_found", "Node not in session");
          // Reconcile any pending commit first (as steer does), so the recorded start offset cannot
          // be a value that a reconciled commit already advanced past.
          await runtime.context.initialize();
          const selection = deps.providers.select(runtime.meta.provider, runtime.meta.model);
          if (!selection) throw new PiscesError("session.invalid_model", "Invalid model");
          const adapter = deps.providers.createAdapter(runtime.meta.provider);
          const execute = deps.providerHost.execute(runtime.meta.provider);

          let startOffset = 0;
          let startNodeId = target;
          if (runtime.persisted) {
            startOffset = await deps.store.commitOffset(id);
            if (startNodeId === undefined) {
              try {
                for await (const node of runtime.sessions.readBranch(id)) startNodeId = node.id;
              } catch (error) {
                if (!(error instanceof PiscesError) || error.code !== "session.node_not_found")
                  throw error;
              }
            } else {
              // Reading the branch validates the requested node before any marker is written.
              for await (const node of runtime.sessions.readBranch(id, startNodeId)) void node;
            }
          }

          const turnId = newTurnId();
          const startedAt = now();
          try {
            // Validate every unconfirmed declaration against the exact branch this turn will
            // append to, before the marker, confirmation, or turn registration exist.
            await runtime.context.validateQueue(startNodeId);
            if (runtime.persisted)
              await deps.markers.write(id, {
                turnId,
                startedAt,
                startOffset,
                ...(startNodeId !== undefined ? { startNodeId } : {}),
              });
            runtime.context.confirm();
            if (!runtime.persisted) runtime.pendingMarker = { turnId, startedAt };
            const controller = new AbortController();
            const cancel = (): void => {
              try {
                controller.abort(new DOMException("Turn cancelled", "AbortError"));
              } catch (error) {
                runtime.cancelHandleError = error;
              }
            };
            deps.concurrency.registerTurn(id, turnId, startedAt, cancel);
            runtime.phase = "running";
            runtime.turnStart = {
              ...(startNodeId !== undefined ? { nodeId: startNodeId } : {}),
              offset: startOffset,
            };
            // Capabilities are best effort: a vanished workspace must not fail the turn, so
            // tools simply see no files access and retry on a later turn.
            if (runtime.files === undefined) {
              try {
                const root = await realpath(runtime.meta.workspace);
                runtime.files = (deps.createWorkspaceAccess ?? createWorkspaceAccess)(root);
              } catch {
                // Leave `files` absent; never surfaces as session.invalid_workspace or storage.io.
              }
            }
            const files = runtime.files;
            const input: RunTurnInput = {
              sessionId: id,
              turnId,
              meta: runtime.meta,
              context: runtime.context,
              sessions: runtime.sessions,
              tools: runtime.binding?.tools ?? deps.createTools?.() ?? createTools(),
              adapter,
              execute,
              events: deps.events,
              eventClock: runtime.eventClock,
              contextWindow: selection.model.contextWindow,
              maxOutput: selection.model.maxOutput,
              ...(startNodeId !== undefined ? { nodeId: startNodeId } : {}),
              signal: controller.signal,
              ...(files === undefined ? {} : { files }),
              exec: deps.exec ?? daemonExec,
            };
            return { input, runtime, turnId };
          } catch (error) {
            delete runtime.pendingMarker;
            delete runtime.turnStart;
            if (runtime.persisted) {
              try {
                await deps.markers.remove(id, turnId);
              } catch {
                // Best effort: the turn never started, so its marker must not linger.
              }
            }
            throw error;
          }
        },
      );

      if ("steer" in outcome) return outcome.steer;
      void launch(outcome.input, outcome.runtime, id, outcome.turnId).catch(() => undefined);
      return { turnId: outcome.turnId, mode: "new" };
    },

    async "turn.list"(): Promise<TurnListResult> {
      return { turns: deps.concurrency.activeTurns() };
    },

    async "turn.cancel"(params): Promise<{ cancelled: boolean }> {
      const turnId = params.turnId;
      if (typeof turnId !== "string" || !turnId.length) invalidRequest();
      const active = deps.concurrency.activeTurns().find((turn) => turn.turnId === turnId);
      if (active === undefined) return { cancelled: false };
      const runtime = runtimes.get(active.sessionId);
      if (runtime === undefined || runtime.phase !== "running") return { cancelled: false };
      return { cancelled: deps.concurrency.cancelTurn(turnId as TurnId) };
    },
  };

  const connectionHandlers: Record<string, Route> = {
    async "session.subscribe"(params, connection) {
      if (connection === undefined)
        throw new PiscesError("internal.error", "Connection is not attached");
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const id = sessionId as SessionId;
      return deps.concurrency.runExclusive(id, async () => {
        await runtimeFor(id);
        // Installed under the session lock so events cannot be published between validation
        // and subscription.
        connection.subscriptions.add(id);
        return { sessionId: id };
      });
    },

    async "session.unsubscribe"(params, connection) {
      if (connection === undefined)
        throw new PiscesError("internal.error", "Connection is not attached");
      const sessionId = params.sessionId;
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) invalidRequest();
      const id = sessionId as SessionId;
      connection.subscriptions.delete(id);
      return { sessionId: id };
    },
  };

  // Installed once per Gateway. `turn.ended` moves the runtime to cleanup without unregistering;
  // marker deletion and unregistration stay in `launch`.
  const handler = (event: EngineEvent): void => {
    if (event.type === "turn.ended" && event.sessionId !== undefined) {
      const runtime = runtimes.get(event.sessionId);
      if (runtime !== undefined) {
        const turnId = isRecord(event.data) ? event.data.turnId : undefined;
        if (typeof turnId === "string" && deps.concurrency.activeTurn(event.sessionId) === turnId) {
          runtime.phase = "cleanup";
        }
      }
    }

    if (event.sessionId === undefined || !SESSION_EVENT_TYPES.has(event.type)) return;
    const targets: [string, Connection][] = [];
    for (const entry of connections) {
      if (entry[1].subscriptions.has(event.sessionId)) targets.push(entry);
    }
    if (targets.length === 0) return;
    let projected: ProtocolEvent | undefined;
    try {
      projected = projectSessionEvent(event);
    } catch {
      return;
    }
    if (projected === undefined) return;
    for (const [connectionId, connection] of targets) {
      try {
        connection.enqueue(projected);
      } catch {
        connections.delete(connectionId);
      }
    }
  };
  const unsubscribe = deps.events.subscribe(handler);

  return {
    attach(connectionId, enqueue) {
      connections.set(connectionId, { enqueue, subscriptions: new Set() });
    },

    detach(connectionId) {
      connections.delete(connectionId);
    },

    dispose() {
      unsubscribe();
      connections.clear();
    },

    async handle(request, connectionId) {
      if (!isRecord(request.params))
        return {
          id: request.id,
          error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
        };

      // Own properties only: inherited names such as "constructor" or "toString" must not route.
      const connection = connectionId === undefined ? undefined : connections.get(connectionId);
      let route: Route | undefined;
      if (connection !== undefined && Object.hasOwn(connectionHandlers, request.method))
        route = connectionHandlers[request.method];
      else if (Object.hasOwn(handlers, request.method)) route = handlers[request.method];
      if (route === undefined)
        return {
          id: request.id,
          error: { code: "protocol.unknown_method", message: "Unknown protocol method" },
        };

      try {
        const result = (await route(request.params, connection)) as JsonValue;
        // Pre-check the exact wire envelope (id included, UTF-8 bytes) so an oversized result
        // becomes a safe protocol error instead of a transport destroy on encode.
        if (ENCODER.encode(JSON.stringify({ id: request.id, result })).length > MAX_RESPONSE_BYTES)
          return {
            id: request.id,
            error: { code: "protocol.frame_too_large", message: RESPONSE_TOO_LARGE_MESSAGE },
          };
        return { id: request.id, result };
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

import type {
  ContentBlock,
  DefinitionSnapshot,
  EntryName,
  Message,
  SelectionState,
} from "../messages.js";
import type { NodeId, SessionId, SessionMeta, SessionNode, Sessions } from "../sessions/types.js";
import type { Brand, JsonObject, JsonValue } from "../types.js";

export type { SelectionState };

export type QueueEntryId = Brand<"QueueEntryId">;

export interface QueueEntry {
  id: QueueEntryId;
  kind: "agent" | "control";
  role: "system" | "user" | "assistant" | "tool" | "declaration";
  content: ContentBlock[];
  source: string;
  confirmedAt?: string;
  createdAt: string;
}

export type QueueEntryInput = Omit<QueueEntry, "id" | "createdAt" | "confirmedAt">;
export interface ContextSourceContext {
  sessionId: SessionId;
  workspace: string;
  signal?: AbortSignal;
}

export interface ContextSource {
  id: EntryName;
  resolve(context: ContextSourceContext): Promise<ContextFragment[]>;
}

export interface ContextFragment {
  source: string;
  content: ContentBlock[];
}

export interface ContextSourceRegistry {
  get(name: EntryName): ContextSource | undefined;
}

export interface SkillEntry {
  name: EntryName;
  source: string;
  content: ContentBlock[];
}

export interface Skills {
  selected(selection: SelectionState): SkillEntry[];
}

export type ContextEntryKind = "tool" | "wrapper" | "skill" | "context";

/** Classification from a frozen inventory; supplies no live tool definitions. */
export interface ContextEntries {
  kind(name: EntryName): ContextEntryKind | undefined;
  /** Pure synchronous hash comparison; absent for legacy manual injection. */
  matchesDefinition?(definition: DefinitionSnapshot): boolean;
}

export interface RequestToolDeclaration {
  name: EntryName;
  description: string;
  parameters: JsonObject;
}

export interface LlmRequest {
  model: string;
  messages: Message[];
  tools?: RequestToolDeclaration[];
  parameters?: JsonObject;
}

export interface ContextEvent {
  type: "queue.updated" | "selection.updated" | "session.updated";
  sessionId: SessionId;
  seq: number;
  at: string;
  data: JsonValue;
}

export interface ContextEvents {
  publish(event: ContextEvent): void;
}

/** Shared by Context, driver, and Gateway for one session. */
export interface SessionEventClock {
  /** Nonnegative safe integer; shared allocations increase monotonically. */
  current(): number;
  /** Allocate only while holding the session lock. */
  next(): number;
}

export interface ContextDeps {
  sessionId: SessionId;
  meta: SessionMeta;
  persisted: boolean;
  sessions: Sessions;
  entries: ContextEntries;
  skills: Skills;
  sources: ContextSourceRegistry;
  events: ContextEvents;
  eventClock: SessionEventClock;
  runExclusive<T>(task: () => Promise<T>): Promise<T>;
  newId: () => QueueEntryId;
  /** RFC3339 UTC timestamp with milliseconds, exactly 24 ASCII bytes. */
  now: () => string;
}

export interface ContextSnapshot {
  queue: QueueEntry[];
  selection: SelectionState;
  /** Read from the shared clock, not a separate Context counter. */
  seq: number;
}

export interface AssembleOptions {
  nodeId?: NodeId;
  contextWindow: number;
  maxOutput: number;
  signal?: AbortSignal;
}

export interface AssembledContext {
  request: LlmRequest;
  selection: SelectionState;
  /** Only nodes persisted by this batch. */
  nodes: SessionNode[];
  headId: NodeId;
  /** Whether the session was unpersisted at the start of this call. */
  first: boolean;
}

/** Call initialize, selectionFor, and every synchronous method under the session lock. */
export interface Context {
  /** Re-read the default branch on every call without discarding the in-memory queue. */
  initialize(): Promise<void>;
  snapshot(): ContextSnapshot;
  selectionFor(nodeId?: NodeId): Promise<SelectionState>;
  enqueue(entries: QueueEntryInput[]): QueueEntryId[];
  edit(id: QueueEntryId, content: ContentBlock[]): void;
  remove(id: QueueEntryId): void;
  clear(): QueueEntryId[];
  confirm(): void;
  unconfirm(): void;
  updateMeta(meta: SessionMeta): void;
  /** Acquires its own A/C locks and ensures initialization in A; caller must not hold the lock. */
  assemble(options: AssembleOptions): Promise<AssembledContext>;
}

/** Contract for createContext; the runtime factory is implemented separately. */
export type ContextFactory = (deps: ContextDeps) => Context;

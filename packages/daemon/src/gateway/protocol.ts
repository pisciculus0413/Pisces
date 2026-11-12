import type {
  ContentBlock,
  EffectiveEntry,
  EntryName,
  JsonObject,
  JsonValue,
  NodeId,
  QueueEntry,
  QueueEntryId,
  QueueEntryInput,
  SelectionState,
  SessionId,
  SessionMeta,
  SessionNode,
  TemplateInfo,
  TurnId,
} from "@pisces/core";
import type { ClientRegistration } from "../extensions/types.js";
import type { ActiveTurn } from "../runtime/concurrency.js";

export interface ProtocolError {
  code: string;
  message: string;
}

/** Fixed provenance for host-created queue entries (prompts and initial declarations). */
export const CREATE_ENTRY_SOURCE = "create";

/** Fixed provenance for prompts contributed by a template's `systemPromptFile`. */
export const TEMPLATE_ENTRY_SOURCE = "template";

export interface GatewayRequest<P = JsonValue> {
  id: string;
  method: string;
  params: P;
}

export interface GatewayResponse<R = JsonValue> {
  id: string;
  result?: R;
  error?: ProtocolError;
}

export interface SessionDefaults {
  workspace?: string;
  provider?: string;
  model?: string;
  extensions?: EntryName[];
}

export interface CreateSessionParams {
  workspace?: string;
  templateId?: string;
  model?: string;
  provider?: string;
  systemPrompt?: string[];
  extensions?: EntryName[];
}

export interface SessionReadParams {
  sessionId: SessionId;
  nodeId?: NodeId;
  limit?: number;
  cursor?: NodeId;
}

export interface SessionReadResult {
  meta: SessionMeta;
  seq: number;
  records: SessionNode[];
  queue: QueueEntry[];
  selection: SelectionState;
  nextCursor?: NodeId;
}

export interface ConfigureSessionParams {
  sessionId: SessionId;
  model?: string;
  provider?: string;
  systemPrompt?: string;
}

export interface QueueEnqueueParams {
  sessionId: SessionId;
  entries: QueueEntryInput[];
}

export interface QueueEnqueueResult {
  ids: QueueEntryId[];
}

export interface TurnStartParams {
  sessionId: SessionId;
  nodeId?: NodeId;
}

export interface TurnStartResult {
  turnId: TurnId;
  mode: "new" | "steer";
}

export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
  pricing?: { input: number; output: number; currency: string };
}

export interface ProviderInfo {
  id: string;
  ready: boolean;
  models: ModelInfo[];
}

export interface ProviderListResult {
  providers: ProviderInfo[];
}

/** Persisted sessions only; temporary sessions and ordering are not part of the contract. */
export interface SessionListResult {
  sessions: SessionMeta[];
}

export interface TurnListResult {
  turns: ActiveTurn[];
}

export interface SessionSubscribeParams {
  sessionId: SessionId;
}

export interface SessionSubscribeResult {
  sessionId: SessionId;
}

/** Protocol-safe inventory projection: no entry path, configuration body, or execute value. */
export interface EntrySnapshot {
  name: EntryName;
  kind: "tool" | "wrapper" | "skill" | "context";
  description?: string;
  parameters?: JsonObject;
  definitionHash?: string;
  configHash?: string;
}

export interface EntriesSnapshotParams {
  sessionId: SessionId;
}

/** Persisted branch selection plus eligibility; never includes a queued toggle. */
export interface EntriesSnapshotResult {
  entries: EntrySnapshot[];
  selection: SelectionState;
  effective: EffectiveEntry[];
}

export interface QueueEditParams {
  sessionId: SessionId;
  id: QueueEntryId;
  content: ContentBlock[];
}

export interface QueueEditResult {
  id: QueueEntryId;
}

export interface QueueRemoveParams {
  sessionId: SessionId;
  id: QueueEntryId;
}

export interface QueueRemoveResult {
  id: QueueEntryId;
}

export interface QueueClearParams {
  sessionId: SessionId;
}

export interface QueueClearResult {
  ids: QueueEntryId[];
}

export interface ClientListResult {
  clients: ClientRegistration[];
}

export interface ClientStartParams {
  id: string;
}

export interface ClientStartResult {
  pid: number;
}

export interface TemplateListResult {
  templates: TemplateInfo[];
}

export interface TemplatePreviewParams {
  templateId: string;
  workspace: string;
}

export interface TemplateApplyParams {
  templateId: string;
  workspace: string;
  confirmed: true;
  overwrite?: boolean;
}

export interface TemplateApplyResult {
  projectId: string;
  sessionId: SessionId;
}

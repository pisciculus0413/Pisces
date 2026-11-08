import type {
  EntryName,
  JsonValue,
  NodeId,
  QueueEntry,
  QueueEntryId,
  QueueEntryInput,
  SelectionState,
  SessionId,
  SessionMeta,
  SessionNode,
  TurnId,
} from "@pisces/core";
import type { ActiveTurn } from "../runtime/concurrency.js";

export interface ProtocolError {
  code: string;
  message: string;
}

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

export interface TurnListResult {
  turns: ActiveTurn[];
}

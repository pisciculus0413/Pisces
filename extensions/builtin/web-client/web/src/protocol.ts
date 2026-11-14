/**
 * Wire shapes the web client consumes.
 *
 * These mirror the protocol (see the detailed design §2–§3) but only declare the
 * fields the UI reads: the browser never imports the daemon package.
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | {
      type: "toolResult";
      toolCallId: string;
      content: ContentBlock[];
      isError?: boolean;
      code?: string;
      synthetic?: "interrupted";
    };

export type Role =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "declaration"
  | "compaction"
  | "cancel";

export interface SessionMeta {
  id: string;
  model: string;
  provider: string;
  workspace: string;
  createdAt: string;
  schemaVersion: number;
}

export interface SessionNode {
  id: string;
  parentId: string;
  kind: "agent" | "control";
  role: Role;
  content: ContentBlock[];
  source: string;
  synthetic?: "interrupted";
  createdAt: string;
  schemaVersion: number;
}

export interface QueueEntry {
  id: string;
  kind: "agent" | "control";
  role: Role;
  content: ContentBlock[];
  source: string;
  createdAt: string;
  confirmedAt?: string;
}

export type SelectionState = string[];

export interface EntrySnapshot {
  name: string;
  kind: "tool" | "wrapper" | "skill" | "context";
  description?: string;
  parameters?: unknown;
  definitionHash?: string;
  configHash?: string;
}

export interface EffectiveEntry {
  name: string;
  definitionHash?: string;
  configHash?: string;
  stale: boolean;
}

export interface SessionReadResult {
  meta: SessionMeta;
  seq: number;
  records: SessionNode[];
  queue: QueueEntry[];
  selection: SelectionState;
  nextCursor?: string;
}

export interface EntriesSnapshotResult {
  entries: EntrySnapshot[];
  selection: SelectionState;
  effective: EffectiveEntry[];
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

export interface TurnStartResult {
  turnId: string;
  mode: "new" | "steer";
}

export interface ActiveTurn {
  sessionId: string;
  turnId: string;
  startedAt: string;
}

/** One SSE frame: the daemon event type plus its data. */
export interface WireEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Text of a node's text blocks, joined for display. */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" || block.type === "reasoning" ? block.text : ""))
    .join("");
}

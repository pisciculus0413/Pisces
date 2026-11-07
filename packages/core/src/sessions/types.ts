import type { ContentBlock } from "../messages.js";
import type { Brand } from "../types.js";

export type SessionId = Brand<"SessionId">;
export type NodeId = Brand<"NodeId">;

export interface SessionMeta {
  id: SessionId;
  model: string;
  provider: string;
  workspace: string;
  createdAt: string;
  schemaVersion: number;
}

export interface SessionNode {
  id: NodeId;
  parentId: NodeId; // 根节点指向自身
  kind: "agent" | "control";
  role: "system" | "user" | "assistant" | "tool" | "declaration" | "compaction" | "cancel";
  content: ContentBlock[];
  source: string; // 来源标识：条目名、instruction、create 等
  synthetic?: "interrupted";
  createdAt: string;
  schemaVersion: number;
}

export interface SessionRepository {
  create(meta: SessionMeta, nodes: SessionNode[]): Promise<void>;
  append(sessionId: SessionId, nodes: SessionNode[]): Promise<void>;
  readBranch(sessionId: SessionId, nodeId?: NodeId): AsyncIterable<SessionNode>;
  readTree(sessionId: SessionId): AsyncIterable<SessionNode>;
  list(): Promise<SessionMeta[]>;
  updateMeta(sessionId: SessionId, meta: SessionMeta): Promise<void>;
}

export type SessionNodeDraft = Omit<SessionNode, "id" | "parentId" | "createdAt" | "schemaVersion">;

export interface SessionsDeps {
  repository: SessionRepository;
  newId: () => NodeId;
  now: () => string;
}

/** Runs after node generation, before any repository write; receives an isolated copy. */
export interface SessionWriteOptions {
  validate?: (nodes: readonly SessionNode[]) => void;
}

export interface Sessions {
  create(
    meta: SessionMeta,
    drafts: SessionNodeDraft[],
    options?: SessionWriteOptions,
  ): Promise<SessionNode[]>;
  append(
    sessionId: SessionId,
    drafts: SessionNodeDraft[],
    parentId?: NodeId,
    options?: SessionWriteOptions,
  ): Promise<SessionNode[]>;
  readBranch(sessionId: SessionId, nodeId?: NodeId): AsyncIterable<SessionNode>;
  readTree(sessionId: SessionId): AsyncIterable<SessionNode>;
  list(): Promise<SessionMeta[]>;
  updateMeta(sessionId: SessionId, meta: SessionMeta): Promise<void>;
}

import {
  type CancelPayload,
  createInterruptedToolResult,
  type NodeId,
  PiscesError,
  type SessionId,
  type SessionNode,
  type SessionNodeDraft,
  type Sessions,
} from "@pisces/core";
import type { RecoveryIssue, SessionStore } from "../session-store/session-store.js";
import type { ActiveTurnMarker, ActiveTurnStore } from "./active-turn.js";

export interface RecoveryDeps {
  store: SessionStore;
  markers: ActiveTurnStore;
  sessions: Sessions;
}

function recoveryIssue(sessionId: SessionId, error: unknown): RecoveryIssue {
  if (error instanceof TypeError) throw error;
  return {
    sessionId,
    error:
      error instanceof PiscesError
        ? error
        : new PiscesError("storage.io", "Turn recovery failed", { cause: error }),
  };
}

function cancelPayload(node: SessionNode): Record<string, unknown> {
  const block = node.content[0];
  if (block?.type !== "text") throw new PiscesError("storage.corrupt", "Invalid cancel payload");
  try {
    const value: unknown = JSON.parse(block.text);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Cancel payload is not an object");
    return value as Record<string, unknown>;
  } catch (cause) {
    throw new PiscesError("storage.corrupt", "Invalid cancel payload", { cause });
  }
}

async function startNode(
  store: SessionStore,
  sessionId: SessionId,
  marker: ActiveTurnMarker,
  scanned: SessionNode[],
): Promise<SessionNode> {
  if (marker.startNodeId === undefined) {
    const first = scanned[0];
    if (!first) throw new PiscesError("storage.corrupt", "Recovery window is empty");
    return first;
  }
  const found = scanned.find((node) => node.id === marker.startNodeId);
  if (found) return found;
  let start: SessionNode | undefined;
  for await (const node of store.readBranch(sessionId, marker.startNodeId)) start = node;
  if (!start) throw new PiscesError("session.node_not_found", "Start node not in session");
  return start;
}

function hasMatchingCancel(
  path: SessionNode[],
  window: Set<NodeId>,
  turnId: ActiveTurnMarker["turnId"],
): boolean {
  for (const node of path) {
    if (!window.has(node.id) || node.kind !== "control" || node.role !== "cancel") continue;
    if (cancelPayload(node).turnId === turnId) return true;
  }
  return false;
}

function recoveryDrafts(
  marker: ActiveTurnMarker,
  path: SessionNode[],
  endpoint: SessionNode,
): SessionNodeDraft[] {
  const assistant = path.findLast((node) => node.kind === "agent" && node.role === "assistant");
  const calls =
    assistant?.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) ?? [];
  const results = new Set(
    path.flatMap((node) =>
      node.content.flatMap((block) => (block.type === "toolResult" ? [block.toolCallId] : [])),
    ),
  );
  const synthetic: SessionNodeDraft[] = calls
    .filter((callId) => !results.has(callId))
    .map((callId) => ({
      kind: "agent",
      role: "tool",
      source: "recovery",
      content: [createInterruptedToolResult(callId)],
    }));
  const payload: CancelPayload = {
    turnId: marker.turnId,
    reason: "daemon_restart",
    at: endpoint.id,
  };
  return [
    ...synthetic,
    {
      kind: "control",
      role: "cancel",
      source: "recovery",
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  ];
}

async function recoverSession(
  deps: RecoveryDeps,
  sessionId: SessionId,
  marker: ActiveTurnMarker,
): Promise<void> {
  const scanned: SessionNode[] = [];
  for await (const node of deps.store.readTreeSince(sessionId, marker.startOffset))
    scanned.push(node);
  const window = new Set<NodeId>();
  const byId = new Map<NodeId, SessionNode>();
  const lastChild = new Map<NodeId, NodeId>();
  for (const node of scanned) {
    window.add(node.id);
    byId.set(node.id, node);
    if (node.parentId !== node.id) lastChild.set(node.parentId, node.id);
  }
  const path: SessionNode[] = [];
  let current: SessionNode | undefined = await startNode(deps.store, sessionId, marker, scanned);
  while (current) {
    path.push(current);
    const childId = lastChild.get(current.id);
    if (!childId) break;
    current = byId.get(childId);
  }
  const endpoint = path.at(-1);
  if (!endpoint) throw new PiscesError("session.node_not_found", "Empty recovery path");
  if (hasMatchingCancel(path, window, marker.turnId)) {
    await deps.markers.remove(sessionId, marker.turnId);
    return;
  }
  await deps.sessions.append(sessionId, recoveryDrafts(marker, path, endpoint), endpoint.id);
  await deps.markers.remove(sessionId, marker.turnId);
}

export async function recoverActiveTurns(deps: RecoveryDeps): Promise<RecoveryIssue[]> {
  const issues: RecoveryIssue[] = [];
  for (const entry of await deps.markers.scan()) {
    if ("error" in entry) {
      issues.push({ sessionId: entry.sessionId, error: entry.error });
      continue;
    }
    try {
      await recoverSession(deps, entry.sessionId, entry.marker);
    } catch (error) {
      issues.push(recoveryIssue(entry.sessionId, error));
    }
  }
  return issues;
}

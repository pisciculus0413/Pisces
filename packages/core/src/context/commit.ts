import type {
  NodeId,
  SessionId,
  SessionNode,
  SessionNodeDraft,
  Sessions,
} from "../sessions/types.js";
import { PiscesError } from "../types.js";
import type { QueueEntryId, SelectionState } from "./types.js";

/** An uncertain batch only; never retains a full session tree. */
export interface PendingContextCommit {
  readonly drafts: readonly SessionNodeDraft[];
  readonly queueIds: ReadonlySet<QueueEntryId>;
  readonly parentId?: NodeId;
  readonly watermark?: NodeId;
  readonly first: boolean;
  readonly selection: Readonly<SelectionState>;
  readonly error: PiscesError;
}

export async function reconcileCommit(
  sessions: Sessions,
  sessionId: SessionId,
  pending: PendingContextCommit,
): Promise<{ status: "committed"; nodes: SessionNode[] } | { status: "absent" }> {
  const tree: SessionNode[] = [];
  try {
    for await (const node of sessions.readTree(sessionId)) tree.push(node);
  } catch (error) {
    if (
      tree.length === 0 &&
      pending.watermark === undefined &&
      error instanceof PiscesError &&
      error.code === "session.not_found"
    )
      return { status: "absent" };
    throw error;
  }
  const corrupt = () =>
    new PiscesError("storage.corrupt", "Uncertain context batch does not match stored suffix");
  const offset =
    pending.watermark === undefined ? -1 : tree.findIndex((node) => node.id === pending.watermark);
  if (pending.watermark !== undefined && offset === -1) throw corrupt();
  const nodes = tree.slice(offset + 1);
  if (!nodes.length) return { status: "absent" };
  if (nodes.length !== pending.drafts.length) throw corrupt();
  const ids = new Set(tree.slice(0, offset + 1).map((node) => node.id));
  for (const [index, node] of nodes.entries()) {
    const draft = pending.drafts[index];
    const parent = index === 0 ? (pending.parentId ?? node.id) : nodes[index - 1]?.id;
    if (
      !draft ||
      ids.has(node.id) ||
      node.parentId !== parent ||
      node.kind !== draft.kind ||
      node.role !== draft.role ||
      node.source !== draft.source ||
      node.synthetic !== draft.synthetic ||
      JSON.stringify(node.content) !== JSON.stringify(draft.content)
    )
      throw corrupt();
    ids.add(node.id);
  }
  return { status: "committed", nodes };
}

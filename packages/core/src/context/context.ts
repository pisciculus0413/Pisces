import type { NodeId, SessionNodeDraft } from "../sessions/types.js";
import type { JsonValue } from "../types.js";
import { replayDeclarations } from "./declarations.js";
import { createQueue } from "./queue.js";
import type { Context, ContextDeps, SelectionState } from "./types.js";

export function createContext(deps: ContextDeps): Context {
  const state = { meta: structuredClone(deps.meta), persisted: deps.persisted };
  const selection: SelectionState = [];
  const queue = createQueue({
    newId: deps.newId,
    now: deps.now,
    onChange() {
      deps.events.publish({
        type: "queue.updated",
        sessionId: deps.sessionId,
        seq: deps.eventClock.next(),
        at: deps.now(),
        data: { queue: queue.snapshot() } as unknown as JsonValue,
      });
    },
  });

  async function readSelection(nodeId?: NodeId): Promise<SelectionState> {
    if (!state.persisted) return [];
    const branch: SessionNodeDraft[] = [];
    for await (const node of deps.sessions.readBranch(deps.sessionId, nodeId)) branch.push(node);
    return replayDeclarations(branch).selection;
  }

  return {
    async initialize() {
      const next = await readSelection();
      selection.splice(0, selection.length, ...next);
    },
    snapshot: () => ({
      queue: queue.snapshot(),
      selection: [...selection],
      seq: deps.eventClock.current(),
    }),
    selectionFor: readSelection,
    enqueue: queue.enqueue,
    edit: queue.edit,
    remove: queue.remove,
    clear: queue.clear,
    confirm: queue.confirm,
    unconfirm: queue.unconfirm,
    updateMeta(meta) {
      state.meta = { ...state.meta, model: meta.model, provider: meta.provider };
    },
    async assemble() {
      throw new Error("Context.assemble is not implemented (Task 5)");
    },
  };
}

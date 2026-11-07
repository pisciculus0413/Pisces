import type { NodeId, SessionNode, SessionNodeDraft } from "../sessions/types.js";
import { type JsonValue, PiscesError } from "../types.js";
import { budgetContext } from "./budget.js";
import { replayDeclarations } from "./declarations.js";
import { materialize, projectTools } from "./materialize.js";
import { createQueue } from "./queue.js";
import type {
  AssembledContext,
  Context,
  ContextDeps,
  ContextEvent,
  QueueEntryId,
  SelectionState,
} from "./types.js";

export function createContext(deps: ContextDeps): Context {
  const state = { meta: structuredClone(deps.meta), persisted: deps.persisted };
  const selection: SelectionState = [];
  function publish(type: ContextEvent["type"], data: unknown) {
    deps.events.publish({
      type,
      sessionId: deps.sessionId,
      seq: deps.eventClock.next(),
      at: deps.now(),
      data: structuredClone(data) as JsonValue,
    });
  }
  const queue = createQueue({
    newId: deps.newId,
    now: deps.now,
    onChange() {
      publish("queue.updated", { queue: queue.snapshot() });
    },
  });

  async function readBranch(nodeId?: NodeId): Promise<SessionNode[]> {
    if (!state.persisted) {
      if (nodeId !== undefined)
        throw new PiscesError("session.node_not_found", "Temporary session has no nodes");
      return [];
    }
    const branch: SessionNode[] = [];
    for await (const node of deps.sessions.readBranch(deps.sessionId, nodeId)) branch.push(node);
    return branch;
  }

  async function readSelection(nodeId?: NodeId): Promise<SelectionState> {
    return replayDeclarations(await readBranch(nodeId)).selection;
  }

  async function initialize() {
    const next = await readSelection();
    selection.splice(0, selection.length, ...next);
  }

  return {
    initialize,
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
    async assemble(options) {
      const { nodeId, signal, contextWindow, maxOutput } = options;
      let window: ReadonlyMap<QueueEntryId, number> | undefined;
      const first = !state.persisted;
      for (let attempt = 0; attempt < 2; attempt++) {
        const snapshot = await deps.runExclusive(async () => {
          signal?.throwIfAborted();
          await initialize();
          const branch = await readBranch(nodeId);
          signal?.throwIfAborted();
          window ??= queue.confirmedWindow();
          const entries = queue.survivors(window);
          return {
            branch,
            headId: branch.at(-1)?.id,
            ...replayDeclarations([...branch, ...entries]),
          };
        });

        // No budget decision here: entries may disappear while resolve is awaiting.
        const resolved = await materialize({
          ...snapshot,
          queue: [],
          entries: deps.entries,
          sources: deps.sources,
          skills: deps.skills,
          sourceContext: {
            sessionId: deps.sessionId,
            workspace: state.meta.workspace,
            ...(signal ? { signal } : {}),
          },
        });
        signal?.throwIfAborted();

        const result = await deps.runExclusive(async (): Promise<AssembledContext | undefined> => {
          signal?.throwIfAborted();
          const branch = await readBranch(nodeId);
          signal?.throwIfAborted();
          const entries = queue.survivors(window as ReadonlyMap<QueueEntryId, number>);
          const final = replayDeclarations([...branch, ...entries]);
          const headId = branch.at(-1)?.id;
          if (
            (nodeId === undefined && headId !== snapshot.headId) ||
            JSON.stringify(final.selection) !== JSON.stringify(snapshot.selection)
          ) {
            if (attempt === 1)
              throw new PiscesError("context.changed", "Context changed while resolving", {
                data: { retryable: true },
              });
            return undefined;
          }

          const existing = new Set(
            branch.filter((node) => node.kind === "agent").map((node) => node.source),
          );
          const drafts: SessionNodeDraft[] = [
            ...resolved.drafts.filter(
              (draft) =>
                final.selection.includes(draft.source as SelectionState[number]) &&
                !existing.has(draft.source),
            ),
            ...entries.map(({ kind, role, source, content }) => ({ kind, role, source, content })),
          ];
          const tools = projectTools({ ...final, entries: deps.entries });
          const { messages, compactions } = budgetContext({
            branch,
            drafts,
            selection: final.selection,
            tools,
            contextWindow,
            maxOutput,
          });
          if (!messages.length)
            throw new PiscesError("turn.empty", "Context has no visible messages");
          const batch = [...drafts, ...compactions];
          signal?.throwIfAborted();
          const nodes = batch.length
            ? state.persisted
              ? await deps.sessions.append(deps.sessionId, batch, headId)
              : await deps.sessions.create(structuredClone(state.meta), batch)
            : [];
          const nextHead = nodes.at(-1)?.id ?? headId;
          if (nextHead === undefined)
            throw new PiscesError("storage.corrupt", "Context has no head");

          // Finish internal commit state before callbacks can observe it or throw.
          const changed = JSON.stringify(selection) !== JSON.stringify(final.selection);
          const consumed = queue.consume(new Set(entries.map((entry) => entry.id)));
          state.persisted = true;
          selection.splice(0, selection.length, ...final.selection);
          const assembled: AssembledContext = {
            request: { model: state.meta.model, messages, ...(tools.length ? { tools } : {}) },
            selection: [...final.selection],
            nodes,
            headId: nextHead,
            first,
          };
          if (nodes.length)
            publish("session.updated", { nodes, ...(first ? { meta: state.meta } : {}) });
          if (changed) publish("selection.updated", { selection });
          if (consumed) publish("queue.updated", { queue: queue.snapshot() });
          return assembled;
        });
        if (result) return result;
      }
      throw new Error("Unreachable context retry");
    },
  };
}

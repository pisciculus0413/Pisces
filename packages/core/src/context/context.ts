import type { NodeId, SessionNode, SessionNodeDraft } from "../sessions/types.js";
import { PiscesError } from "../types.js";
import { budgetContext } from "./budget.js";
import { type PendingContextCommit, reconcileCommit } from "./commit.js";
import { replayDeclarations } from "./declarations.js";
import { createContextEvents } from "./events.js";
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
  let pending: PendingContextCommit | undefined;
  function assertWritable() {
    if (pending)
      throw new PiscesError("context.pending_commit", "Context commit requires reconciliation", {
        data: { retryable: true },
      });
  }
  const notifications = createContextEvents(deps);
  const { publish } = notifications;
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

  function completeCommit(commit: Omit<PendingContextCommit, "error">, nodes: SessionNode[]) {
    const changed = JSON.stringify(selection) !== JSON.stringify(commit.selection);
    const consumed = queue.consume(commit.queueIds);
    state.persisted = true;
    selection.splice(0, selection.length, ...commit.selection);
    pending = undefined;
    let failure: unknown;
    let failed = false;
    function notify(type: ContextEvent["type"], data: unknown) {
      try {
        publish(type, data);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
      }
    }
    if (nodes.length) {
      try {
        notifications.publishSession(nodes, commit.first ? state.meta : undefined);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    if (changed) notify("selection.updated", { selection });
    if (consumed) notify("queue.updated", { queue: queue.snapshot() });
    if (failed) throw failure;
  }

  async function reconcilePending() {
    if (pending) {
      const commit = pending;
      const result = await reconcileCommit(deps.sessions, deps.sessionId, commit);
      if (result.status === "committed") {
        try {
          completeCommit(commit, result.nodes);
        } catch {
          throw commit.error;
        }
      } else pending = undefined;
    }
  }

  async function initialize() {
    await reconcilePending();
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
    enqueue: (...args) => {
      assertWritable();
      return queue.enqueue(...args);
    },
    edit: (...args) => {
      assertWritable();
      return queue.edit(...args);
    },
    remove: (...args) => {
      assertWritable();
      return queue.remove(...args);
    },
    clear: (...args) => {
      assertWritable();
      return queue.clear(...args);
    },
    confirm: (...args) => {
      assertWritable();
      return queue.confirm(...args);
    },
    unconfirm: (...args) => {
      assertWritable();
      return queue.unconfirm(...args);
    },
    updateMeta(meta) {
      assertWritable();
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
          await reconcilePending();
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
          const watermark = state.persisted
            ? (nodeId === undefined ? branch : await readBranch()).at(-1)?.id
            : undefined;
          signal?.throwIfAborted();
          const commit: Omit<PendingContextCommit, "error"> = {
            drafts: structuredClone(batch),
            queueIds: new Set(entries.map((entry) => entry.id)),
            ...(headId === undefined ? {} : { parentId: headId }),
            ...(watermark === undefined ? {} : { watermark }),
            first,
            selection: [...final.selection],
          };
          let nodes: SessionNode[] = [];
          let storageError: PiscesError | undefined;
          if (batch.length) {
            if (JSON.stringify(selection) !== JSON.stringify(final.selection))
              notifications.validateSelection(final.selection);
            const writeDrafts = structuredClone([...commit.drafts]);
            const writeMeta = structuredClone(state.meta);
            const writeOptions = {
              validate: (nodes: readonly SessionNode[]) =>
                notifications.validateSessionNodes(nodes, first ? writeMeta : undefined),
            };
            try {
              nodes = state.persisted
                ? await deps.sessions.append(deps.sessionId, writeDrafts, headId, writeOptions)
                : await deps.sessions.create(writeMeta, writeDrafts, writeOptions);
            } catch (error) {
              if (!(error instanceof PiscesError) || error.code !== "storage.io") throw error;
              const uncertain: PendingContextCommit = { ...commit, error };
              pending = uncertain;
              let reconciled: Awaited<ReturnType<typeof reconcileCommit>>;
              try {
                reconciled = await reconcileCommit(deps.sessions, deps.sessionId, uncertain);
              } catch {
                throw error;
              }
              if (reconciled.status === "absent") {
                pending = undefined;
                throw error;
              }
              nodes = reconciled.nodes;
              storageError = error;
            }
          }
          const nextHead = nodes.at(-1)?.id ?? headId;
          if (nextHead === undefined)
            throw new PiscesError("storage.corrupt", "Context has no head");

          const assembled: AssembledContext = {
            request: { model: state.meta.model, messages, ...(tools.length ? { tools } : {}) },
            selection: [...final.selection],
            nodes: structuredClone(nodes),
            headId: nextHead,
            first,
          };
          if (nodes.length) {
            try {
              completeCommit(commit, nodes);
            } catch (error) {
              throw storageError ?? error;
            }
          }
          if (storageError) throw storageError;
          return assembled;
        });
        if (result) return result;
      }
      throw new Error("Unreachable context retry");
    },
  };
}

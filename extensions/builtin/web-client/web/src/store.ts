import type {
  EffectiveEntry,
  EntrySnapshot,
  QueueEntry,
  SelectionState,
  SessionMeta,
  SessionNode,
} from "./protocol.js";

/**
 * One reducer module for the whole console.
 *
 * Every function is pure: it returns a new state or the very same object when
 * the event changes nothing, which is how the UI avoids needless re-renders and
 * how `seq`-watermark drops stay observable in tests.
 */

export interface LiveTurn {
  turnId: string;
  step: number;
  text: string;
  reasoning: string;
}

export interface ActiveTurn {
  turnId: string;
  startedAt: string;
}

export interface SessionState {
  meta: SessionMeta | null;
  records: SessionNode[];
  queue: QueueEntry[];
  selection: SelectionState;
  entries: EntrySnapshot[];
  effective: EffectiveEntry[];
  activeTurn: ActiveTurn | null;
  live: LiveTurn | null;
  seq: number;
}

export interface ReadResult {
  meta: SessionMeta;
  seq: number;
  records: SessionNode[];
  queue: QueueEntry[];
  selection: SelectionState;
}

export interface EntriesResult {
  entries: EntrySnapshot[];
  selection: SelectionState;
  effective: EffectiveEntry[];
}

export const emptySession: SessionState = {
  meta: null,
  records: [],
  queue: [],
  selection: [],
  entries: [],
  effective: [],
  activeTurn: null,
  live: null,
  seq: -1,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** True when an event at `seq` is not newer than what the view already applied. */
export function isStale(state: SessionState, seq: number): boolean {
  return seq <= state.seq;
}

export function applyRead(state: SessionState, read: ReadResult): SessionState {
  return {
    ...state,
    meta: read.meta,
    seq: read.seq,
    records: read.records,
    queue: read.queue,
    selection: read.selection,
  };
}

export function applyEntries(state: SessionState, result: EntriesResult): SessionState {
  return {
    ...state,
    entries: result.entries,
    selection: result.selection,
    effective: result.effective,
  };
}

/** `turn.list` is the snapshot source for the same field turn.started/ended maintain. */
export function applyActiveTurns(
  state: SessionState,
  turns: readonly (ActiveTurn & { sessionId: string })[],
): SessionState {
  const sessionId = state.meta?.id;
  const match = sessionId === undefined ? undefined : turns.find((t) => t.sessionId === sessionId);
  const next = match === undefined ? null : { turnId: match.turnId, startedAt: match.startedAt };
  if (next === null) return state.activeTurn === null ? state : { ...state, activeTurn: null };
  return { ...state, activeTurn: next };
}

export function applyEvent(
  state: SessionState,
  frame: { event: string; data: unknown },
): SessionState {
  if (!isRecord(frame.data)) return state;
  const data = frame.data;
  const seq = typeof data.seq === "number" ? data.seq : undefined;
  if (seq !== undefined && isStale(state, seq)) return state;
  if (state.meta !== null && asString(data.sessionId) !== state.meta.id) return state;

  const advanced = seq === undefined ? state : { ...state, seq };

  switch (frame.event) {
    case "turn.started": {
      const turnId = asString(data.turnId);
      if (turnId === undefined) return state;
      return {
        ...advanced,
        activeTurn: { turnId, startedAt: asString(data.startedAt) ?? "" },
        live: { turnId, step: 0, text: "", reasoning: "" },
      };
    }
    case "turn.delta": {
      if (advanced.live === null) return advanced;
      const kind = asString(data.kind);
      if (kind !== "text" && kind !== "reasoning") return advanced;
      const piece = asString(data.delta) ?? "";
      const step = typeof data.step === "number" ? data.step : advanced.live.step;
      const live = { ...advanced.live, step };
      return {
        ...advanced,
        live:
          kind === "text"
            ? { ...live, text: live.text + piece }
            : { ...live, reasoning: live.reasoning + piece },
      };
    }
    case "turn.step": {
      if (advanced.live === null) return advanced;
      const step = typeof data.step === "number" ? data.step : advanced.live.step;
      // A new step means the previous step's text is already persisted: drop the
      // transient copy so the record column never shows it twice.
      return { ...advanced, live: { ...advanced.live, step, text: "", reasoning: "" } };
    }
    case "turn.ended": {
      return { ...advanced, live: null, activeTurn: null };
    }
    case "session.updated": {
      const nodes = Array.isArray(data.nodes) ? (data.nodes as SessionNode[]) : [];
      const records = mergeRecords(advanced.records, nodes);
      const meta = isRecord(data.meta) ? (data.meta as unknown as SessionMeta) : advanced.meta;
      const persistedReply = nodes.some((item) => item.role === "assistant");
      return {
        ...advanced,
        meta,
        records,
        live:
          advanced.live !== null && persistedReply
            ? { ...advanced.live, text: "", reasoning: "" }
            : advanced.live,
      };
    }
    case "queue.updated": {
      const queue = Array.isArray(data.queue) ? (data.queue as QueueEntry[]) : advanced.queue;
      return { ...advanced, queue };
    }
    case "selection.updated": {
      const selection = Array.isArray(data.selection)
        ? (data.selection as SelectionState)
        : advanced.selection;
      return { ...advanced, selection };
    }
    default:
      return advanced;
  }
}

/** Append-only merge that keeps the existing node objects and drops repeats. */
function mergeRecords(current: SessionNode[], incoming: readonly SessionNode[]): SessionNode[] {
  const seen = new Set(current.map((node) => node.id));
  const added = incoming.filter((node) => !seen.has(node.id));
  return added.length === 0 ? current : [...current, ...added];
}

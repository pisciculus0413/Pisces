import { AsyncLocalStorage } from "node:async_hooks";
import { PiscesError, type SessionId, type TurnId } from "@pisces/core";

export interface ActiveTurn {
  sessionId: SessionId;
  turnId: TurnId;
  startedAt: string;
}

export interface ConcurrencyOptions {
  cancelAllTimeoutMs?: number;
}

export interface Concurrency {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  registerTurn(sessionId: SessionId, turnId: TurnId, startedAt: string, cancel: () => void): void;
  unregisterTurn(sessionId: SessionId, turnId: TurnId): void;
  activeTurn(sessionId: SessionId): TurnId | undefined;
  activeTurns(): ActiveTurn[];
  cancelTurn(turnId: TurnId): boolean;
  cancelAll(maxWaitMs?: number): Promise<void>;
}

interface TurnEntry {
  activeTurn: ActiveTurn;
  cancel: () => void;
  cancelled: boolean;
  done: Promise<void>;
  finish: () => void;
}

export function createConcurrency(options: ConcurrencyOptions = {}): Concurrency {
  const tails = new Map<SessionId, Promise<void>>();
  const held = new AsyncLocalStorage<ReadonlySet<SessionId>>();
  const turns = new Map<TurnId, TurnEntry>();

  function runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T> {
    if (held.getStore()?.has(sessionId) === true) {
      return Promise.reject(new TypeError("Session lock is not reentrant"));
    }

    const previous = tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => tail);
    tails.set(sessionId, chained);

    const run = previous.then(() => {
      const next = new Set(held.getStore());
      next.add(sessionId);
      return held.run(next, task);
    });

    return run.finally(() => {
      release();
      if (tails.get(sessionId) === chained) tails.delete(sessionId);
    });
  }

  function turnOf(sessionId: SessionId): TurnEntry | undefined {
    for (const entry of turns.values()) {
      if (entry.activeTurn.sessionId === sessionId) return entry;
    }
    return undefined;
  }

  function registerTurn(
    sessionId: SessionId,
    turnId: TurnId,
    startedAt: string,
    cancel: () => void,
  ): void {
    if (turns.has(turnId) || turnOf(sessionId) !== undefined) {
      throw new PiscesError("turn.active", "A turn is already active");
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    turns.set(turnId, {
      activeTurn: { sessionId, turnId, startedAt },
      cancel,
      cancelled: false,
      done,
      finish,
    });
  }

  function unregisterTurn(sessionId: SessionId, turnId: TurnId): void {
    const entry = turns.get(turnId);
    if (entry === undefined || entry.activeTurn.sessionId !== sessionId) return;
    turns.delete(turnId);
    entry.finish();
  }

  function activeTurn(sessionId: SessionId): TurnId | undefined {
    return turnOf(sessionId)?.activeTurn.turnId;
  }

  function activeTurns(): ActiveTurn[] {
    return [...turns.values()]
      .map((entry) => ({ ...entry.activeTurn }))
      .sort((left, right) =>
        left.sessionId === right.sessionId
          ? left.turnId.localeCompare(right.turnId)
          : left.sessionId.localeCompare(right.sessionId),
      );
  }

  function cancelEntry(entry: TurnEntry): Promise<void> {
    if (!entry.cancelled) {
      entry.cancelled = true;
      entry.cancel();
    }
    return entry.done;
  }

  function cancelTurn(turnId: TurnId): boolean {
    const entry = turns.get(turnId);
    if (entry === undefined) return false;
    void cancelEntry(entry);
    return true;
  }

  async function cancelAll(maxWaitMs?: number): Promise<void> {
    const entries = [...turns.values()];
    if (entries.length === 0) return;
    const waits = entries.map((entry) => cancelEntry(entry));
    const waitMs = maxWaitMs ?? options.cancelAllTimeoutMs ?? 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    try {
      await Promise.race([Promise.all(waits).then(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    runExclusive,
    registerTurn,
    unregisterTurn,
    activeTurn,
    activeTurns,
    cancelTurn,
    cancelAll,
  };
}

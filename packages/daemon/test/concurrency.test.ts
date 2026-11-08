import type { SessionId, TurnId } from "@pisces/core";
import { expect, test, vi } from "vitest";
import { createConcurrency } from "../src/runtime/concurrency.js";

const NOW = "2026-11-08T00:00:00.000Z";
const S1 = "s1" as SessionId;
const S2 = "s2" as SessionId;

test("serializes one session, rejects reentrancy, and releases after failure", async () => {
  const concurrency = createConcurrency();
  const sid = "s1" as SessionId;
  const order: string[] = [];
  let nested: unknown;
  const first = concurrency.runExclusive(sid, async () => {
    order.push("first");
    nested = await concurrency
      .runExclusive(sid, async () => order.push("nested"))
      .catch((error: unknown) => error);
    order.push("after");
  });
  const second = concurrency.runExclusive(sid, async () => {
    order.push("second");
  });
  await Promise.all([first, second]);
  expect(nested).toBeInstanceOf(TypeError);
  expect((nested as Error).message).toBe("Session lock is not reentrant");
  expect(order).toEqual(["first", "after", "second"]);
  await expect(
    concurrency.runExclusive(sid, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  await expect(concurrency.runExclusive(sid, async () => "next")).resolves.toBe("next");
});

test("keeps FIFO order across three queued tasks", async () => {
  const concurrency = createConcurrency();
  const order: string[] = [];
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = concurrency.runExclusive(S1, async () => {
    order.push("a");
    entered();
    await gate;
    order.push("a-end");
  });
  await started;
  const second = concurrency.runExclusive(S1, async () => {
    order.push("b");
  });
  const third = concurrency.runExclusive(S1, async () => {
    order.push("c");
  });
  expect(order).toEqual(["a"]);
  releaseGate();
  await Promise.all([first, second, third]);
  expect(order).toEqual(["a", "a-end", "b", "c"]);
});

test("overlaps sessions while the first is blocked on a gate", async () => {
  const concurrency = createConcurrency();
  const order: string[] = [];
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = concurrency.runExclusive(S1, async () => {
    order.push("s1-start");
    entered();
    await gate;
    order.push("s1-end");
  });
  await started;
  await expect(
    concurrency.runExclusive(S2, async () => {
      order.push("s2");
      return "s2-done";
    }),
  ).resolves.toBe("s2-done");
  await expect(
    concurrency.runExclusive(S2, async () => {
      order.push("s2-later");
    }),
  ).resolves.toBeUndefined();
  expect(order).toEqual(["s1-start", "s2", "s2-later"]);
  releaseGate();
  await first;
  expect(order).toEqual(["s1-start", "s2", "s2-later", "s1-end"]);
});

test("allows cross-session nesting", async () => {
  const concurrency = createConcurrency();
  await expect(
    concurrency.runExclusive(S1, () => concurrency.runExclusive(S2, async () => "nested")),
  ).resolves.toBe("nested");
});

test("registers at most one turn per session and cancels it once", async () => {
  const concurrency = createConcurrency();
  const sid = "s1" as SessionId;
  const turnId = "t1" as TurnId;
  let cancelled = 0;
  concurrency.registerTurn(sid, turnId, NOW, () => {
    cancelled++;
  });
  expect(concurrency.activeTurn(sid)).toBe(turnId);
  expect(concurrency.activeTurns()).toEqual([{ sessionId: sid, turnId, startedAt: NOW }]);
  expect(() => concurrency.registerTurn(sid, "t2" as TurnId, NOW, () => {})).toThrowError(
    expect.objectContaining({ code: "turn.active" }),
  );
  expect(concurrency.cancelTurn(turnId)).toBe(true);
  expect(concurrency.cancelTurn(turnId)).toBe(true);
  expect(cancelled).toBe(1);
  concurrency.unregisterTurn(sid, turnId);
  concurrency.unregisterTurn(sid, turnId);
  expect(concurrency.activeTurns()).toEqual([]);
  expect(concurrency.cancelTurn(turnId)).toBe(false);
});

test("allows a second session and returns a detached sorted snapshot", () => {
  const concurrency = createConcurrency();
  concurrency.registerTurn(S2, "t2" as TurnId, NOW, () => {});
  concurrency.registerTurn(S1, "t1" as TurnId, NOW, () => {});
  const snapshot = concurrency.activeTurns();
  expect(snapshot).toEqual([
    { sessionId: S1, turnId: "t1", startedAt: NOW },
    { sessionId: S2, turnId: "t2", startedAt: NOW },
  ]);
  expect(snapshot[0]).not.toBe(concurrency.activeTurns()[0]);
  snapshot.pop();
  snapshot[0] = { sessionId: "x" as SessionId, turnId: "x" as TurnId, startedAt: NOW };
  expect(concurrency.activeTurns()).toHaveLength(2);
  expect(concurrency.activeTurn(S1)).toBe("t1");
  expect(concurrency.activeTurn(S2)).toBe("t2");
});

test("ignores unregisterTurn with a mismatched turnId", () => {
  const concurrency = createConcurrency();
  const turnId = "t1" as TurnId;
  concurrency.registerTurn(S1, turnId, NOW, () => {});
  concurrency.unregisterTurn(S1, "other" as TurnId);
  concurrency.unregisterTurn(S2, turnId);
  expect(concurrency.activeTurn(S1)).toBe(turnId);
  expect(concurrency.cancelTurn(turnId)).toBe(true);
});

test("cancels every turn, waits for completion, and keeps entries on timeout", async () => {
  const concurrency = createConcurrency();
  const sid = "s1" as SessionId;
  const turnId = "t1" as TurnId;
  let cancelled = 0;
  concurrency.registerTurn(sid, turnId, NOW, () => {
    cancelled++;
    concurrency.unregisterTurn(sid, turnId);
  });
  await concurrency.cancelAll(50);
  expect(cancelled).toBe(1);
  expect(concurrency.activeTurns()).toEqual([]);

  const stuck = "t2" as TurnId;
  concurrency.registerTurn(sid, stuck, NOW, () => {});
  vi.useFakeTimers();
  try {
    const waiting = concurrency.cancelAll(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
  } finally {
    vi.useRealTimers();
  }
  expect(concurrency.activeTurns()).toEqual([{ sessionId: sid, turnId: stuck, startedAt: NOW }]);
});

test("cancels each turn exactly once across repeated cancelAll calls", async () => {
  const concurrency = createConcurrency();
  const cancellations: string[] = [];
  const t1 = "t1" as TurnId;
  const t2 = "t2" as TurnId;
  concurrency.registerTurn(S1, t1, NOW, () => {
    cancellations.push("t1");
    concurrency.unregisterTurn(S1, t1);
  });
  concurrency.registerTurn(S2, t2, NOW, () => {
    cancellations.push("t2");
    concurrency.unregisterTurn(S2, t2);
  });
  await concurrency.cancelAll(50);
  await concurrency.cancelAll(50);
  expect(cancellations.sort()).toEqual(["t1", "t2"]);
  expect(concurrency.activeTurns()).toEqual([]);
});

test("resolves immediately for an empty registry", async () => {
  const concurrency = createConcurrency();
  vi.useFakeTimers();
  try {
    await expect(concurrency.cancelAll()).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("defaults to the injected cancelAllTimeoutMs", async () => {
  const concurrency = createConcurrency({ cancelAllTimeoutMs: 1_000 });
  const turnId = "t1" as TurnId;
  concurrency.registerTurn(S1, turnId, NOW, () => {});
  vi.useFakeTimers();
  try {
    let settled = false;
    const waiting = concurrency.cancelAll().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
  expect(concurrency.activeTurns()).toEqual([{ sessionId: S1, turnId, startedAt: NOW }]);
});

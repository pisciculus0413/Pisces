import { expect, test } from "vitest";
import type { SessionNode } from "../web/src/protocol.js";
import {
  applyEvent,
  applyRead,
  emptySession,
  isStale,
  type SessionState,
} from "../web/src/store.js";

/**
 * The store is the only place that turns protocol events into view state, so it
 * is pure and tested in node: no DOM, no fetch.
 */

const META = {
  id: "s1",
  model: "m",
  provider: "p",
  workspace: "/ws",
  createdAt: "2026-11-12T00:00:00.000Z",
  schemaVersion: 1,
};

function node(id: string, role: SessionNode["role"], text: string, parentId = id): SessionNode {
  return {
    id,
    parentId,
    kind:
      role === "assistant" || role === "user" || role === "system" || role === "tool"
        ? "agent"
        : "control",
    role,
    content: [{ type: "text", text }],
    source: "test",
    createdAt: "2026-11-12T00:00:00.000Z",
    schemaVersion: 1,
  };
}

const read = (state: SessionState, seq: number): SessionState =>
  applyRead(state, {
    meta: { ...META },
    seq,
    records: [node("n1", "user", "hi")],
    queue: [],
    selection: [],
  });

const started = (state: SessionState, seq: number) =>
  applyEvent(state, {
    event: "turn.started",
    data: { sessionId: "s1", seq, at: "t", turnId: "t1", startedAt: "2026-11-12T00:00:00.000Z" },
  });

const delta = (
  state: SessionState,
  seq: number,
  step: number,
  kind: "text" | "reasoning",
  text: string,
) =>
  applyEvent(state, {
    event: "turn.delta",
    data: { sessionId: "s1", seq, at: "t", turnId: "t1", step, kind, delta: text },
  });

test("accumulates deltas per step and kind", () => {
  let state = started(read(emptySession, 10), 11);

  state = delta(state, 12, 1, "text", "Hel");
  state = delta(state, 13, 1, "text", "lo");
  state = delta(state, 14, 1, "reasoning", "think");

  expect(state.live).toEqual({ turnId: "t1", step: 1, text: "Hello", reasoning: "think" });

  state = applyEvent(state, {
    event: "turn.step",
    data: { sessionId: "s1", seq: 15, at: "t", turnId: "t1", step: 1, stopReason: "toolCall" },
  });
  state = delta(state, 16, 2, "text", "next");

  expect(state.live).toEqual({ turnId: "t1", step: 2, text: "next", reasoning: "" });
});

test("ignores events at or below the seq watermark", () => {
  const state = read(emptySession, 10);

  const stale = delta(state, 10, 1, "text", "nope");
  const older = delta(state, 9, 1, "text", "nope");

  expect(stale).toBe(state);
  expect(older).toBe(state);
  expect(isStale(state, 10)).toBe(true);
  expect(isStale(state, 11)).toBe(false);
});

test("replaces a live assistant node with the persisted one", () => {
  let state = started(read(emptySession, 10), 11);
  state = delta(state, 12, 1, "text", "streamed");

  state = applyEvent(state, {
    event: "session.updated",
    data: {
      sessionId: "s1",
      seq: 13,
      at: "t",
      nodes: [node("n2", "assistant", "streamed", "n1")],
      meta: { ...META, model: "m2" },
    },
  });

  expect(state.records.map((record) => record.id)).toEqual(["n1", "n2"]);
  expect(state.meta?.model).toBe("m2");
  expect(state.live).toEqual({ turnId: "t1", step: 1, text: "", reasoning: "" });
});

test("keeps records immutable in append order and deduplicates ids", () => {
  let state = read(emptySession, 10);
  state = applyEvent(state, {
    event: "session.updated",
    data: { sessionId: "s1", seq: 11, at: "t", nodes: [node("n2", "assistant", "a", "n1")] },
  });
  const before = state.records;

  state = applyEvent(state, {
    event: "session.updated",
    data: {
      sessionId: "s1",
      seq: 12,
      at: "t",
      nodes: [node("n2", "assistant", "a", "n1"), node("n3", "user", "b", "n2")],
    },
  });

  expect(state.records.map((record) => record.id)).toEqual(["n1", "n2", "n3"]);
  // The previous array is untouched: the store replaces, never mutates.
  expect(before.map((record) => record.id)).toEqual(["n1", "n2"]);
  expect(state.records).not.toBe(before);
});

test("clears the live turn on turn.ended and on failure", () => {
  for (const reason of ["completed", "cancelled", "failed"] as const) {
    let state = started(read(emptySession, 10), 11);
    state = delta(state, 12, 1, "text", "partial");

    state = applyEvent(state, {
      event: "turn.ended",
      data: { sessionId: "s1", seq: 13, at: "t", turnId: "t1", reason, endedAt: "t" },
    });

    expect(state.live).toBeNull();
    expect(state.activeTurn).toBeNull();
  }
});

test("replaces queue and selection wholesale", () => {
  let state = read(emptySession, 10);
  const queue = [
    {
      id: "q1",
      kind: "agent" as const,
      role: "user" as const,
      content: [{ type: "text" as const, text: "queued" }],
      source: "web",
      createdAt: "2026-11-12T00:00:00.000Z",
    },
  ];

  state = applyEvent(state, {
    event: "queue.updated",
    data: { sessionId: "s1", seq: 11, at: "t", queue },
  });
  expect(state.queue).toEqual(queue);

  state = applyEvent(state, {
    event: "selection.updated",
    data: { sessionId: "s1", seq: 12, at: "t", selection: ["pkg#tool"] },
  });
  expect(state.selection).toEqual(["pkg#tool"]);

  state = applyEvent(state, {
    event: "queue.updated",
    data: { sessionId: "s1", seq: 13, at: "t", queue: [] },
  });
  expect(state.queue).toEqual([]);
});

test("ignores events for another session", () => {
  const state = read(emptySession, 10);

  const other = applyEvent(state, {
    event: "turn.delta",
    data: { sessionId: "other", seq: 99, at: "t", turnId: "t9", step: 1, kind: "text", delta: "x" },
  });

  expect(other).toBe(state);
});

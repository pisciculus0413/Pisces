import { expect, test, vi } from "vitest";
import {
  createEventPublisher,
  createInterruptedToolResult,
  type EngineEvent,
  type EventBus,
  type NodeId,
  type SessionId,
  type SessionNode,
  type TurnId,
} from "../src/index.js";

function createBus() {
  const handlers = new Set<(event: EngineEvent) => void>();
  const published: EngineEvent[] = [];
  const publish = vi.fn((event: EngineEvent) => {
    published.push(event);
    for (const handler of handlers) handler(event);
  });
  const bus: EventBus = {
    publish,
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return { bus, publish, published };
}

function node(id: string, parentId: string, size: number): SessionNode {
  return {
    id: id as NodeId,
    parentId: parentId as NodeId,
    kind: "agent",
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(size) }],
    source: "assistant",
    createdAt: "2026-11-08T00:00:00.000Z",
    schemaVersion: 1,
  };
}

test("publishes a typed turn envelope with the shared clock", () => {
  const { bus, publish } = createBus();
  let seq = 0;
  const publisher = createEventPublisher({
    sessionId: "s1" as SessionId,
    events: bus,
    eventClock: { current: () => seq, next: () => ++seq },
    now: () => "2026-11-08T00:00:00.000Z",
  });

  publisher.publishTurn("turn.started", {
    turnId: "t1" as TurnId,
    startedAt: "2026-11-08T00:00:00.000Z",
  });

  expect(publish).toHaveBeenCalledWith({
    type: "turn.started",
    sessionId: "s1",
    seq: 1,
    at: "2026-11-08T00:00:00.000Z",
    data: {
      turnId: "t1",
      startedAt: "2026-11-08T00:00:00.000Z",
    },
  });
});

test("subscribes synchronously and permits connection-level events without seq", () => {
  const { bus } = createBus();
  const delivered: EngineEvent[] = [];
  const unsubscribe = bus.subscribe((event) => delivered.push(event));
  const connectionEvent: EngineEvent = {
    type: "client.launched",
    at: "2026-11-08T00:00:00.000Z",
    data: { clientId: "c1", pid: 42 },
  };

  bus.publish(connectionEvent);
  expect(delivered).toEqual([connectionEvent]);

  unsubscribe();
  bus.publish(connectionEvent);
  expect(delivered).toEqual([connectionEvent]);
});

test("normalizes synchronous subscriber failures", () => {
  const { bus } = createBus();
  const cause = new Error("subscriber failed");
  bus.subscribe(() => {
    throw cause;
  });
  const publisher = createEventPublisher({
    sessionId: "s1" as SessionId,
    events: bus,
    eventClock: { current: () => 0, next: () => 1 },
    now: () => "2026-11-08T00:00:00.000Z",
  });

  expect(() =>
    publisher.publishTurn("turn.started", {
      turnId: "t1" as TurnId,
      startedAt: "2026-11-08T00:00:00.000Z",
    }),
  ).toThrow(expect.objectContaining({ code: "event.publish_failed", cause }));
});

test("splits deltas at complete code points without changing their bytes", () => {
  const { bus, published } = createBus();
  let seq = 0;
  const publisher = createEventPublisher({
    sessionId: "s1" as SessionId,
    events: bus,
    eventClock: { current: () => seq, next: () => ++seq },
    now: () => "2026-11-08T00:00:00.000Z",
  });
  const delta = `🐟中文${"x".repeat(4_200_000)}`;

  publisher.publishDelta("t1" as TurnId, 1, "text", delta);

  const frames = published.filter(
    (event): event is EngineEvent & { type: "turn.delta"; data: { delta: string } } =>
      event.type === "turn.delta",
  );
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.map((event) => event.data.delta).join("")).toBe(delta);
  expect(frames.map((event) => event.seq)).toEqual(
    Array.from({ length: frames.length }, (_, index) => index + 1),
  );
  for (const frame of frames)
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThanOrEqual(4194303);
});

test("frames whole session nodes and leaves input unchanged", () => {
  const { bus, published } = createBus();
  let seq = 0;
  const publisher = createEventPublisher({
    sessionId: "s1" as SessionId,
    events: bus,
    eventClock: { current: () => seq, next: () => ++seq },
    now: () => "2026-11-08T00:00:00.000Z",
  });
  const nodes = [node("n1", "n1", 2_100_000), node("n2", "n1", 2_100_000)];
  const before = structuredClone(nodes);

  publisher.publishSession(nodes);

  const frames = published.filter(
    (event): event is EngineEvent & { type: "session.updated"; data: { nodes: SessionNode[] } } =>
      event.type === "session.updated",
  );
  expect(frames).toHaveLength(2);
  expect(frames.map((event) => event.data.nodes.map((item) => item.id))).toEqual([["n1"], ["n2"]]);
  expect(nodes).toEqual(before);
});

test("rejects a single node that cannot fit one session event", () => {
  const { bus } = createBus();
  const publisher = createEventPublisher({
    sessionId: "s1" as SessionId,
    events: bus,
    eventClock: { current: () => 0, next: () => 1 },
    now: () => "2026-11-08T00:00:00.000Z",
  });

  expect(() => publisher.validateSessionNodes([node("n1", "n1", 4_200_000)])).toThrow(
    expect.objectContaining({ code: "context.source_failed" }),
  );
});

test("creates the exact synthetic interrupted tool result", () => {
  expect(createInterruptedToolResult("call-1")).toEqual({
    type: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "text", text: "结果未知，可能已部分生效，请核验" }],
    synthetic: "interrupted",
  });
});

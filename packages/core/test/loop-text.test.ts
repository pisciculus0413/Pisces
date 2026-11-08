import { expect, test } from "vitest";
import type {
  ExecuteProvider,
  LlmAdapter,
  LlmEvent,
  LlmRequest,
  SessionNode,
  TurnId,
} from "../src/index.js";
import { createLoopHarness, LOOP_META, user } from "./support/loop-harness.js";

function adapterFor(responses: LlmEvent[][]) {
  const requests: LlmRequest[] = [];
  let call = 0;
  const adapter: LlmAdapter = {
    dialect: "fake",
    buildRequest(request) {
      requests.push(structuredClone(request));
      return { path: "/chat", body: JSON.stringify(request) };
    },
    parseChunk(chunk) {
      return JSON.parse(chunk) as LlmEvent[];
    },
  };
  const execute: ExecuteProvider = async function* (request, signal) {
    expect(signal).toBeDefined();
    expect(request.path).toBe("/chat");
    yield JSON.stringify(responses[call++] ?? []);
  };
  return { adapter, execute, requests, calls: () => call };
}

async function tree(h: ReturnType<typeof createLoopHarness>) {
  const nodes: SessionNode[] = [];
  for await (const node of h.sessions.readTree(LOOP_META.id)) nodes.push(node);
  return nodes;
}

test("drives one text step and completes the turn", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute, requests, calls } = adapterFor([
    [
      { type: "content", delta: "hel" },
      { type: "content", delta: "lo" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: "stop", reason: "stop" },
    ],
  ]);
  h.published.splice(0);

  const result = await h.driver.run({
    sessionId: LOOP_META.id,
    turnId: "t1" as TurnId,
    meta: LOOP_META,
    context: h.context,
    sessions: h.sessions,
    tools: h.tools,
    adapter,
    execute,
    events: h.events,
    eventClock: h.eventClock,
    contextWindow: 100000,
    maxOutput: 1000,
    signal: new AbortController().signal,
  });

  expect(result).toEqual({
    sessionId: LOOP_META.id,
    turnId: "t1",
    reason: "completed",
  });
  expect(requests).toEqual([
    {
      model: "model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
  ]);
  const turnEvents = h.published.filter((event) => event.type.startsWith("turn."));
  expect(turnEvents[0]?.type).toBe("turn.started");
  expect(
    turnEvents
      .filter((event) => event.type === "turn.delta")
      .map((event) => (event.data as { delta: string }).delta),
  ).toEqual(["hel", "lo"]);
  for (const event of turnEvents)
    expect(event.data).toMatchObject(event.type === "turn.delta" ? { step: 1, kind: "text" } : {});
  expect(turnEvents.map((event) => event.seq as number)).toEqual(
    [...turnEvents.map((event) => event.seq as number)].sort((left, right) => left - right),
  );

  const nodes = await tree(h);
  expect(nodes).toHaveLength(2);
  const assistant = nodes[1] as SessionNode;
  expect(assistant).toMatchObject({
    kind: "agent",
    role: "assistant",
    source: "assistant",
    parentId: nodes[0]?.id,
    content: [{ type: "text", text: "hello" }],
  });
  const assistantEvents = h.published.filter(
    (event) =>
      event.type === "session.updated" &&
      (event.data as { nodes?: SessionNode[] }).nodes?.some((node) => node.role === "assistant"),
  );
  expect(assistantEvents).toHaveLength(1);
  const assistantEvent = assistantEvents[0];
  if (!assistantEvent) throw new Error("Expected an assistant session event");
  expect(
    (assistantEvent.data as unknown as { nodes: SessionNode[] }).nodes.map((node) => node.id),
  ).toEqual([assistant.id]);

  const step = h.published.find((event) => event.type === "turn.step");
  expect(step?.data).toEqual({
    turnId: "t1",
    step: 1,
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  });
  expect(h.published.at(-1)).toMatchObject({
    type: "turn.ended",
    data: { turnId: "t1", reason: "completed", endedAt: "2026-11-08T00:00:00.000Z" },
  });
  expect(calls()).toBe(1);
});

test("ignores an unconfirmed queue entry during the turn", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  await h.enqueue([user("pending")], false);
  const { adapter, execute, requests, calls } = adapterFor([
    [
      { type: "content", delta: "done" },
      { type: "stop", reason: "stop" },
    ],
  ]);

  await h.driver.run({
    sessionId: LOOP_META.id,
    turnId: "t1" as TurnId,
    meta: LOOP_META,
    context: h.context,
    sessions: h.sessions,
    tools: h.tools,
    adapter,
    execute,
    events: h.events,
    eventClock: h.eventClock,
    contextWindow: 100000,
    maxOutput: 1000,
    signal: new AbortController().signal,
  });

  expect(requests[0]?.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
  expect(calls()).toBe(1);
  const pending = await h.runExclusive(async () => h.context.snapshot().queue);
  expect(pending.map((entry) => entry.content)).toEqual([[{ type: "text", text: "pending" }]]);
  expect(pending[0]?.confirmedAt).toBeUndefined();
});

test("ignores empty deltas but persists normal text", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      { type: "content", delta: "" },
      { type: "reasoning", delta: "" },
      { type: "content", delta: "kept" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  h.published.splice(0);

  expect(
    (
      await h.driver.run({
        sessionId: LOOP_META.id,
        turnId: "t1" as TurnId,
        meta: LOOP_META,
        context: h.context,
        sessions: h.sessions,
        tools: h.tools,
        adapter,
        execute,
        events: h.events,
        eventClock: h.eventClock,
        contextWindow: 100000,
        maxOutput: 1000,
        signal: new AbortController().signal,
      })
    ).reason,
  ).toBe("completed");

  expect(
    h.published
      .filter((event) => event.type === "turn.delta")
      .map((event) => (event.data as { delta: string }).delta),
  ).toEqual(["kept"]);
  expect((await tree(h))[1]?.content).toEqual([{ type: "text", text: "kept" }]);
});

test("rejects a non-string delta as an invalid provider response", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      { type: "content", delta: 42 as unknown as string },
      { type: "stop", reason: "stop" },
    ],
  ]);

  expect(
    (
      await h.driver.run({
        sessionId: LOOP_META.id,
        turnId: "t1" as TurnId,
        meta: LOOP_META,
        context: h.context,
        sessions: h.sessions,
        tools: h.tools,
        adapter,
        execute,
        events: h.events,
        eventClock: h.eventClock,
        contextWindow: 100000,
        maxOutput: 1000,
        signal: new AbortController().signal,
      })
    ).error,
  ).toEqual({
    code: "provider.invalid_response",
    message: "Provider returned an invalid text delta",
  });
  expect((await tree(h)).map((node) => node.role)).toEqual(["user"]);
});

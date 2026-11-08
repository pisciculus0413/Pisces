import { expect, test, vi } from "vitest";
import type {
  EntryName,
  ExecuteProvider,
  LlmAdapter,
  LlmEvent,
  LlmRequest,
  SessionNode,
  ToolInvocationContext,
  ToolResult,
  Tools,
  TurnId,
} from "../src/index.js";
import { createLoopHarness, LOOP_META, user } from "./support/loop-harness.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const name = (value: string) => `pkg#${value}` as EntryName;

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
  const execute: ExecuteProvider = async function* () {
    yield JSON.stringify(responses[call++] ?? []);
  };
  return { adapter, execute, requests, calls: () => call };
}

function toolsWithInvoke(
  invoke: (
    call: Parameters<Tools["invoke"]>[0],
    selection: Parameters<Tools["invoke"]>[1],
    context: ToolInvocationContext,
  ) => Promise<ToolResult>,
) {
  const tools: Tools = {
    forInventory: () => tools,
    registerTool: () => undefined,
    registerWrapper: () => undefined,
    selected: () => [],
    invoke,
  };
  return tools;
}

function run(
  h: ReturnType<typeof createLoopHarness>,
  adapter: LlmAdapter,
  execute: ExecuteProvider,
  signal = new AbortController().signal,
) {
  return h.driver.run({
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
    signal,
  });
}

async function tree(h: ReturnType<typeof createLoopHarness>) {
  const nodes: SessionNode[] = [];
  for await (const node of h.sessions.readTree(LOOP_META.id)) nodes.push(node);
  return nodes;
}

test("continues with an outside-lock steer and ignores an unconfirmed one", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute, requests, calls } = adapterFor([
    [
      { type: "content", delta: "first" },
      { type: "stop", reason: "stop" },
    ],
    [
      { type: "content", delta: "second" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  const barrier = h.holdAfterStep(1);
  const pending = run(h, adapter, execute);

  await barrier.reached;
  await h.enqueueAndConfirm([user("steer")]);
  barrier.release();

  expect((await pending).reason).toBe("completed");
  expect(calls()).toBe(2);
  expect(requests[1]?.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "steer" }]);

  const pendingOnly = createLoopHarness();
  await pendingOnly.enqueueAndConfirm([user("hello")]);
  const pendingAdapter = adapterFor([
    [
      { type: "content", delta: "done" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  const pendingBarrier = pendingOnly.holdAfterStep(1);
  const pendingRun = run(pendingOnly, pendingAdapter.adapter, pendingAdapter.execute);
  await pendingBarrier.reached;
  await pendingOnly.enqueue([user("pending")], false);
  pendingBarrier.release();

  expect((await pendingRun).reason).toBe("completed");
  expect(pendingAdapter.calls()).toBe(1);
  const queue = await pendingOnly.runExclusive(async () => pendingOnly.context.snapshot().queue);
  expect(queue).toHaveLength(1);
  expect(queue[0]?.confirmedAt).toBeUndefined();
});

test("checks for steer and completes under one driver lock", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      { type: "content", delta: "done" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  let stepSeen = false;
  let endedLocks = -1;
  let endedUnderLock = false;
  h.events.subscribe((event) => {
    if (event.type === "turn.step") {
      stepSeen = true;
      h.resetDriverLockCount();
    }
    if (event.type === "turn.ended") {
      endedLocks = h.driverLockCount();
      endedUnderLock = h.isLocked();
    }
  });

  expect((await run(h, adapter, execute)).reason).toBe("completed");
  expect(stepSeen).toBe(true);
  expect(endedUnderLock).toBe(true);
  expect(endedLocks).toBe(1);
});

test("cancels a stream, persists partial content, and resets confirmations", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const entered = gate();
  const resume = gate();
  let observed: AbortSignal | undefined;
  const adapter: LlmAdapter = {
    dialect: "fake",
    buildRequest: (request) => ({ path: "/chat", body: JSON.stringify(request) }),
    parseChunk: (chunk) => JSON.parse(chunk) as LlmEvent[],
  };
  const execute: ExecuteProvider = async function* (_request, signal) {
    observed = signal;
    yield JSON.stringify([{ type: "content", delta: "partial" }]);
    entered.resolve();
    await resume.promise;
    signal?.throwIfAborted();
  };
  const pending = run(h, adapter, execute);
  await entered.promise;
  await h.enqueueAndConfirm([user("steer")]);
  const first = await h.driver.cancel("t1" as TurnId);
  const second = await h.driver.cancel("t1" as TurnId);
  resume.resolve();
  const result = await pending;

  expect(first).toBe(true);
  expect(second).toBe(true);
  expect(observed?.aborted).toBe(true);
  expect(result.reason).toBe("cancelled");
  const nodes = await tree(h);
  expect(nodes.map((node) => node.role)).toEqual(["user", "assistant", "cancel"]);
  expect(nodes[1]?.content).toEqual([{ type: "text", text: "partial" }]);
  const cancelNode = nodes[2];
  if (!cancelNode) throw new Error("Expected a cancel node");
  const payload = JSON.parse((cancelNode.content[0] as { text: string }).text) as {
    turnId: string;
    reason: string;
    at: string;
  };
  expect(payload).toEqual({ turnId: "t1", reason: "cancelled", at: nodes[1]?.id });
  const queue = await h.runExclusive(async () => h.context.snapshot().queue);
  expect(queue).toHaveLength(1);
  expect(queue[0]?.confirmedAt).toBeUndefined();
  expect(h.published.find((event) => event.type === "turn.step")?.data).toMatchObject({
    turnId: "t1",
    step: 1,
    stopReason: "cancelled",
  });
  expect(h.published.at(-1)).toMatchObject({
    type: "turn.ended",
    data: { turnId: "t1", reason: "cancelled" },
  });
  await expect(h.driver.cancel("t1" as TurnId)).resolves.toBe(false);
  await expect(h.driver.cancel("missing" as TurnId)).resolves.toBe(false);
});

test("keeps parsed calls on cancellation before tool execution", async () => {
  const entered = gate();
  const resume = gate();
  const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unused" }] }));
  const tools = toolsWithInvoke(invoke);
  const harness = createLoopHarness({ tools });
  await harness.enqueueAndConfirm([user("hello")]);
  const adapter: LlmAdapter = {
    dialect: "fake",
    buildRequest: (request) => ({ path: "/chat", body: JSON.stringify(request) }),
    parseChunk: (chunk) => JSON.parse(chunk) as LlmEvent[],
  };
  const execute: ExecuteProvider = async function* (_request, signal) {
    yield JSON.stringify([
      { type: "content", delta: "working" },
      { type: "toolCall", call: { id: "call-1", name: name("one"), arguments: null } },
      { type: "toolCall", call: { id: "call-2", name: name("two"), arguments: null } },
    ]);
    entered.resolve();
    await resume.promise;
    signal?.throwIfAborted();
  };
  const pending = run(harness, adapter, execute);
  await entered.promise;
  await harness.driver.cancel("t1" as TurnId);
  resume.resolve();
  expect((await pending).reason).toBe("cancelled");

  const nodes = await tree(harness);
  expect(nodes[1]?.content).toEqual([
    { type: "text", text: "working" },
    { type: "toolCall", id: "call-1", name: name("one"), arguments: null },
    { type: "toolCall", id: "call-2", name: name("two"), arguments: null },
  ]);
  expect(invoke).not.toHaveBeenCalled();
  expect(nodes[2]?.role).toBe("cancel");
});

test("does not launch tools when cancellation arrives after assistant commit", async () => {
  const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unused" }] }));
  const h = createLoopHarness({ tools: toolsWithInvoke(invoke) });
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      { type: "toolCall", call: { id: "call-1", name: name("one"), arguments: null } },
      { type: "stop", reason: "toolCall" },
    ],
  ]);
  const cancellations: Promise<boolean>[] = [];
  let cancelled = false;
  h.events.subscribe((event) => {
    if (cancelled || event.type !== "session.updated") return;
    const nodes = (event.data as unknown as { nodes: SessionNode[] }).nodes;
    if (!nodes.some((node) => node.role === "assistant")) return;
    cancelled = true;
    cancellations.push(h.driver.cancel("t1" as TurnId));
  });

  expect((await run(h, adapter, execute)).reason).toBe("cancelled");
  await Promise.all(cancellations);
  expect(invoke).not.toHaveBeenCalled();
  expect((await tree(h)).map((node) => node.role)).toEqual(["user", "assistant", "cancel"]);
  expect(
    h.published.filter((event) => event.type === "turn.step").map((event) => event.data),
  ).toEqual([{ turnId: "t1", step: 1, stopReason: "cancelled" }]);
});

test("publishes only a cancelled step when cancellation follows a no-tool assistant commit", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      { type: "content", delta: "partial" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  const cancellations: Promise<boolean>[] = [];
  let cancelled = false;
  h.events.subscribe((event) => {
    if (cancelled || event.type !== "session.updated") return;
    const nodes = (event.data as unknown as { nodes: SessionNode[] }).nodes;
    if (!nodes.some((node) => node.role === "assistant")) return;
    cancelled = true;
    cancellations.push(h.driver.cancel("t1" as TurnId));
  });

  expect((await run(h, adapter, execute)).reason).toBe("cancelled");
  await Promise.all(cancellations);
  expect((await tree(h)).map((node) => node.role)).toEqual(["user", "assistant", "cancel"]);
  expect(
    h.published.filter((event) => event.type === "turn.step").map((event) => event.data),
  ).toEqual([{ turnId: "t1", step: 1, stopReason: "cancelled" }]);
});

test("waits for launched tools, preserves result order, and stops before another step", async () => {
  const bothStarted = gate();
  const releaseTools = gate();
  const signals: AbortSignal[] = [];
  let started = 0;
  const tools = toolsWithInvoke(async (call, _selection, context) => {
    signals.push(context.signal);
    if (++started === 2) bothStarted.resolve();
    await releaseTools.promise;
    return { content: [{ type: "text", text: call.id }] };
  });
  const h = createLoopHarness({ tools });
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute, calls } = adapterFor([
    [
      { type: "toolCall", call: { id: "call-1", name: name("one"), arguments: null } },
      { type: "toolCall", call: { id: "call-2", name: name("two"), arguments: null } },
      { type: "stop", reason: "toolCall" },
    ],
    [
      { type: "content", delta: "must not run" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  const pending = run(h, adapter, execute);
  await bothStarted.promise;
  expect(await h.driver.cancel("t1" as TurnId)).toBe(true);
  releaseTools.resolve();
  expect((await pending).reason).toBe("cancelled");

  expect(calls()).toBe(1);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  const nodes = await tree(h);
  expect(nodes.map((node) => node.role)).toEqual(["user", "assistant", "tool", "tool", "cancel"]);
  expect(
    nodes.slice(2, 4).map((node) => (node.content[0] as { toolCallId: string }).toolCallId),
  ).toEqual(["call-1", "call-2"]);
});

test("handles an already-aborted signal before assembly", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const controller = new AbortController();
  controller.abort("before");
  const assemble = vi.spyOn(h.context, "assemble");
  const execute = vi.fn<ExecuteProvider>();
  const adapter: LlmAdapter = {
    dialect: "fake",
    buildRequest: vi.fn(() => ({ path: "/chat", body: "{}" })),
    parseChunk: () => [],
  };
  h.published.splice(0);

  const result = await run(h, adapter, execute, controller.signal);

  expect(result.reason).toBe("cancelled");
  expect(assemble).not.toHaveBeenCalled();
  expect(adapter.buildRequest).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(
    (await h.runExclusive(async () => h.context.snapshot().queue))[0]?.confirmedAt,
  ).toBeUndefined();
  expect(h.published.map((event) => event.type)).toEqual([
    "turn.started",
    "queue.updated",
    "turn.ended",
  ]);
  expect(h.published.at(-1)).toMatchObject({
    type: "turn.ended",
    data: { turnId: "t1", reason: "cancelled" },
  });
});

test("rejects a concurrent run while a turn is active", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const entered = gate();
  const resume = gate();
  const adapter: LlmAdapter = {
    dialect: "fake",
    buildRequest: (request) => ({ path: "/chat", body: JSON.stringify(request) }),
    parseChunk: (chunk) => JSON.parse(chunk) as LlmEvent[],
  };
  const execute: ExecuteProvider = async function* () {
    entered.resolve();
    await resume.promise;
    yield JSON.stringify([{ type: "stop", reason: "stop" }]);
  };
  const first = run(h, adapter, execute);
  await entered.promise;

  await expect(run(h, adapter, execute)).rejects.toMatchObject({ code: "turn.active" });
  await h.driver.cancel("t1" as TurnId);
  resume.resolve();
  await first;
});

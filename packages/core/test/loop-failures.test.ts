import { expect, test, vi } from "vitest";
import {
  createInterruptedToolResult,
  type EntryName,
  type ExecuteProvider,
  type LlmAdapter,
  type LlmEvent,
  PiscesError,
  type SessionNode,
  type ToolResult,
  type Tools,
  type TurnId,
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

function adapterFor(responses: LlmEvent[][] = []) {
  let call = 0;
  const adapter: LlmAdapter = {
    dialect: "fake",
    buildRequest: (request) => ({ path: "/chat", body: JSON.stringify(request) }),
    parseChunk: (chunk) => JSON.parse(chunk) as LlmEvent[],
  };
  const execute = vi.fn<ExecuteProvider>(async function* () {
    yield JSON.stringify(responses[call++] ?? []);
  });
  return { adapter, execute, calls: () => call };
}

function toolsWithInvoke(
  invoke: (
    call: Parameters<Tools["invoke"]>[0],
    selection: Parameters<Tools["invoke"]>[1],
    context: Parameters<Tools["invoke"]>[2],
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
    signal: new AbortController().signal,
  });
}

async function tree(h: ReturnType<typeof createLoopHarness>) {
  const nodes: SessionNode[] = [];
  for await (const node of h.sessions.readTree(LOOP_META.id)) nodes.push(node);
  return nodes;
}

test("fails turn.empty without building or executing a provider request", async () => {
  const h = createLoopHarness();
  const { adapter, execute } = adapterFor();
  const build = vi.spyOn(adapter, "buildRequest");

  expect(await run(h, adapter, execute)).toMatchObject({
    reason: "failed",
    error: { code: "turn.empty" },
  });
  expect(build).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test("preserves Context storage errors without provider execution", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const error = new PiscesError("storage.io", "context write failed");
  h.repository.failNextWrite("create", error);
  const { adapter, execute } = adapterFor();
  const build = vi.spyOn(adapter, "buildRequest");

  expect(await run(h, adapter, execute)).toMatchObject({
    reason: "failed",
    error: { code: "storage.io", message: "context write failed" },
  });
  expect(build).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test("redacts generic adapter construction failures", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor();
  adapter.buildRequest = () => {
    throw new Error("token=secret");
  };

  const result = await run(h, adapter, execute);
  expect(result.error).toEqual({
    code: "provider.invalid_response",
    message: "Provider request could not be built",
  });
  expect(JSON.stringify(h.published)).not.toContain("secret");
});

test("redacts generic parser failures", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor();
  adapter.parseChunk = () => {
    throw new Error("token=secret");
  };

  const result = await run(h, adapter, execute);
  expect(result.error).toEqual({
    code: "provider.invalid_response",
    message: "Provider response could not be parsed",
  });
  expect(JSON.stringify(h.published)).not.toContain("secret");
});

test("rejects a parser result that is not an event array", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor();
  adapter.parseChunk = () => ({}) as unknown as LlmEvent[];

  const result = await run(h, adapter, execute);
  expect(result.error).toEqual({
    code: "provider.invalid_response",
    message: "Adapter returned invalid events",
  });
});

test("redacts unknown adapter events", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [{ type: "unknown", token: "secret" } as unknown as LlmEvent],
  ]);

  const result = await run(h, adapter, execute);
  expect(result.error).toEqual({
    code: "provider.invalid_response",
    message: "Provider returned an unknown event",
  });
  expect(JSON.stringify(h.published)).not.toContain("secret");
});

test("rejects missing stop and invalid stop/call combinations", async () => {
  const cases: LlmEvent[][] = [
    [],
    [{ type: "stop", reason: "toolCall" }],
    [{ type: "stop", reason: "error" }],
    [{ type: "stop", reason: "cancelled" }],
  ];
  for (const events of cases) {
    const h = createLoopHarness();
    await h.enqueueAndConfirm([user("hello")]);
    const { adapter, execute } = adapterFor([events]);
    const result = await run(h, adapter, execute);
    expect(result.reason).toBe("failed");
    expect(result.error?.code).toBe("provider.invalid_response");
  }
});

test("rejects duplicate tool-call ids before assistant persistence or invocation", async () => {
  const invoke = vi.fn(async () => ({ content: [] }));
  const h = createLoopHarness({ tools: toolsWithInvoke(invoke) });
  await h.enqueueAndConfirm([user("hello")]);
  const call = { id: "duplicate", name: name("one"), arguments: null };
  const { adapter, execute } = adapterFor([
    [
      { type: "toolCall", call },
      { type: "toolCall", call: { ...call, name: name("two") } },
      { type: "stop", reason: "toolCall" },
    ],
  ]);

  const result = await run(h, adapter, execute);
  expect(result.error).toEqual({
    code: "provider.invalid_response",
    message: "Provider returned duplicate tool call ids",
  });
  expect(invoke).not.toHaveBeenCalled();
  expect((await tree(h)).map((node) => node.role)).toEqual(["user"]);
});

test("accepts parsed calls with a non-toolCall stop reason", async () => {
  const h = createLoopHarness({
    tools: toolsWithInvoke(async () => ({ content: [{ type: "text", text: "ok" }] })),
  });
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      { type: "toolCall", call: { id: "call-1", name: name("one"), arguments: null } },
      { type: "stop", reason: "stop" },
    ],
    [
      { type: "content", delta: "done" },
      { type: "stop", reason: "stop" },
    ],
  ]);

  expect((await run(h, adapter, execute)).reason).toBe("completed");
  expect(h.published.filter((event) => event.type === "turn.step")[0]?.data).toMatchObject({
    stopReason: "stop",
  });
});

test("preserves explicit provider errors and PiscesError transport codes", async () => {
  const explicit = createLoopHarness();
  await explicit.enqueueAndConfirm([user("hello")]);
  const providerError = adapterFor([
    [{ type: "error", code: "provider.refusal", message: "blocked" }],
  ]);
  expect((await run(explicit, providerError.adapter, providerError.execute)).error).toEqual({
    code: "provider.refusal",
    message: "blocked",
  });

  const timeout = createLoopHarness();
  await timeout.enqueueAndConfirm([user("hello")]);
  const timeoutAdapter = adapterFor();
  const timeoutExecute: ExecuteProvider = () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        throw new PiscesError("provider.timeout", "provider timed out");
      },
    }),
  });
  expect((await run(timeout, timeoutAdapter.adapter, timeoutExecute)).error).toEqual({
    code: "provider.timeout",
    message: "provider timed out",
  });
});

test("redacts generic executor failures as provider.transport", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter } = adapterFor();
  const execute: ExecuteProvider = () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        throw new Error("token=secret");
      },
    }),
  });

  const result = await run(h, adapter, execute);
  expect(result.error).toEqual({
    code: "provider.transport",
    message: "Provider transport failed",
  });
  expect(JSON.stringify(h.published)).not.toContain("secret");
});

test("returns independent synthetic interrupted results", () => {
  const first = createInterruptedToolResult("call-1");
  const second = createInterruptedToolResult("call-2");
  expect(first).toMatchObject({ toolCallId: "call-1", synthetic: "interrupted" });
  expect(second).toMatchObject({ toolCallId: "call-2", synthetic: "interrupted" });
  expect(first.content).not.toBe(second.content);
});

test("redacts EventBus failures and never retries committed state", async () => {
  const cases = [
    "turn.started",
    "context.session.updated",
    "assistant.session.updated",
    "turn.delta",
    "turn.step",
    "turn.ended",
  ];
  for (const failType of cases) {
    const h = createLoopHarness();
    await h.enqueueAndConfirm([user("hello")]);
    const { adapter, execute } = adapterFor([
      [
        { type: "content", delta: "hello" },
        { type: "stop", reason: "stop" },
      ],
    ]);
    let endedAttempts = 0;
    h.events.subscribe((event) => {
      if (event.type === "turn.ended") endedAttempts++;
      if (event.type === failType) throw new Error("subscriber secret");
      if (event.type === "session.updated") {
        const roles = (event.data as unknown as { nodes: SessionNode[] }).nodes.map(
          (node) => node.role,
        );
        if (failType === "context.session.updated" && roles.includes("user"))
          throw new Error("subscriber secret");
        if (failType === "assistant.session.updated" && roles.includes("assistant"))
          throw new Error("subscriber secret");
      }
    });
    if (failType === "turn.ended") {
      h.events.subscribe((event) => {
        if (event.type === "turn.ended") throw new Error("termination secret");
      });
    }

    const result = await run(h, adapter, execute);
    expect(result).toMatchObject({
      reason: "failed",
      error: { code: "event.publish_failed" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    if (failType === "turn.ended") expect(endedAttempts).toBe(1);
    if (failType === "turn.started") expect(execute).not.toHaveBeenCalled();
  }
});

test("stops at each driver storage append boundary", async () => {
  const io = () => new PiscesError("storage.io", "append failed");

  const assistant = createLoopHarness();
  await assistant.enqueueAndConfirm([user("hello")]);
  const assistantAdapter = adapterFor([
    [
      { type: "content", delta: "reply" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  assistant.repository.failNextWrite("append", io());
  expect(
    (await run(assistant, assistantAdapter.adapter, assistantAdapter.execute)).error?.code,
  ).toBe("storage.io");
  expect((await tree(assistant)).map((node) => node.role)).toEqual(["user"]);

  const tools = createLoopHarness({
    tools: toolsWithInvoke(async () => ({ content: [{ type: "text", text: "ok" }] })),
  });
  await tools.enqueueAndConfirm([user("hello")]);
  const toolAdapter = adapterFor([
    [
      { type: "toolCall", call: { id: "call-1", name: name("one"), arguments: null } },
      { type: "stop", reason: "toolCall" },
    ],
    [
      { type: "content", delta: "must not run" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  const originalAppend = tools.sessions.append;
  let appendCalls = 0;
  tools.sessions.append = async (...args) => {
    if (++appendCalls === 2) throw io();
    return originalAppend(...args);
  };
  expect((await run(tools, toolAdapter.adapter, toolAdapter.execute)).error?.code).toBe(
    "storage.io",
  );
  expect(toolAdapter.calls()).toBe(1);
  expect((await tree(tools)).map((node) => node.role)).toEqual(["user", "assistant"]);
});

test("keeps partial content when cancel-node persistence fails", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const entered = gate();
  const resume = gate();
  const adapter: LlmAdapter = {
    dialect: "fake",
    buildRequest: (request) => ({ path: "/chat", body: JSON.stringify(request) }),
    parseChunk: (chunk) => JSON.parse(chunk) as LlmEvent[],
  };
  const execute: ExecuteProvider = async function* (_request, signal) {
    yield JSON.stringify([{ type: "content", delta: "partial" }]);
    entered.resolve();
    await resume.promise;
    signal?.throwIfAborted();
  };
  const originalAppend = h.sessions.append;
  let appendCalls = 0;
  h.sessions.append = async (...args) => {
    if (++appendCalls === 2) throw new PiscesError("storage.io", "cancel append failed");
    return originalAppend(...args);
  };
  const pending = run(h, adapter, execute);
  await entered.promise;
  await h.driver.cancel("t1" as TurnId);
  resume.resolve();

  expect(await pending).toMatchObject({
    reason: "failed",
    error: { code: "storage.io" },
  });
  expect((await tree(h)).map((node) => node.role)).toEqual(["user", "assistant"]);
});

test("EventBus publishes synchronously and unsubscribe removes one handler", () => {
  const h = createLoopHarness();
  const order: string[] = [];
  const off = h.events.subscribe(() => order.push("first"));
  h.events.subscribe(() => order.push("second"));

  h.events.publish({
    type: "client.launched",
    at: "2026-11-08T00:00:00.000Z",
    data: { clientId: "c1", pid: 1 },
  });
  expect(order).toEqual(["first", "second"]);

  off();
  h.events.publish({
    type: "client.launched",
    at: "2026-11-08T00:00:00.000Z",
    data: { clientId: "c1", pid: 1 },
  });
  expect(order).toEqual(["first", "second", "second"]);
});

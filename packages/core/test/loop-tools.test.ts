import { expect, test } from "vitest";
import type {
  EntryName,
  ExecuteProvider,
  LlmAdapter,
  LlmEvent,
  LlmRequest,
  SelectionState,
  SessionNode,
  ToolCall,
  ToolInvocationContext,
  ToolResult,
  Tools,
  TurnId,
} from "../src/index.js";
import { createLoopHarness, LOOP_META, user } from "./support/loop-harness.js";

const name = (value: string) => `pkg#${value}` as EntryName;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    call: ToolCall,
    selection: SelectionState,
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

async function tree(h: ReturnType<typeof createLoopHarness>) {
  const nodes: SessionNode[] = [];
  for await (const node of h.sessions.readTree(LOOP_META.id)) nodes.push(node);
  return nodes;
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

test("executes tool calls concurrently and persists results in call order", async () => {
  const releases = new Map([
    [name("slow"), gate()],
    [name("fast"), gate()],
  ]);
  const bothStarted = gate();
  const started: string[] = [];
  const contexts: ToolInvocationContext[] = [];
  const tools = toolsWithInvoke(async (call, _selection, context) => {
    started.push(call.id);
    contexts.push(context);
    if (started.length === 2) bothStarted.resolve();
    await releases.get(call.name)?.promise;
    return { content: [{ type: "text", text: call.id }] };
  });
  const h = createLoopHarness({ tools });
  await h.enqueueAndConfirm([user("hello")]);
  const slow = name("slow");
  const fast = name("fast");
  const { adapter, execute, requests, calls } = adapterFor([
    [
      { type: "reasoning", delta: "check" },
      { type: "content", delta: "calling" },
      { type: "toolCall", call: { id: "call-slow", name: slow, arguments: { value: 1 } } },
      { type: "toolCall", call: { id: "call-fast", name: fast, arguments: { value: 2 } } },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "stop", reason: "toolCall" },
    ],
    [
      { type: "content", delta: "done" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } },
      { type: "stop", reason: "stop" },
    ],
  ]);
  h.published.splice(0);

  const pending = run(h, adapter, execute);
  const bothCallsStarted = await Promise.race([
    bothStarted.promise.then(() => true),
    pending.then(() => false),
  ]);
  expect(bothCallsStarted).toBe(true);
  expect(started).toEqual(["call-slow", "call-fast"]);
  releases.get(fast)?.resolve();
  releases.get(slow)?.resolve();
  const result = await pending;

  expect(result.reason).toBe("completed");
  expect(calls()).toBe(2);
  expect(contexts.map((context) => context.workspace)).toEqual(["/workspace", "/workspace"]);
  expect(
    h.published.filter((event) => event.type === "turn.delta").map((event) => event.data),
  ).toEqual([
    { turnId: "t1", step: 1, kind: "reasoning", delta: "check" },
    { turnId: "t1", step: 1, kind: "text", delta: "calling" },
    { turnId: "t1", step: 2, kind: "text", delta: "done" },
  ]);

  const nodes = await tree(h);
  expect(nodes.map((node) => node.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
    "assistant",
  ]);
  expect(nodes.slice(1).map((node) => node.parentId)).toEqual([
    nodes[0]?.id,
    nodes[1]?.id,
    nodes[2]?.id,
    nodes[3]?.id,
  ]);
  expect(nodes[1]?.content).toEqual([
    { type: "reasoning", text: "check" },
    { type: "text", text: "calling" },
    { type: "toolCall", id: "call-slow", name: slow, arguments: { value: 1 } },
    { type: "toolCall", id: "call-fast", name: fast, arguments: { value: 2 } },
  ]);
  expect(nodes[2]?.content).toEqual([
    {
      type: "toolResult",
      toolCallId: "call-slow",
      content: [{ type: "text", text: "call-slow" }],
    },
  ]);
  expect(nodes[3]?.content).toEqual([
    {
      type: "toolResult",
      toolCallId: "call-fast",
      content: [{ type: "text", text: "call-fast" }],
    },
  ]);
  expect(nodes[4]?.content).toEqual([{ type: "text", text: "done" }]);

  expect(requests[1]?.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
  ]);
  const steps = h.published
    .filter((event) => event.type === "turn.step")
    .map((event) => event.data);
  expect(steps).toEqual([
    {
      turnId: "t1",
      step: 1,
      stopReason: "toolCall",
      usage: { inputTokens: 1, outputTokens: 2 },
    },
    {
      turnId: "t1",
      step: 2,
      stopReason: "stop",
      usage: { inputTokens: 3, outputTokens: 4 },
    },
  ]);
});

test("persists tool-only assistant content and continues after a tool error", async () => {
  const h = createLoopHarness({
    tools: toolsWithInvoke(async () => ({
      content: [{ type: "text", text: "failed safely" }],
      isError: true,
      code: "tool.failed",
    })),
  });
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      {
        type: "toolCall",
        call: { id: "call-error", name: name("error"), arguments: { value: true } },
      },
      { type: "stop", reason: "toolCall" },
    ],
    [
      { type: "content", delta: "recovered" },
      { type: "stop", reason: "stop" },
    ],
  ]);

  expect((await run(h, adapter, execute)).reason).toBe("completed");
  const nodes = await tree(h);
  expect(nodes[1]?.content).toEqual([
    {
      type: "toolCall",
      id: "call-error",
      name: name("error"),
      arguments: { value: true },
    },
  ]);
  expect(nodes[2]?.content).toEqual([
    {
      type: "toolResult",
      toolCallId: "call-error",
      content: [{ type: "text", text: "failed safely" }],
      isError: true,
      code: "tool.failed",
    },
  ]);
  expect(nodes[3]?.content).toEqual([{ type: "text", text: "recovered" }]);
});

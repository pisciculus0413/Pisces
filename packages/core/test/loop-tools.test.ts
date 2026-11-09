import { expect, test } from "vitest";
import type {
  Context,
  DefinitionSnapshot,
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
import { createTools } from "../src/index.js";
import { declaration } from "./support/context-harness.js";
import { createLoopHarness, LOOP_META, user } from "./support/loop-harness.js";

const name = (value: string) => `pkg#${value}` as EntryName;
const definition = (
  entry: EntryName,
  value: string,
  kind: "tool" | "wrapper" = "tool",
): DefinitionSnapshot => ({
  name: entry,
  kind,
  description: value,
  parameters: {},
  definitionHash: `hash-${value}`,
  ...(kind === "wrapper" ? { configHash: `config-${value}` } : {}),
});

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
  context: Context = h.context,
) {
  return h.driver.run({
    sessionId: LOOP_META.id,
    turnId: "t1" as TurnId,
    meta: LOOP_META,
    context,
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

function strictTools() {
  const toolName = name("tool");
  const wrapperName = name("wrapper");
  const base = createTools();
  let toolCalls = 0;
  let wrapperCalls = 0;
  base.registerTool({
    id: "t1",
    source: "ext",
    name: toolName,
    description: "tool",
    parameters: {},
    execute: async () => {
      toolCalls++;
      return { content: [{ type: "text", text: "ran" }] };
    },
  });
  base.registerWrapper(wrapperName, () => {
    wrapperCalls++;
    return (wrapped) => wrapped;
  });
  const selections: SelectionState[] = [];
  const tools: Tools = {
    forInventory: () => tools,
    registerTool: base.registerTool,
    registerWrapper: base.registerWrapper,
    selected: base.selected,
    invoke(call, selection, context) {
      selections.push([...selection]);
      return base.invoke(call, selection, context);
    },
  };
  return {
    toolName,
    wrapperName,
    tools,
    selections,
    toolCalls: () => toolCalls,
    wrapperCalls: () => wrapperCalls,
  };
}

const forgedCalls: LlmEvent[][] = [
  [
    {
      type: "toolCall",
      call: { id: "call-tool", name: name("tool"), arguments: {} },
    },
    { type: "stop", reason: "toolCall" },
  ],
  [
    { type: "content", delta: "done" },
    { type: "stop", reason: "stop" },
  ],
];

test("invokes only the execution subset and fails forged calls for stale tools", async () => {
  const strict = strictTools();
  const h = createLoopHarness({ tools: strict.tools });
  h.deps.entries = {
    kind: (entry) =>
      entry === strict.toolName ? "tool" : entry === strict.wrapperName ? "wrapper" : undefined,
    matchesDefinition: () => false,
  };
  await h.enqueueAndConfirm([
    declaration({
      toggle: [strict.toolName, strict.wrapperName],
      definitions: [
        definition(strict.toolName, "frozen"),
        definition(strict.wrapperName, "frozen", "wrapper"),
      ],
    }),
    user("hello"),
  ]);
  const { adapter, execute, requests } = adapterFor(forgedCalls);

  expect((await run(h, adapter, execute)).reason).toBe("completed");
  expect(requests[0]?.tools ?? []).toEqual([]);
  expect(strict.selections).toEqual([[]]);
  expect(strict.toolCalls()).toBe(0);
  expect(strict.wrapperCalls()).toBe(0);
  const nodes = await tree(h);
  expect(nodes.find((node) => node.role === "tool")?.content).toEqual([
    {
      type: "toolResult",
      toolCallId: "call-tool",
      content: [{ type: "text", text: "Tool is not selected: pkg#tool" }],
      isError: true,
      code: "tool.failed",
    },
  ]);
});

test("falls back to the full selection for contexts without executionSelection", async () => {
  const strict = strictTools();
  const h = createLoopHarness({ tools: strict.tools });
  h.deps.entries = {
    kind: (entry) =>
      entry === strict.toolName ? "tool" : entry === strict.wrapperName ? "wrapper" : undefined,
    matchesDefinition: () => false,
  };
  await h.enqueueAndConfirm([
    declaration({
      toggle: [strict.toolName, strict.wrapperName],
      definitions: [
        definition(strict.toolName, "frozen"),
        definition(strict.wrapperName, "frozen", "wrapper"),
      ],
    }),
    user("hello"),
  ]);
  const legacy: Context = {
    ...h.context,
    async assemble(options) {
      const { executionSelection: _ignored, ...rest } = await h.context.assemble(options);
      return rest;
    },
  };
  const { adapter, execute } = adapterFor(forgedCalls);

  expect((await run(h, adapter, execute, legacy)).reason).toBe("completed");
  expect(strict.selections[0]).toEqual([strict.toolName, strict.wrapperName]);
  expect(strict.toolCalls()).toBe(1);
  expect(strict.wrapperCalls()).toBe(1);
});

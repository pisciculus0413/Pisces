import { expect, test } from "vitest";
import type {
  EntryInfo,
  EntryName,
  SelectionState,
  SessionId,
  ToolCall,
  ToolDeclaration,
  ToolInvocationContext,
  ToolResult,
} from "../src/index.js";
import { createTools } from "../src/index.js";

const name = (value: string) => value as EntryName;
const entry = (value: string, type: EntryInfo["type"]): EntryInfo => ({
  type,
  source: "test",
  name: name(value),
});
const result = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
});
const textOf = (value: ToolResult): string =>
  value.content[0]?.type === "text" ? value.content[0].text : "";
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const context: ToolInvocationContext = {
  sessionId: "s1" as SessionId,
  workspace: "/workspace",
  signal: new AbortController().signal,
};

test("preserves caller order when tool results settle out of order", async () => {
  const slowGate = gate();
  const fastGate = gate();
  const slowStarted = gate();
  const fastStarted = gate();
  const settled: string[] = [];
  let wrapperLoads = 0;
  const catalog = createTools();
  const tool = (value: string, body: () => Promise<ToolResult>): ToolDeclaration => ({
    id: `id:${value}`,
    source: "test",
    name: name(value),
    description: value,
    parameters: {},
    execute: body,
  });
  catalog.registerTool(
    tool("pkg#slow", async () => {
      slowStarted.release();
      await slowGate.promise;
      settled.push("slow");
      return result("slow");
    }),
  );
  catalog.registerTool(
    tool("pkg#fast", async () => {
      fastStarted.release();
      await fastGate.promise;
      settled.push("fast");
      return result("fast");
    }),
  );
  catalog.registerWrapper(name("pkg#audit"), () => {
    wrapperLoads++;
    return (wrapped) => wrapped;
  });
  const selection = ["pkg#slow", "pkg#fast", "pkg#audit"] as SelectionState;
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#slow", "tool"), entry("pkg#fast", "tool"), entry("pkg#audit", "wrapper")],
  });
  const calls: ToolCall[] = [
    { id: "call-slow", name: name("pkg#slow"), arguments: null },
    { id: "call-fast", name: name("pkg#fast"), arguments: null },
  ];
  const pending = calls.map((call) => facade.invoke(call, selection, context));
  const [slowPending, fastPending] = pending;
  if (slowPending === undefined || fastPending === undefined)
    throw new Error("Expected both tool invocations to start");

  await Promise.all([slowStarted.promise, fastStarted.promise]);
  fastGate.release();
  expect(textOf(await fastPending)).toBe("fast");
  expect(settled).toEqual(["fast"]);
  slowGate.release();
  const results = await Promise.all([slowPending, fastPending]);
  expect(settled).toEqual(["fast", "slow"]);
  expect(results.map(textOf)).toEqual(["slow", "fast"]);
  expect(wrapperLoads).toBe(1);
});

test("snapshots call arguments and context per invocation", async () => {
  const catalog = createTools();
  const contexts: ToolInvocationContext[] = [];
  catalog.registerTool({
    id: "id:pkg#echo",
    source: "test",
    name: name("pkg#echo"),
    description: "echo",
    parameters: {},
    execute: async (_args, invocationContext) => {
      contexts.push(invocationContext);
      return result("ok");
    },
  });
  catalog.registerWrapper(name("pkg#mutate-args"), () => (wrapped) => ({
    ...wrapped,
    execute: async (args) => {
      (args as { value: number }).value = 2;
      return result("ok");
    },
  }));
  const selection = ["pkg#echo", "pkg#mutate-args"] as SelectionState;
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#mutate-args", "wrapper")],
  });
  const original: ToolCall = {
    id: "call-1",
    name: name("pkg#echo"),
    arguments: { value: 1 },
  };
  const before = structuredClone(original);
  const output = await facade.invoke(original, selection, context);

  expect(original).toEqual(before);
  expect({ toolCallId: original.id, result: output }).toEqual({
    toolCallId: "call-1",
    result: result("ok"),
  });

  const withoutMutation = createTools();
  withoutMutation.registerTool({
    id: "id:pkg#echo",
    source: "test",
    name: name("pkg#echo"),
    description: "echo",
    parameters: {},
    execute: async (_args, invocationContext) => {
      contexts.push(invocationContext);
      return result("ok");
    },
  });
  const plainFacade = withoutMutation.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });
  await Promise.all([
    plainFacade.invoke(
      { id: "call-2", name: name("pkg#echo"), arguments: { value: 1 } },
      ["pkg#echo"] as SelectionState,
      context,
    ),
    plainFacade.invoke(
      { id: "call-3", name: name("pkg#echo"), arguments: { value: 1 } },
      ["pkg#echo"] as SelectionState,
      context,
    ),
  ]);
  expect(contexts.at(0)).not.toBe(contexts.at(1));
  expect(contexts.at(0)?.signal).toBe(context.signal);
});

test("passes an already-aborted signal through without suppressing execution", async () => {
  const controller = new AbortController();
  controller.abort("before");
  let calls = 0;
  let received: AbortSignal | undefined;
  const catalog = createTools();
  catalog.registerTool({
    id: "id:pkg#echo",
    source: "test",
    name: name("pkg#echo"),
    description: "echo",
    parameters: {},
    execute: async (_args, invocationContext) => {
      calls++;
      received = invocationContext.signal;
      return result("ok");
    },
  });
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });

  expect(
    await facade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      ["pkg#echo"] as SelectionState,
      { ...context, signal: controller.signal },
    ),
  ).toEqual(result("ok"));
  expect(calls).toBe(1);
  expect(received).toBe(controller.signal);
});

test("lets a running tool observe cancellation without injecting an error", async () => {
  const controller = new AbortController();
  const started = gate();
  const release = gate();
  const catalog = createTools();
  catalog.registerTool({
    id: "id:pkg#echo",
    source: "test",
    name: name("pkg#echo"),
    description: "echo",
    parameters: {},
    execute: async (_args, invocationContext) => {
      started.release();
      await release.promise;
      return result(invocationContext.signal.aborted ? "observed" : "missed");
    },
  });
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });
  const pending = facade.invoke(
    { id: "call-1", name: name("pkg#echo"), arguments: null },
    ["pkg#echo"] as SelectionState,
    { ...context, signal: controller.signal },
  );

  await started.promise;
  controller.abort("cancel");
  release.release();
  expect(await pending).toEqual(result("observed"));
});

test("maps a tool-thrown AbortError to tool.failed", async () => {
  const catalog = createTools();
  catalog.registerTool({
    id: "id:pkg#echo",
    source: "test",
    name: name("pkg#echo"),
    description: "echo",
    parameters: {},
    execute: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  });
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });

  expect(
    await facade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      ["pkg#echo"] as SelectionState,
      context,
    ),
  ).toEqual({
    content: [{ type: "text", text: "Tool execution failed" }],
    isError: true,
    code: "tool.failed",
  });
});

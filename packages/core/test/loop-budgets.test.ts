import { expect, test, vi } from "vitest";
import type {
  ContentBlock,
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
import { createEventPublisher } from "../src/index.js";
import { createLoopHarness, LOOP_META, user } from "./support/loop-harness.js";

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
  return { adapter, execute };
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

async function tree(h: ReturnType<typeof createLoopHarness>) {
  const nodes: SessionNode[] = [];
  for await (const node of h.sessions.readTree(LOOP_META.id)) nodes.push(node);
  return nodes;
}

function run(
  h: ReturnType<typeof createLoopHarness>,
  adapter: LlmAdapter,
  execute: ExecuteProvider,
  contextWindow = 100000,
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
    contextWindow,
    maxOutput: 1000,
    signal: new AbortController().signal,
  });
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

test("splits large deltas and persists text-safe assistant content", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const delta = "🐟".repeat(1_200_000);
  const { adapter, execute } = adapterFor([
    [
      { type: "content", delta },
      { type: "stop", reason: "stop" },
    ],
  ]);
  h.published.splice(0);

  expect((await run(h, adapter, execute)).reason).toBe("completed");

  const frames = h.published
    .filter((event) => event.type === "turn.delta")
    .map((event) => event.data as { delta: string });
  expect(frames.map((frame) => frame.delta).join("")).toBe(delta);
  expect(frames.every((frame) => isWellFormed(frame.delta))).toBe(true);
  for (const event of h.published)
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(4194303);

  const assistant = (await tree(h))[1];
  if (!assistant) throw new Error("Expected assistant node");
  const bytes = new TextEncoder().encode(JSON.stringify(assistant.content)).length;
  expect(bytes).toBeLessThanOrEqual(262144);
  expect(assistant.content.at(-1)).toMatchObject({
    type: "text",
  });
  const textBlock = assistant.content.at(-1);
  if (textBlock?.type !== "text") throw new Error("Expected assistant text");
  expect(textBlock.text.endsWith("\n[truncated]")).toBe(true);
});

test("does not publish an empty delta or consume a sequence", () => {
  const h = createLoopHarness();
  const before = h.published.length;
  const beforeSeq = h.eventClock.current();
  const publisher = createEventPublisher({
    sessionId: LOOP_META.id,
    events: h.events,
    eventClock: h.eventClock,
    now: h.now,
  });

  publisher.publishDelta("t1" as TurnId, 1, "text", "");

  expect(h.published).toHaveLength(before);
  expect(h.eventClock.current()).toBe(beforeSeq);
});

test("rejects an indivisible oversized assistant node before append", async () => {
  const h = createLoopHarness();
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      {
        type: "toolCall",
        call: {
          id: "call-large",
          name: name("large"),
          arguments: { value: "x".repeat(4_200_000) },
        },
      },
      { type: "stop", reason: "toolCall" },
    ],
  ]);
  const append = vi.spyOn(h.repository, "append");

  const result = await run(h, adapter, execute);

  expect(result).toMatchObject({
    reason: "failed",
    error: { code: "provider.invalid_response" },
  });
  expect(append).not.toHaveBeenCalled();
  expect((await tree(h)).map((node) => node.role)).toEqual(["user"]);
});

test("splits a large tool-result batch only between whole ordered nodes", async () => {
  const h = createLoopHarness({
    tools: toolsWithInvoke(async (call) => ({
      content: [
        {
          type: "toolCall",
          id: `nested-${call.id}`,
          name: name("nested"),
          arguments: { value: "x".repeat(2_100_000) },
        },
      ],
    })),
  });
  await h.enqueueAndConfirm([user("hello")]);
  const { adapter, execute } = adapterFor([
    [
      {
        type: "toolCall",
        call: { id: "call-1", name: name("one"), arguments: null },
      },
      {
        type: "toolCall",
        call: { id: "call-2", name: name("two"), arguments: null },
      },
      { type: "stop", reason: "toolCall" },
    ],
    [
      { type: "content", delta: "done" },
      { type: "stop", reason: "stop" },
    ],
  ]);
  h.published.splice(0);

  expect((await run(h, adapter, execute, 20_000_000)).reason).toBe("completed");

  const frames = h.published.filter(
    (event) =>
      event.type === "session.updated" &&
      (event.data as unknown as { nodes: SessionNode[] }).nodes.some(
        (node) => node.role === "tool",
      ),
  );
  expect(frames).toHaveLength(2);
  expect(
    frames.map((event) =>
      (event.data as unknown as { nodes: SessionNode[] }).nodes.map(
        (node) => (node.content[0] as Extract<ContentBlock, { type: "toolResult" }>).toolCallId,
      ),
    ),
  ).toEqual([["call-1"], ["call-2"]]);

  const tools = (await tree(h)).filter((node) => node.role === "tool");
  expect(tools.map((node) => node.parentId)).toEqual(
    tools.map((_, index) => (index === 0 ? tools[0]?.parentId : tools[index - 1]?.id)),
  );
  for (const node of tools) {
    const result = node.content[0];
    if (result?.type !== "toolResult") throw new Error("Expected tool result");
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      arguments: { value: "x".repeat(2_100_000) },
    });
  }
});

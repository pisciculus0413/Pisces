import { expect, test } from "vitest";
import { budgetContext, estimateTokens, summarize } from "../src/context/budget.js";
import type { RequestToolDeclaration } from "../src/context/types.js";
import type { ContentBlock, EntryName, Message } from "../src/messages.js";
import type { NodeId, SessionNode, SessionNodeDraft } from "../src/sessions/types.js";

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];
const name = "pkg#tool" as EntryName;
const draft = (
  value: string,
  role: Message["role"] = "user",
  source = "user",
): SessionNodeDraft => ({
  kind: "agent",
  role,
  source,
  content: text(value),
});
const history = (drafts: SessionNodeDraft[]): SessionNode[] =>
  drafts.map((node, i) => ({
    ...node,
    id: `n${i}` as NodeId,
    parentId: `n${Math.max(0, i - 1)}` as NodeId,
    createdAt: "2026-11-07T00:00:00Z",
    schemaVersion: 1,
  }));
const run = (
  branch: SessionNode[] = [],
  drafts: SessionNodeDraft[] = [],
  options: Partial<Parameters<typeof budgetContext>[0]> = {},
) =>
  budgetContext({
    branch,
    drafts,
    selection: [],
    tools: [],
    contextWindow: 1024,
    maxOutput: 0,
    ...options,
  });
const message = (node: SessionNodeDraft): Message => ({
  role: node.role as Message["role"],
  content: node.content,
});
const call = (...ids: string[]): SessionNodeDraft => ({
  ...draft("", "assistant"),
  content: ids.map((id) => ({ type: "toolCall", id, name, arguments: {} })),
});
const result = (id: string, value = "ok"): SessionNodeDraft => ({
  ...draft("", "tool"),
  content: [{ type: "toolResult", toolCallId: id, content: text(value) }],
});
const control = (role: "declaration" | "cancel", value: unknown = {}): SessionNodeDraft => ({
  kind: "control",
  role,
  source: "user",
  content: text(JSON.stringify(value)),
});
const compact = (from: string, to: string, summary = "stored"): SessionNodeDraft => ({
  kind: "control",
  role: "compaction",
  source: "compaction",
  content: text(JSON.stringify({ from, to, summary })),
});
const payloads = (nodes: SessionNodeDraft[]) =>
  nodes.map((node) => JSON.parse((node.content[0] as { text: string }).text));

// A user message with 4 x's has 57 JSON bytes / 3 = 19 tokens.
test("uses UTF-8 JSON size including reasoning and arguments", () => {
  expect(estimateTokens("a")).toBe(1);
  expect(estimateTokens("ab")).toBe(2);
  expect(estimateTokens("😀")).toBe(2);
  expect(estimateTokens(message(draft("xxxx")))).toBe(19);
  expect(estimateTokens({ type: "reasoning", text: "😀" })).toBe(12);
  expect(estimateTokens({ arguments: { a: "中" } })).toBe(9);
});

test("allows exactly B and removes the oldest message at B + 1", () => {
  // JSON overhead is 53 bytes; 3019 x's makes exactly 1024 tokens.
  const exact = draft("x".repeat(3019));
  expect(run([], [exact]).messages).toEqual([message(exact)]);
  expect(run([], [draft("x".repeat(3020))]).messages).toEqual([]);
  // Per-message rounding matters: two empty messages are 18 + 18 tokens.
  expect(run([], [draft(""), draft(""), draft("x".repeat(2911))]).messages).toHaveLength(3);
  expect(run([], [draft(""), draft(""), draft("x".repeat(2912))]).messages).toHaveLength(2);
});

test("uses zero reserve for empty tools and exactly serialized public tool fields otherwise", () => {
  // 3300 JSON bytes = 1100 tokens; B stays above its 1024 floor.
  const exact = draft("x".repeat(3247));
  expect(run([], [exact], { contextWindow: 1300, maxOutput: 200 }).messages).toHaveLength(1);
  const tool: RequestToolDeclaration = { name, description: "", parameters: {} };
  // Tool JSON is 54 bytes => reserve 18; runtime fields are excluded.
  expect(estimateTokens([tool])).toBe(18);
  const enriched = Object.assign({}, tool, { id: "x".repeat(999), source: "x".repeat(999) });
  expect(
    run([], [exact], { tools: [enriched], contextWindow: 1318, maxOutput: 200 }).messages,
  ).toHaveLength(1);
  const larger = draft("x".repeat(3248)); // 1101 tokens
  expect(
    run([], [larger], { tools: [enriched], contextWindow: 1318, maxOutput: 200 }).messages,
  ).toEqual([]);
  expect(
    run([], [draft("x".repeat(3019))], { contextWindow: 1, maxOutput: 9000 }).messages,
  ).toHaveLength(1);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid context window %s",
  (contextWindow) => {
    expect(() => run([], [], { contextWindow })).toThrow(TypeError);
  },
);
test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid max output %s",
  (maxOutput) => {
    expect(() => run([], [], { maxOutput })).toThrow(TypeError);
  },
);

test("projects only selected EntryName sources, retaining all instructions and omitting controls", () => {
  const nodes = history([
    draft("create", "system", "create"),
    draft("i1", "system", "instruction"),
    draft("gone", "system", "missing#old"),
    draft("kept", "system", "pkg#selected"),
    control("declaration", { toggle: ["pkg#selected"] }),
    control("cancel"),
    draft("i2", "system", "instruction"),
    draft("ordinary", "user", "not-an-entry"),
  ]);
  const pending = draft("pending", "system", "missing#draft");
  const output = run(nodes, [pending], { selection: ["pkg#selected" as EntryName] });
  expect(output.messages).toEqual(
    [nodes[0], nodes[1], nodes[3], nodes[6], nodes[7]].map((n) => message(n as SessionNode)),
  );
  output.messages[0]?.content.push(...text("mutated"));
  expect(nodes[0]?.content).toEqual(text("create"));
  expect(pending.content).toEqual(text("pending"));
});

test("drops create and selected source messages while retaining every instruction verbatim", () => {
  const instructions = [draft("i1", "system", "instruction"), draft("i2", "system", "instruction")];
  expect(
    run(
      [],
      [
        draft("x".repeat(4000), "system", "create"),
        draft("x".repeat(4000), "system", "pkg#selected"),
        ...instructions,
      ],
      {
        selection: ["pkg#selected" as EntryName],
      },
    ).messages,
  ).toEqual(instructions.map(message));
  expect(() => run([], [draft("x".repeat(4000), "system", "instruction")])).toThrowError(
    expect.objectContaining({ code: "context.window_exceeded" }),
  );
});

test("trims multi-call groups atomically across user and system messages", () => {
  const group = [
    call("a", "b"),
    draft("middle"),
    draft("context", "system", "create"),
    result("a"),
    result("b"),
  ];
  expect(run([], [...group, draft("x".repeat(2800))]).messages).toEqual([
    message(draft("x".repeat(2800))),
  ]);
  expect(run([], group).messages).toEqual(group.map(message));
});

test("merges overlapping tool intervals", () => {
  const nodes = [call("a"), call("b"), result("a"), draft("between"), result("b")];
  expect(run([], [...nodes, draft("x".repeat(2800))]).messages).toEqual([
    message(draft("x".repeat(2800))),
  ]);
});

test("protects whole tool groups crossing instructions or waiting for any result", () => {
  const protectedGroup = [
    call("a"),
    draft("i", "system", "instruction"),
    result("a", "x".repeat(4000)),
  ];
  expect(() => run([], protectedGroup)).toThrowError(
    expect.objectContaining({ code: "context.window_exceeded" }),
  );
  expect(() => run([], [call("a", "b"), result("a", "x".repeat(4000))])).toThrowError(
    expect.objectContaining({ code: "context.window_exceeded" }),
  );
  const open = [call("a"), draft("tail")];
  expect(run([], open).messages).toEqual(open.map(message));
});

test.each([
  { nodes: [result("orphan")] },
  { nodes: [call("a"), call("a")] },
  { nodes: [call("a"), result("a"), result("a")] },
  { nodes: [result("a"), call("a")] },
])("rejects corrupt tool pairing %# before trimming", ({ nodes }) => {
  expect(() => run(history(nodes))).toThrowError(
    expect.objectContaining({ code: "storage.corrupt" }),
  );
});

test("does not pair nested tool results", () => {
  const nested = result("a");
  nested.content = [
    {
      type: "toolResult",
      toolCallId: "a",
      content: [{ type: "toolResult", toolCallId: "nested", content: text("text") }],
    },
  ];
  expect(run([], [call("a"), nested]).messages).toEqual([call("a"), nested].map(message));
});

test("applies a valid inclusive range at its start and preserves surrounding messages", () => {
  const branch = history([
    draft("before"),
    draft("a"),
    draft("b"),
    draft("after"),
    compact("n1", "n2"),
  ]);
  expect(run(branch).messages).toEqual([
    message(branch[0] as SessionNode),
    { role: "system", content: text("stored") },
    message(branch[3] as SessionNode),
  ]);
});

test.each([
  ["n2", "n1"],
  ["other-branch", "n2"],
  ["n0", "absent"],
])("ignores invalid stored range %s..%s", (from, to) => {
  const nodes = [draft("a"), draft("b"), draft("c")];
  expect(run(history([...nodes, compact(from, to)])).messages).toEqual(nodes.map(message));
});

test("accepts the first valid stored range and ignores later overlaps", () => {
  const branch = history([
    draft("a"),
    draft("b"),
    draft("c"),
    draft("d"),
    compact("n0", "n1", "first"),
    compact("n1", "n3", "overlap"),
    compact("n2", "n3", "second"),
  ]);
  expect(run(branch).messages).toEqual([
    { role: "system", content: text("first") },
    { role: "system", content: text("second") },
  ]);
});

test("ignores stored ranges swallowing instructions or only part of a tool group", () => {
  const group = [call("a", "b"), draft("middle"), result("a"), result("b")];
  for (const [from, to] of [
    ["n0", "n2"],
    ["n1", "n3"],
    ["n2", "n3"],
  ]) {
    expect(run(history([...group, compact(from as string, to as string)])).messages).toEqual(
      group.map(message),
    );
  }
  expect(run(history([...group, compact("n0", "n3")])).messages).toEqual([
    { role: "system", content: text("stored") },
  ]);
  const withInstruction = [draft("a"), draft("i", "system", "instruction"), draft("b")];
  expect(run(history([...withInstruction, compact("n0", "n2")])).messages).toEqual(
    withInstruction.map(message),
  );
  const open = [call("a"), draft("tail")];
  expect(run(history([...open, compact("n0", "n1")])).messages).toEqual(open.map(message));
});

test("does not compact drafts or summarize a discarded existing summary", () => {
  const nodes = history([draft("old"), compact("n0", "n0", "x".repeat(4000))]);
  expect(run(nodes).compactions).toEqual([]);
  const drafts = [
    draft("x".repeat(500)),
    draft("x".repeat(500)),
    draft("x".repeat(500)),
    draft("x".repeat(500)),
    draft("x".repeat(3000)),
  ];
  expect(run([], drafts).compactions).toEqual([]);
  expect(drafts[0]).not.toHaveProperty("id");
});

// 53 bytes overhead: lengths 151,151,151 cost 68 each = 204; 154 costs 69.
test.each([
  [151, 0],
  [154, 1],
])("uses ceil(B/5)=205 as the exact three-node threshold (%s)", (lastLength, count) => {
  const branch = history([
    draft("x".repeat(151)),
    draft("x".repeat(151)),
    draft("x".repeat(lastLength)),
  ]);
  const output = run(branch, [draft("x".repeat(3019))]);
  expect(output.compactions).toHaveLength(count);
  if (count) expect(payloads(output.compactions)[0]).toMatchObject({ from: "n0", to: "n2" });
  expect(output.messages).toEqual([message(draft("x".repeat(3019)))]);
});

test("compacts four small historical nodes and merges ranges after summary forces more trimming", () => {
  const branch = history(Array.from({ length: 6 }, () => draft("x")));
  // Last message 1024 forces all six old messages out. One final merged range only.
  const output = run(branch, [draft("x".repeat(3019))]);
  expect(payloads(output.compactions)).toEqual([
    { from: "n0", to: "n5", summary: `[compaction]\n${Array(6).fill("user: x").join("\n")}` },
  ]);
  expect(output.messages).toEqual([message(draft("x".repeat(3019)))]);
  const four = history(Array.from({ length: 4 }, () => draft("x")));
  expect(payloads(run(four, [draft("x".repeat(3019))]).compactions)[0]).toMatchObject({
    from: "n0",
    to: "n3",
  });
});

test("recomputes adjacent historical range when its added summary causes another removal", () => {
  // Old message costs 351; retained history costs 18; draft costs 1004.
  // Initial deletion leaves 1022, but its summary exceeds the 2-token gap.
  const branch = history([draft("x".repeat(1000)), draft("")]);
  const output = run(branch, [draft("x".repeat(2959))]);
  expect(payloads(output.compactions)[0]).toMatchObject({ from: "n0", to: "n0" });
  // Summary is the oldest removable message, so it is removed before n1.
  expect(output.messages).toEqual([message(draft("")), message(draft("x".repeat(2959)))]);
});

test("separates new compaction ranges at declarations, instructions and applied ranges", () => {
  const large = () => draft("x".repeat(700));
  const branch = history([
    large(),
    control("declaration", { toggle: [] }),
    large(),
    draft("i", "system", "instruction"),
    large(),
    compact("n4", "n4", "stored"),
    large(),
  ]);
  const output = run(branch, [draft("x".repeat(2800))]);
  expect(payloads(output.compactions).map(({ from, to }) => [from, to])).toEqual([
    ["n0", "n0"],
    ["n2", "n2"],
    ["n6", "n6"],
  ]);
  expect(
    output.messages.some((m) => m.content[0]?.type === "text" && m.content[0].text === "i"),
  ).toBe(true);
});

test("omits new partial tool-group ranges split by declarations or drafts", () => {
  const branch = history([
    call("a"),
    control("declaration", { toggle: [] }),
    result("a", "x".repeat(1000)),
  ]);
  expect(run(branch, [draft("x".repeat(3000))]).compactions).toEqual([]);
  const crossDraft = history([call("b")]);
  expect(
    run(crossDraft, [result("b", "x".repeat(1000)), draft("x".repeat(3000))]).compactions,
  ).toEqual([]);
});

test("replaying generated compactions preserves complete tool groups and instructions within budget", () => {
  const branch = history([
    call("a"),
    result("a", "x".repeat(1200)),
    draft("i", "system", "instruction"),
    call("b"),
    result("b"),
  ]);
  const output = run(branch, [draft("x".repeat(2700))]);
  expect(payloads(output.compactions)[0]).toMatchObject({ from: "n0", to: "n1" });
  const replayed = run(history([...branch, ...output.compactions]), [draft("x".repeat(2700))]);
  expect(replayed.messages).toEqual(output.messages);
  expect(
    replayed.messages.some((m) => m.content[0]?.type === "text" && m.content[0].text === "i"),
  ).toBe(true);
  expect(replayed.messages.reduce((sum, m) => sum + estimateTokens(m), 0)).toBeLessThanOrEqual(
    1024,
  );
});

test("summarizes exact ordered text, reasoning, calls and recursive results", () => {
  expect(summarize(history([draft("hello"), draft("world", "assistant")]))).toBe(
    "[compaction]\nuser: hello\nassistant: world",
  );
  const mixed = draft("");
  mixed.content = [
    ...text("first"),
    { type: "reasoning", text: "thought" },
    { type: "toolCall", id: "a", name, arguments: { x: 1 } },
    {
      type: "toolResult",
      toolCallId: "a",
      content: [
        ...text("answer"),
        {
          type: "toolResult",
          toolCallId: "inner",
          content: [{ type: "reasoning", text: "nested" }],
        },
      ],
    },
  ];
  expect(summarize(history([mixed]))).toBe(
    '[compaction]\nuser: first\nthought\npkg#tool {"x":1}\nanswer\nnested',
  );
});

test("truncates snippets and total summary by Unicode code point deterministically", () => {
  expect(summarize(history([draft("😀".repeat(201))]))).toBe(
    `[compaction]\nuser: ${"😀".repeat(200)}`,
  );
  const nodes = history(Array.from({ length: 12 }, () => draft("😀".repeat(201))));
  const expected =
    "[compaction]\n" +
    Array(12)
      .fill(`user: ${"😀".repeat(200)}`)
      .join("\n");
  const first = summarize(nodes);
  expect(first).toBe(Array.from(expected).slice(0, 2048).join(""));
  expect(Array.from(first)).toHaveLength(2048);
  expect(summarize(nodes)).toBe(first);
  expect(first).not.toMatch(/\p{Surrogate}/u);
});

test("rejects a visible result whose call was removed by source selection", () => {
  const filteredCall = { ...call("a"), source: "missing#old" };
  expect(() => run(history([filteredCall, result("a")]))).toThrowError(
    expect.objectContaining({ code: "storage.corrupt" }),
  );
});

test("protects a visible call whose result was removed by source selection", () => {
  const filteredResult = { ...result("a"), source: "missing#old" };
  expect(() =>
    run(history([call("a"), filteredResult]), [draft("x".repeat(4000), "system", "instruction")]),
  ).toThrowError(expect.objectContaining({ code: "context.window_exceeded" }));
  const withLargeCall = call("a");
  withLargeCall.content.push(...text("x".repeat(4000)));
  expect(() => run(history([withLargeCall, filteredResult]))).toThrowError(
    expect.objectContaining({ code: "context.window_exceeded" }),
  );
});

test("validates projected pairing after a selected whole-group compaction has been applied", () => {
  const nodes = history([
    { ...call("a"), source: "missing#old" },
    result("a"),
    compact("n0", "n1"),
  ]);
  expect(run(nodes, [], { selection: ["missing#old" as EntryName] }).messages).toEqual([
    { role: "system", content: text("stored") },
  ]);
  expect(() => run(nodes)).toThrowError(expect.objectContaining({ code: "storage.corrupt" }));
});

test("retains a generated summary when it fits and replays it byte for byte", () => {
  const branch = history([draft("x".repeat(1200))]);
  const pending = draft("y".repeat(2400));
  const first = run(branch, [pending]);
  const summary = `[compaction]\nuser: ${"x".repeat(200)}`;
  expect(first.messages).toEqual([{ role: "system", content: text(summary) }, message(pending)]);
  expect(payloads(first.compactions)).toEqual([{ from: "n0", to: "n0", summary }]);
  expect(run(history([...branch, ...first.compactions]), [pending]).messages).toEqual(
    first.messages,
  );
});

test("accepts finite integer windows outside the safe integer range", () => {
  expect(run([], [draft("ok")], { contextWindow: 2 ** 54, maxOutput: 0 }).messages).toEqual([
    message(draft("ok")),
  ]);
});

test("keeps summary order and protection inside a projected open tool group", () => {
  const nodes = history([
    call("a"),
    { ...result("a"), source: "missing#old" },
    draft("summarized"),
    compact("n2", "n2", "stored"),
    draft("tail"),
  ]);
  expect(run(nodes).messages).toEqual([
    message(call("a")),
    { role: "system", content: text("stored") },
    message(draft("tail")),
  ]);
  const oversized = history([
    call("a"),
    { ...result("a"), source: "missing#old" },
    draft("summarized"),
    compact("n2", "n2", "x".repeat(4000)),
    draft("tail"),
  ]);
  expect(() => run(oversized)).toThrowError(
    expect.objectContaining({ code: "context.window_exceeded" }),
  );
});

test("counts reasoning and tool arguments in actual budget decisions", () => {
  const reasoning = {
    ...draft(""),
    content: [{ type: "reasoning" as const, text: "x".repeat(3015) }],
  };
  // Reasoning message overhead is 58 bytes; 3015+58 = 3073 => 1025 tokens.
  expect(run([], [reasoning]).messages).toEqual([]);
  const largeCall = call("a");
  largeCall.content = [{ type: "toolCall", id: "a", name, arguments: "x".repeat(4000) }];
  expect(() => run([], [largeCall])).toThrowError(
    expect.objectContaining({ code: "context.window_exceeded" }),
  );
});

test("replayed generated source summaries disappear on deselection and return on reselection", () => {
  const source = "pkg#skill" as EntryName;
  const branch = history([draft(`CANCELLED_SKILL_SECRET${"x".repeat(1200)}`, "system", source)]);
  const pending = draft("y".repeat(2400));
  const first = run(branch, [pending], { selection: [source] });
  expect(first.compactions).toHaveLength(1);
  const summary = `[compaction]\nsystem: CANCELLED_SKILL_SECRET${"x".repeat(178)}`;
  expect(first.messages).toEqual([{ role: "system", content: text(summary) }, message(pending)]);
  // Replay the persisted original nodes and generated control records with their real IDs.
  const persisted = history([...branch, ...first.compactions]);
  expect(run(persisted, [pending], { selection: [source] }).messages).toEqual(first.messages);
  const deselected = run(persisted, [pending]);
  expect(deselected).toEqual({ messages: [message(pending)], compactions: [] });
  expect(run(persisted, [pending], { selection: [source] }).messages).toEqual(first.messages);
});

test("ignores mixed source and ordinary summaries when any source in the range is deselected", () => {
  const selected = "pkg#selected" as EntryName;
  const deselected = "missing#old" as EntryName;
  const nodes = [
    draft("ordinary"),
    draft("keep", "system", selected),
    draft("CANCELLED_SKILL_SECRET", "system", deselected),
  ];
  const branch = history([...nodes, compact("n0", "n2", "SUMMARY_WITH_CANCELLED_SKILL_SECRET")]);
  expect(run(branch, [], { selection: [selected] })).toEqual({
    messages: nodes.slice(0, 2).map(message),
    compactions: [],
  });
  expect(run(branch)).toEqual({
    messages: [message(nodes[0] as SessionNodeDraft)],
    compactions: [],
  });
  expect(run(branch, [], { selection: [selected, deselected] }).messages).toEqual([
    { role: "system", content: text("SUMMARY_WITH_CANCELLED_SKILL_SECRET") },
  ]);
});

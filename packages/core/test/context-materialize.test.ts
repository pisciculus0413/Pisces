import { expect, test } from "vitest";
import type { ContentBlock, EntryName, QueueEntryInput, SessionNodeDraft } from "../src/index.js";
import { createContextHarness, declaration, META } from "./support/context-harness.js";

const name = (value: string) => `pkg#${value}` as EntryName;
const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

test("replays each branch independently without exposing pending declarations in selection", async () => {
  const h = createContextHarness({ persisted: true });
  const [n1] = await h.sessions.create(META, [declaration({ toggle: [name("b"), name("a")] })]);
  const [n2] = await h.sessions.append(META.id, [declaration({ toggle: [name("a")] })], n1?.id);
  await h.sessions.append(META.id, [declaration({ toggle: [name("b")] })], n1?.id);
  h.context.enqueue([declaration({ toggle: [name("pending")] })]);
  await h.context.initialize();
  expect(h.context.snapshot().selection).toEqual(["pkg#a"]);
  expect(await h.context.selectionFor(n2?.id)).toEqual(["pkg#b"]);
  expect(h.context.snapshot().selection).toEqual(["pkg#a"]);
  expect(h.context.snapshot().queue).toHaveLength(1);
});

test("rejects repeated names inside one toggle atomically", () => {
  const { context } = createContextHarness();
  expect(() => context.enqueue([declaration({ toggle: [name("a"), name("a")] })])).toThrowError(
    expect.objectContaining({ code: "queue.duplicate_name" }),
  );
  expect(context.snapshot().queue).toEqual([]);
});

test("maps malformed stored declaration JSON to storage.corrupt", async () => {
  const h = createContextHarness({ persisted: true });
  await h.sessions.create(META, [{ ...declaration({ toggle: [] }), content: text("{") }]);
  await expect(h.context.initialize()).rejects.toMatchObject({ code: "storage.corrupt" });
});

// Removing latest-definition replacement or toggling on definition updates breaks these cases.
const snapshot = (value: string, kind: "tool" | "wrapper" = "tool") => ({
  name: name(kind),
  kind,
  description: value,
  parameters: { value },
  definitionHash: `hash-${value}`,
});

test("freezes the latest definition independently of toggles and retains it when disabled", async () => {
  const { replayDeclarations } = await import("../src/context/declarations.js");
  const old = snapshot("old");
  const current = snapshot("current");
  const records = [
    declaration({ toggle: [name("tool")], definitions: [old] }),
    declaration({ toggle: [], definitions: [current] }),
  ];
  const replay = replayDeclarations(records);
  expect(replay.selection).toEqual(["pkg#tool"]);
  expect(replay.definitions.get(name("tool"))).toEqual({
    name: "pkg#tool",
    kind: "tool",
    description: "current",
    parameters: { value: "current" },
    definitionHash: "hash-current",
  });
  const disabled = replayDeclarations([...records, declaration({ toggle: [name("tool")] })]);
  expect(disabled.selection).toEqual([]);
  expect(disabled.definitions.get(name("tool"))?.definitionHash).toBe("hash-current");
  expect(records[0]?.content).toEqual(
    text(JSON.stringify({ toggle: [name("tool")], definitions: [old] })),
  );
  current.description = "mutated";
  expect(replay.definitions.get(name("tool"))?.description).toBe("current");
});

const malformedDefinitions = [
  { ...snapshot("bad"), name: "invalid" },
  { ...snapshot("bad"), kind: "context" },
  { ...snapshot("bad"), description: 1 },
  { ...snapshot("bad"), parameters: null },
  { ...snapshot("bad"), parameters: [] },
  { ...snapshot("bad"), definitionHash: "" },
  { ...snapshot("bad", "wrapper"), configHash: 42 },
];
test.each(malformedDefinitions)(
  "rejects invalid snapshot %j at queue and storage boundaries",
  async (definition) => {
    const { context } = createContextHarness();
    const draft = {
      ...declaration({ toggle: [] }),
      content: text(JSON.stringify({ toggle: [], definitions: [definition] })),
    };
    expect(() => context.enqueue([draft])).toThrowError(
      expect.objectContaining({ code: "queue.invalid_control" }),
    );
    const h = createContextHarness({ persisted: true });
    await h.sessions.create(META, [draft]);
    await expect(h.context.initialize()).rejects.toMatchObject({ code: "storage.corrupt" });
  },
);

async function setupMaterialize() {
  const { materialize } = await import("../src/context/materialize.js");
  const h = createContextHarness();
  return {
    materialize,
    input: {
      branch: [] as SessionNodeDraft[],
      queue: h.context.snapshot().queue,
      selection: [] as EntryName[],
      definitions: new Map([
        [name("tool"), snapshot("frozen")],
        [name("wrapper"), snapshot("frozen-wrapper", "wrapper")],
      ]),
      entries: h.deps.entries,
      sources: h.deps.sources,
      skills: h.deps.skills,
      sourceContext: { sessionId: META.id, workspace: META.workspace },
    },
  };
}

test("builds tools only from frozen definitions and validates wrappers without exposing them", async () => {
  const { materialize, input } = await setupMaterialize();
  input.selection = [name("wrapper"), name("tool")];
  input.entries = { kind: (entry) => (entry === name("tool") ? "tool" : "wrapper") };
  Object.assign(input.entries, {
    definition: () => {
      throw new Error("live body read");
    },
  });
  expect(await materialize(input)).toEqual({
    drafts: [],
    tools: [{ name: "pkg#tool", description: "frozen", parameters: { value: "frozen" } }],
  });
});

test.each([
  "missing kind",
  "missing tool",
  "bad tool",
  "missing wrapper",
  "bad wrapper",
  "mismatched name",
  "mismatched kind",
  "non-json parameters",
])("rejects %s as corrupt rather than using live definitions", async (scenario) => {
  const { materialize, input } = await setupMaterialize();
  input.selection = [name("tool"), name("wrapper")];
  input.entries = {
    kind: (entry) =>
      scenario === "missing kind" ? undefined : entry === name("tool") ? "tool" : "wrapper",
  };
  if (scenario === "missing tool") input.definitions.delete(name("tool"));
  if (scenario === "missing wrapper") input.definitions.delete(name("wrapper"));
  if (scenario === "bad tool")
    Object.assign(input.definitions.get(name("tool")) ?? {}, { parameters: [] });
  if (scenario === "bad wrapper")
    Object.assign(input.definitions.get(name("wrapper")) ?? {}, { definitionHash: null });
  if (scenario === "mismatched name")
    Object.assign(input.definitions.get(name("tool")) ?? {}, { name: name("other") });
  if (scenario === "mismatched kind")
    Object.assign(input.definitions.get(name("tool")) ?? {}, { kind: "wrapper" });
  if (scenario === "non-json parameters")
    Object.assign(input.definitions.get(name("tool")) ?? {}, { parameters: { bad: undefined } });
  await expect(materialize(input)).rejects.toMatchObject({ code: "storage.corrupt" });
});

const system = (source: string, value: string): QueueEntryInput => ({
  kind: "agent",
  role: "system",
  source,
  content: text(value),
});

test("materializes sources then skills in name order then queue order and reuses all stored fragments", async () => {
  const { materialize, input } = await setupMaterialize();
  input.selection = [name("b"), name("z-skill"), name("a"), name("c-skill")];
  input.entries = { kind: (entry) => (entry.endsWith("skill") ? "skill" : "context") };
  const resolved: string[] = [];
  input.sources = {
    get: (entry) => ({
      id: entry,
      resolve: async (context) => {
        expect(context).toEqual({ sessionId: "s1", workspace: "/workspace" });
        resolved.push(entry);
        return [
          { source: "untrusted description", content: text(`${entry}-1`) },
          { source: "other", content: text(`${entry}-2`) },
        ];
      },
    }),
  };
  input.skills = {
    selected: () => [
      { name: name("z-skill"), source: "wrong", content: text("z") },
      { name: name("extra"), source: "wrong", content: text("must not enter") },
      { name: name("c-skill"), source: "wrong", content: text("c") },
    ],
  };
  input.branch = [
    system("create", "create"),
    system("instruction", "i1"),
    system("instruction", "i2"),
  ];
  const h = createContextHarness();
  h.context.enqueue([system("instruction", "i3"), declaration({ toggle: [] })]);
  input.queue = h.context.snapshot().queue;
  const result = await materialize(input);
  expect(resolved).toEqual(["pkg#a", "pkg#b"]);
  expect(result.drafts.map((node) => node.source)).toEqual([
    "pkg#a",
    "pkg#a",
    "pkg#b",
    "pkg#b",
    "pkg#c-skill",
    "pkg#z-skill",
    "instruction",
    "user",
  ]);
  expect(
    [...input.branch, ...result.drafts]
      .filter((node) => node.source === "instruction")
      .map((node) => node.content),
  ).toEqual([text("i1"), text("i2"), text("i3")]);
  expect(input.branch[0]).toEqual(system("create", "create"));
  input.branch.push(...result.drafts);
  input.queue = [];
  input.selection = [];
  expect(await materialize(input)).toEqual({ drafts: [], tools: [] });
  input.selection = [name("b"), name("z-skill"), name("a"), name("c-skill")];
  expect(await materialize(input)).toEqual({ drafts: [], tools: [] });
  expect(resolved).toEqual(["pkg#a", "pkg#b"]);
});

test("zero-fragment sources retry on the next materialization", async () => {
  const { materialize, input } = await setupMaterialize();
  input.selection = [name("empty")];
  input.entries = { kind: () => "context" };
  let attempts = 0;
  input.sources = {
    get: (entry) => ({
      id: entry,
      resolve: async () =>
        ++attempts === 1 ? [] : [{ source: "description", content: text("ready") }],
    }),
  };
  expect((await materialize(input)).drafts).toEqual([]);
  expect((await materialize(input)).drafts).toEqual([system("pkg#empty", "ready")]);
});

test.each(["context", "skill"] as const)("missing selected %s fails explicitly", async (kind) => {
  const { materialize, input } = await setupMaterialize();
  input.selection = [name("missing")];
  input.entries = { kind: () => kind };
  await expect(materialize(input)).rejects.toMatchObject({ code: "context.source_failed" });
});

test("source rejection keeps its cause and ignored cancellation keeps the exact signal reason", async () => {
  const { materialize, input } = await setupMaterialize();
  input.selection = [name("source")];
  input.entries = { kind: () => "context" };
  const cause = new Error("source unavailable");
  input.sources = {
    get: (entry) => ({
      id: entry,
      resolve: async () => {
        throw cause;
      },
    }),
  };
  await expect(materialize(input)).rejects.toMatchObject({ code: "context.source_failed", cause });
  const controller = new AbortController();
  const reason = { cancelled: "exact object" };
  input.sources = {
    get: (entry) => ({
      id: entry,
      resolve: async () => {
        controller.abort(reason);
        return [];
      },
    }),
  };
  await expect(
    materialize({ ...input, sourceContext: { ...input.sourceContext, signal: controller.signal } }),
  ).rejects.toBe(reason);
});

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
test.each(["text", "reasoning", "nested"])(
  "truncates %s by code points to the exact byte boundary without changing input",
  async (kind) => {
    const { materialize, input } = await setupMaterialize();
    input.selection = [name("source")];
    input.entries = { kind: () => "context" };
    const long = "😀".repeat(70000);
    const block: ContentBlock =
      kind === "nested"
        ? { type: "toolResult", toolCallId: "c1", content: [{ type: "reasoning", text: long }] }
        : { type: kind as "text" | "reasoning", text: long };
    const content = [block];
    input.sources = {
      get: (entry) => ({ id: entry, resolve: async () => [{ source: "ignored", content }] }),
    };
    const result = (await materialize(input)).drafts[0]?.content ?? [];
    expect(byteLength(result)).toBeLessThanOrEqual(262144);
    const shortened = result[0]?.type === "toolResult" ? result[0].content[0] : result[0];
    expect(shortened && "text" in shortened && shortened.text.endsWith("\n[truncated]")).toBe(true);
    if (shortened && "text" in shortened) {
      expect(shortened.text).not.toMatch(/\p{Surrogate}/u);
      const grown = structuredClone(result);
      const grownText = grown[0]?.type === "toolResult" ? grown[0].content[0] : grown[0];
      if (grownText && "text" in grownText) grownText.text = `😀${grownText.text}`;
      expect(byteLength(grown)).toBeGreaterThan(262144);
    }
    expect(block.type === "toolResult" ? block.content[0] : block).toMatchObject({ text: long });
  },
);

test("never truncates arguments or queue definitions and rejects irreducibly oversized source content", async () => {
  const { materialize, input } = await setupMaterialize();
  const definition = snapshot("x".repeat(263000));
  // Direct internal queue envelope: this test isolates materialization from queue admission limits.
  input.queue = [
    {
      ...declaration({ toggle: [], definitions: [definition] }),
      id: "q1" as import("../src/index.js").QueueEntryId,
      createdAt: "now",
    },
  ];
  expect((await materialize(input)).drafts[0]?.content).toEqual(input.queue[0]?.content);
  input.selection = [name("source")];
  input.entries = { kind: () => "context" };
  const content: ContentBlock[] = [
    { type: "toolCall", id: "c1", name: name("tool"), arguments: "x".repeat(263000) },
    ...text("trim me".repeat(100)),
  ];
  input.sources = {
    get: (entry) => ({ id: entry, resolve: async () => [{ source: "ignored", content }] }),
  };
  await expect(materialize(input)).rejects.toMatchObject({ code: "context.source_failed" });
  expect(content[0]).toMatchObject({ arguments: "x".repeat(263000) });
});

test("rejects non-finite JSON numbers in frozen parameters at both declaration boundaries", async () => {
  const content = text(
    '{"toggle":[],"definitions":[{"name":"pkg#tool","kind":"tool","description":"bad","parameters":{"nested":[1e999]},"definitionHash":"hash"}]}',
  );
  const h = createContextHarness({ persisted: true });
  const draft = { ...declaration({ toggle: [] }), content };
  expect(() => h.context.enqueue([draft])).toThrowError(
    expect.objectContaining({ code: "queue.invalid_control" }),
  );
  await h.sessions.create(META, [draft]);
  await expect(h.context.initialize()).rejects.toMatchObject({ code: "storage.corrupt" });
});

test("rejects stored declaration text arrays instead of coercing them into valid JSON", async () => {
  const h = createContextHarness({ persisted: true });
  await h.sessions.create(META, [
    {
      ...declaration({ toggle: [] }),
      content: [{ type: "text", text: ['{"toggle":["pkg#a"]}'] }] as unknown as ContentBlock[],
    },
  ]);
  await expect(h.context.initialize()).rejects.toMatchObject({ code: "storage.corrupt" });
});

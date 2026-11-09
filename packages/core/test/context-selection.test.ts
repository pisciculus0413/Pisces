import { expect, test } from "vitest";
import { replayDeclarations } from "../src/context/declarations.js";
import {
  applyDeclarations,
  type ContentBlock,
  type ContextEntries,
  type ContextEntryKind,
  type DefinitionSnapshot,
  type EntryName,
  evaluateSelection,
  replaySelection,
  type SessionNodeDraft,
} from "../src/index.js";
import { declaration } from "./support/context-harness.js";

const name = (value: string) => `pkg#${value}` as EntryName;
const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

const snapshot = (
  entry: string,
  value: string,
  kind: "tool" | "wrapper" = "tool",
): DefinitionSnapshot => ({
  name: name(entry),
  kind,
  description: value,
  parameters: { value },
  definitionHash: `hash-${value}`,
  ...(kind === "wrapper" ? { configHash: `config-${value}` } : {}),
});

const system = (source: EntryName, value: string): SessionNodeDraft => ({
  kind: "agent",
  role: "system",
  source,
  content: text(value),
});

function entries(
  kinds: Record<string, ContextEntryKind>,
  matchesDefinition?: (definition: DefinitionSnapshot) => boolean,
): ContextEntries {
  return {
    kind: (entry) => kinds[entry],
    ...(matchesDefinition ? { matchesDefinition } : {}),
  };
}

test("replays XOR, latest definitions and isolated arrays without exposing internal maps", () => {
  const records: SessionNodeDraft[] = [
    declaration({ toggle: [name("b"), name("a")], definitions: [snapshot("a", "old")] }),
    declaration({ toggle: [name("a")], definitions: [snapshot("a", "current")] }),
  ];
  const view = replaySelection(records);
  expect(view.selection).toEqual([name("b")]);
  expect(view.definitions instanceof Map).toBe(false);
  expect(Array.isArray(view.definitions)).toBe(true);
  expect(view.definitions).toEqual([snapshot("a", "current")]);
  expect(view.contentNames).toEqual([]);
  const replay = replayDeclarations(records);
  expect(replay.selection).toEqual(view.selection);
  expect([...replay.definitions.entries()]).toEqual(
    view.definitions.map((definition) => [definition.name, definition]),
  );
  const frozenRecords = structuredClone(records);
  (view.definitions[0] as DefinitionSnapshot).description = "mutated";
  expect(replaySelection(records).definitions).toEqual([snapshot("a", "current")]);
  expect(records).toEqual(frozenRecords);
  expect(view.selection).toEqual([name("b")]);
});

test("keeps the latest definition after a close and reopens from branch history alone", () => {
  const on = declaration({ toggle: [name("tool")], definitions: [snapshot("tool", "frozen")] });
  const off = declaration({ toggle: [name("tool")] });
  const closed = replaySelection([on, off]);
  expect(closed.selection).toEqual([]);
  expect(closed.definitions).toEqual([snapshot("tool", "frozen")]);
  // Removing the earlier toggle leaves only the off toggle: the name XORs back on.
  const reopened = replaySelection([off]);
  expect(reopened.selection).toEqual([name("tool")]);
  expect(reopened.definitions).toEqual([]);
});

test("replays sibling branches independently for the same tool", () => {
  const on = declaration({ toggle: [name("tool")], definitions: [snapshot("tool", "frozen")] });
  const off = declaration({ toggle: [name("tool")] });
  const left = replaySelection([on, off]);
  const right = replaySelection([on]);
  expect(left.selection).toEqual([]);
  expect(right.selection).toEqual([name("tool")]);
  expect(right.definitions).toEqual([snapshot("tool", "frozen")]);
});

test("rejects malformed stored declarations and definitions instead of treating them as unavailable", () => {
  expect(() =>
    replaySelection([{ ...declaration({ toggle: [] }), content: text("{") }]),
  ).toThrowError(expect.objectContaining({ code: "storage.corrupt" }));
  const draft = {
    ...declaration({ toggle: [] }),
    content: text(
      JSON.stringify({
        toggle: [],
        definitions: [{ ...snapshot("tool", "bad"), definitionHash: null }],
      }),
    ),
  };
  expect(() => replaySelection([draft])).toThrowError(
    expect.objectContaining({ code: "storage.corrupt" }),
  );
  expect(() => evaluateSelection(replaySelection([]), entries({}))).not.toThrow();
});

test("records branch agent/system sources as content names only", () => {
  const view = replaySelection([
    system(name("doc"), "body"),
    declaration({ toggle: [] }),
    { kind: "agent", role: "user", source: "user", content: text("hi") },
    { kind: "agent", role: "system", source: "instruction", content: text("i") },
  ]);
  expect(view.contentNames).toEqual([name("doc")]);
});

test("applies pending declarations without mutating the view or the pending list", () => {
  const view = replaySelection([
    declaration({ toggle: [name("a")], definitions: [snapshot("a", "old")] }),
    system(name("doc"), "body"),
  ]);
  const pending: SessionNodeDraft[] = [
    declaration({ toggle: [name("a"), name("c")], definitions: [snapshot("c", "new")] }),
  ];
  const frozenView = structuredClone(view);
  const frozenPending = structuredClone(pending);
  const next = applyDeclarations(view, pending);
  expect(view).toEqual(frozenView);
  expect(pending).toEqual(frozenPending);
  expect(next.selection).toEqual([name("c")]);
  expect(next.definitions).toEqual([snapshot("a", "old"), snapshot("c", "new")]);
  expect(next.contentNames).toEqual([name("doc")]);

  const updated = applyDeclarations(view, [
    declaration({ toggle: [], definitions: [snapshot("a", "current")] }),
  ]);
  expect(updated.selection).toEqual(view.selection);
  expect(updated.definitions).toEqual([snapshot("a", "current")]);
  expect(view).toEqual(frozenView);
});

test("allows closing a known name under a conflicting kind and keeps old evidence", () => {
  const view = replaySelection([
    declaration({ toggle: [name("tool")], definitions: [snapshot("tool", "old")] }),
    system(name("doc"), "body"),
  ]);
  const closed = applyDeclarations(view, [
    declaration({
      toggle: [name("tool")],
      definitions: [snapshot("tool", "new", "wrapper")],
    }),
  ]);
  expect(closed.selection).toEqual([]);
  expect(closed.definitions).toEqual([snapshot("tool", "old")]);
  expect(closed.contentNames).toEqual([name("doc")]);
  expect(view.definitions).toEqual([snapshot("tool", "old")]);

  const selected = replaySelection([
    declaration({ toggle: [name("doc")] }),
    system(name("doc"), "body"),
  ]);
  const closedContent = applyDeclarations(selected, [
    declaration({ toggle: [name("doc")], definitions: [snapshot("doc", "new")] }),
  ]);
  expect(closedContent.selection).toEqual([]);
  expect(closedContent.definitions).toEqual([]);
  expect(closedContent.contentNames).toEqual([name("doc")]);
});

test("rejects reopening a known name under a conflicting kind", () => {
  const closedTool = replaySelection([
    declaration({ toggle: [name("tool")], definitions: [snapshot("tool", "old")] }),
    declaration({ toggle: [name("tool")] }),
  ]);
  expect(closedTool.selection).toEqual([]);
  expect(() =>
    applyDeclarations(closedTool, [
      declaration({
        toggle: [name("tool")],
        definitions: [snapshot("tool", "new", "wrapper")],
      }),
    ]),
  ).toThrowError(expect.objectContaining({ code: "queue.invalid_control" }));

  const closedContent = replaySelection([system(name("doc"), "body")]);
  expect(() =>
    applyDeclarations(closedContent, [
      declaration({ toggle: [name("doc")], definitions: [snapshot("doc", "new")] }),
    ]),
  ).toThrowError(expect.objectContaining({ code: "queue.invalid_control" }));

  const view = replaySelection([
    declaration({ toggle: [name("tool")], definitions: [snapshot("tool", "old")] }),
  ]);
  expect(() =>
    applyDeclarations(view, [{ ...declaration({ toggle: [] }), content: text("{") }]),
  ).toThrowError(expect.objectContaining({ code: "queue.invalid_control" }));
  expect(view.definitions).toEqual([snapshot("tool", "old")]);
});

test("rejects a pending declaration that retypes a name introduced by an earlier pending one", () => {
  const view = replaySelection([]);
  const pending: SessionNodeDraft[] = [
    declaration({ toggle: [], definitions: [snapshot("new", "first", "wrapper")] }),
    declaration({ toggle: [name("new")], definitions: [snapshot("new", "second")] }),
  ];
  expect(() => applyDeclarations(view, pending)).toThrowError(
    expect.objectContaining({ code: "queue.invalid_control" }),
  );
  const closed = applyDeclarations(view, [
    declaration({ toggle: [], definitions: [snapshot("new", "first", "wrapper")] }),
    declaration({ toggle: [], definitions: [snapshot("new", "second")] }),
  ]);
  expect(closed.selection).toEqual([]);
  expect(closed.definitions).toEqual([snapshot("new", "first", "wrapper")]);
});

test("accepts fresh pending names with definitions", () => {
  const view = replaySelection([
    declaration({ toggle: [name("tool")], definitions: [snapshot("tool", "old")] }),
  ]);
  const fresh = applyDeclarations(view, [
    declaration({
      toggle: [name("new")],
      definitions: [snapshot("new", "fresh", "wrapper")],
    }),
  ]);
  expect(fresh.definitions).toEqual([snapshot("new", "fresh", "wrapper"), snapshot("tool", "old")]);
});

const toolView = (entry: string, value: string) =>
  replaySelection([declaration({ toggle: [name(entry)], definitions: [snapshot(entry, value)] })]);

test("keeps a matching historical tool executable and reports no stale entries", () => {
  const view = toolView("tool", "frozen");
  const evaluation = evaluateSelection(
    view,
    entries(
      { [name("tool")]: "tool" },
      (definition) => definition.definitionHash === "hash-frozen",
    ),
  );
  expect(evaluation.effective).toEqual([
    { name: name("tool"), definitionHash: "hash-frozen", stale: false },
  ]);
  expect(evaluation.executionSelection).toEqual([name("tool")]);
  expect(evaluation.contentSelection).toEqual([]);
  expect(evaluation.unresolvedSources).toEqual([]);
});

test("marks a changed historical tool stale without changing selection or projecting it", () => {
  const view = toolView("tool", "frozen");
  const evaluation = evaluateSelection(
    view,
    entries({ [name("tool")]: "tool" }, () => false),
  );
  expect(evaluation.executionSelection).toEqual([]);
  expect(evaluation.effective[0]?.stale).toBe(true);
  expect(evaluation.effective).toEqual([
    { name: name("tool"), definitionHash: "hash-frozen", stale: true },
  ]);
  expect(evaluation.contentSelection).toEqual([]);
  expect(view.selection).toEqual([name("tool")]);
});

test("marks a vanished historical tool stale instead of corrupt or executable", () => {
  const evaluation = evaluateSelection(
    toolView("tool", "frozen"),
    entries({}, () => false),
  );
  expect(evaluation.executionSelection).toEqual([]);
  expect(evaluation.effective).toEqual([
    { name: name("tool"), definitionHash: "hash-frozen", stale: true },
  ]);
  expect(evaluation.contentSelection).toEqual([]);
  expect(evaluation.unresolvedSources).toEqual([]);
});

test("never reuses historical tool definitions as current skills", () => {
  const evaluation = evaluateSelection(
    toolView("tool", "frozen"),
    entries({ [name("tool")]: "skill" }, () => false),
  );
  expect(evaluation.executionSelection).toEqual([]);
  expect(evaluation.contentSelection).toEqual([]);
  expect(evaluation.effective).toEqual([
    { name: name("tool"), definitionHash: "hash-frozen", stale: true },
  ]);
});

test("matches wrapper config hashes and passes the frozen definition to the inventory", () => {
  const view = replaySelection([
    declaration({ toggle: [name("wrap")], definitions: [snapshot("wrap", "old", "wrapper")] }),
  ]);
  const seen: DefinitionSnapshot[] = [];
  const stale = evaluateSelection(
    view,
    entries({ [name("wrap")]: "wrapper" }, (definition) => {
      seen.push(definition);
      return definition.configHash !== "config-old";
    }),
  );
  expect(seen).toEqual([snapshot("wrap", "old", "wrapper")]);
  expect(stale.executionSelection).toEqual([]);
  expect(stale.effective).toEqual([
    {
      name: name("wrap"),
      definitionHash: "hash-old",
      configHash: "config-old",
      stale: true,
    },
  ]);
  expect(
    evaluateSelection(
      view,
      entries({ [name("wrap")]: "wrapper" }, () => true),
    ).executionSelection,
  ).toEqual([name("wrap")]);
});

test("reuses historical content even when the extension is gone or repurposed", () => {
  const view = replaySelection([
    declaration({ toggle: [name("doc")] }),
    system(name("doc"), "frozen body"),
  ]);
  const matches = () => {
    throw new Error("matchesDefinition must not run for content entries");
  };
  const missing = evaluateSelection(view, entries({}, matches));
  expect(missing.contentSelection).toEqual([name("doc")]);
  expect(missing.executionSelection).toEqual([]);
  expect(missing.unresolvedSources).toEqual([]);
  expect(missing.effective).toEqual([{ name: name("doc"), stale: false }]);
  const repurposed = evaluateSelection(view, entries({ [name("doc")]: "tool" }, matches));
  expect(repurposed.contentSelection).toEqual([name("doc")]);
  expect(repurposed.executionSelection).toEqual([]);
  expect(repurposed.effective).toEqual([{ name: name("doc"), stale: false }]);
});

test.each(["context", "skill"] as const)(
  "materializes a current %s source without history, including zero-fragment retries",
  (kind) => {
    const view = replaySelection([declaration({ toggle: [name("empty")] })]);
    const matches = () => {
      throw new Error("matchesDefinition must not run for content entries");
    };
    expect(evaluateSelection(view, entries({ [name("empty")]: kind }, matches))).toEqual({
      effective: [{ name: name("empty"), stale: false }],
      executionSelection: [],
      contentSelection: [name("empty")],
      unresolvedSources: [],
    });
  },
);

test("reports a fully unknown selection as unresolved rather than a tool or a silent ignore", () => {
  const view = replaySelection([declaration({ toggle: [name("gone")] })]);
  const evaluation = evaluateSelection(
    view,
    entries({}, () => false),
  );
  expect(evaluation.unresolvedSources).toEqual([name("gone")]);
  expect(evaluation.executionSelection).toEqual([]);
  expect(evaluation.contentSelection).toEqual([]);
  expect(evaluation.effective).toEqual([{ name: name("gone"), stale: true }]);
});

test.each(["tool", "wrapper"] as const)(
  "keeps a current %s with a missing necessary definition corrupt in strict mode",
  (kind) => {
    const view = replaySelection([declaration({ toggle: [name(kind)] })]);
    expect(() =>
      evaluateSelection(
        view,
        entries({ [name(kind)]: kind }, () => true),
      ),
    ).toThrowError(expect.objectContaining({ code: "storage.corrupt" }));
  },
);

test("keeps a current tool with a missing necessary definition corrupt", () => {
  const view = replaySelection([declaration({ toggle: [name("tool")] })]);
  expect(() => evaluateSelection(view, entries({ [name("tool")]: "tool" }))).toThrowError(
    expect.objectContaining({ code: "storage.corrupt" }),
  );
});

test("keeps legacy manual injection semantics without a matchesDefinition hook", () => {
  const view = toolView("tool", "manual");
  const evaluation = evaluateSelection(view, entries({ [name("tool")]: "tool" }));
  expect(evaluation.executionSelection).toEqual([name("tool")]);
  expect(evaluation.contentSelection).toEqual([]);
  expect(evaluation.unresolvedSources).toEqual([]);
  expect(evaluation.effective).toEqual([
    { name: name("tool"), definitionHash: "hash-manual", stale: false },
  ]);
  expect(() => evaluateSelection(toolView("tool", "manual"), entries({}))).toThrowError(
    expect.objectContaining({ code: "storage.corrupt" }),
  );
  expect(() =>
    evaluateSelection(toolView("tool", "manual"), entries({ [name("tool")]: "wrapper" })),
  ).toThrowError(expect.objectContaining({ code: "storage.corrupt" }));
  expect(() =>
    evaluateSelection(
      replaySelection([declaration({ toggle: [name("tool")] })]),
      entries({ [name("tool")]: "tool" }),
    ),
  ).toThrowError(expect.objectContaining({ code: "storage.corrupt" }));
});

test("sorts effective entries and execution/content selections by name", () => {
  const view = replaySelection([
    declaration({
      toggle: [name("z"), name("b"), name("a")],
      definitions: [snapshot("z", "z"), snapshot("b", "b")],
    }),
  ]);
  const evaluation = evaluateSelection(
    view,
    entries({ [name("z")]: "tool", [name("b")]: "tool", [name("a")]: "context" }, () => false),
  );
  expect(evaluation.effective.map((entry) => entry.name)).toEqual([
    name("a"),
    name("b"),
    name("z"),
  ]);
  expect(evaluation.contentSelection).toEqual([name("a")]);
  expect(evaluation.executionSelection).toEqual([]);
});

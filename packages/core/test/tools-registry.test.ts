import { expect, test } from "vitest";
import type {
  EntryInfo,
  EntryName,
  SelectionState,
  SessionId,
  ToolDeclaration,
  ToolInvocationContext,
} from "../src/index.js";
import { createTools } from "../src/index.js";

const name = (value: string) => value as EntryName;
const entry = (value: string, type: EntryInfo["type"]): EntryInfo => ({
  type,
  source: "test",
  name: name(value),
});
const tool = (value: string): ToolDeclaration => ({
  id: `id:${value}`,
  source: "test",
  name: name(value),
  description: value,
  parameters: { value },
  execute: async () => ({ content: [{ type: "text", text: value }] }),
});

test("filters selected tools by bound inventory type and returns sorted declarations", () => {
  const catalog = createTools();
  catalog.registerTool(tool("z#echo"));
  catalog.registerTool(tool("a#echo"));
  catalog.registerTool(tool("m#hidden"));
  let wrapperLoads = 0;
  catalog.registerWrapper(name("pkg#audit"), () => {
    wrapperLoads++;
    return (wrapped) => wrapped;
  });
  const inventory = {
    hash: "h1",
    entries: [
      entry("z#echo", "tool"),
      entry("a#echo", "tool"),
      entry("m#hidden", "skill"),
      entry("pkg#audit", "wrapper"),
    ],
  };
  const facade = catalog.forInventory(inventory);
  inventory.entries.push(entry("m#hidden", "tool"));
  const selection = ["z#echo", "pkg#audit", "a#echo", "z#echo"] as SelectionState;

  expect(
    facade.selected(selection).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  ).toEqual([
    { name: "a#echo", description: "a#echo", parameters: { value: "a#echo" } },
    { name: "z#echo", description: "z#echo", parameters: { value: "z#echo" } },
  ]);
  expect(wrapperLoads).toBe(0);
  expect(catalog.forInventory({ hash: "h2", entries: [] }).selected(selection)).toEqual([]);
});

test("does not treat an unbound registered tool as a wrapper", async () => {
  const catalog = createTools();
  catalog.registerTool(tool("pkg#echo"));

  expect(
    await catalog.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      ["pkg#echo"] as SelectionState,
      {
        sessionId: "s1" as SessionId,
        workspace: "/workspace",
        signal: new AbortController().signal,
      },
    ),
  ).toEqual({ content: [{ type: "text", text: "pkg#echo" }] });
});

test("marks both colliding tools unavailable and reports the collision", async () => {
  const catalog = createTools({ encodeWireName: () => "t_same" });
  catalog.registerTool(tool("a#first"));
  expect(() => catalog.registerTool(tool("b#second"))).toThrowError(
    expect.objectContaining({
      code: "tools.wire_name_conflict",
      data: { wireName: "t_same", names: ["a#first", "b#second"] },
    }),
  );
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("a#first", "tool"), entry("b#second", "tool")],
  });
  const selection = ["a#first", "b#second"] as SelectionState;
  const context: ToolInvocationContext = {
    sessionId: "s1" as SessionId,
    workspace: "/workspace",
    signal: new AbortController().signal,
  };

  expect(facade.selected(selection)).toEqual([]);
  await expect(
    facade.invoke({ id: "call-1", name: name("a#first"), arguments: null }, selection, context),
  ).resolves.toMatchObject({ code: "tool.failed" });
});

test("detects wrapper and cross-kind wire-name collisions", () => {
  const wrapperCatalog = createTools({ encodeWireName: () => "t_wrapper" });
  wrapperCatalog.registerWrapper(name("a#one"), () => (wrapped) => wrapped);
  expect(() =>
    wrapperCatalog.registerWrapper(name("b#two"), () => (wrapped) => wrapped),
  ).toThrowError(
    expect.objectContaining({
      code: "tools.wire_name_conflict",
      data: { wireName: "t_wrapper", names: ["a#one", "b#two"] },
    }),
  );

  const mixedCatalog = createTools({ encodeWireName: () => "t_mixed" });
  mixedCatalog.registerTool(tool("a#tool"));
  expect(() =>
    mixedCatalog.registerWrapper(name("b#wrapper"), () => (wrapped) => wrapped),
  ).toThrowError(
    expect.objectContaining({
      code: "tools.wire_name_conflict",
      data: { wireName: "t_mixed", names: ["a#tool", "b#wrapper"] },
    }),
  );
});

test("allows the same EntryName to be registered again with the same wire name", () => {
  const toolCatalog = createTools({ encodeWireName: () => "t_same" });
  toolCatalog.registerTool(tool("a#first"));
  expect(() => toolCatalog.registerTool(tool("a#first"))).not.toThrow();

  const wrapperCatalog = createTools({ encodeWireName: () => "t_same" });
  wrapperCatalog.registerWrapper(name("a#wrap"), () => (wrapped) => wrapped);
  expect(() =>
    wrapperCatalog.registerWrapper(name("a#wrap"), () => (wrapped) => wrapped),
  ).not.toThrow();
});

test("isolates registrations, selections, results, and catalogs from caller mutation", () => {
  const catalog = createTools();
  const original = tool("pkg#echo");
  catalog.registerTool(original);
  (original as { description: string }).description = "mutated";
  (original.parameters as { value: string }).value = "mutated";

  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#other", "tool")],
  });
  const selection = ["pkg#echo"] as SelectionState;
  const first = facade.selected(selection);
  expect(first.map(({ description, parameters }) => ({ description, parameters }))).toEqual([
    { description: "pkg#echo", parameters: { value: "pkg#echo" } },
  ]);

  (first[0]?.parameters as { value: string }).value = "result-mutated";
  selection[0] = name("pkg#other");
  catalog.registerTool(tool("pkg#other"));
  expect(facade.selected(selection).map(({ name }) => name)).toEqual(["pkg#other"]);
  expect(facade.selected(["pkg#echo"] as SelectionState)[0]?.parameters).toEqual({
    value: "pkg#echo",
  });

  const otherCatalog = createTools();
  otherCatalog.registerTool(tool("other#secret"));
  expect(facade.selected(["other#secret"] as SelectionState)).toEqual([]);
});

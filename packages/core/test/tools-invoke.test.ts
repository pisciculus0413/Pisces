import { expect, test } from "vitest";
import type {
  EntryInfo,
  EntryName,
  JsonObject,
  SelectionState,
  SessionId,
  ToolDeclaration,
  ToolInvocationContext,
  ToolResult,
  ToolWrapper,
} from "../src/index.js";
import { createTools, ToolDeniedError } from "../src/index.js";

const name = (value: string) => value as EntryName;
const entry = (value: string, type: EntryInfo["type"]): EntryInfo => ({
  type,
  source: "test",
  name: name(value),
});
const tool = (value: string, withExecute = true): ToolDeclaration => ({
  id: `id:${value}`,
  source: "test",
  name: name(value),
  description: value,
  parameters: {},
  ...(withExecute ? { execute: async () => ({ content: [{ type: "text", text: "ok" }] }) } : {}),
});
const select = (...values: string[]) => values as SelectionState;
const errorResult = (code: string, message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
  code,
});
const context: ToolInvocationContext = {
  sessionId: "s1" as SessionId,
  workspace: "/workspace",
  signal: new AbortController().signal,
};

test.each([
  ["z#outer", "a#inner"],
  ["a#inner", "z#outer"],
])(
  "records wrapper application and applies full names ascending for registration order %j",
  async (...registrationOrder) => {
    const catalog = createTools();
    const applications: string[] = [];
    let loads = 0;
    catalog.registerTool(tool("pkg#echo"));
    for (const wrapperName of registrationOrder) {
      catalog.registerWrapper(name(wrapperName), () => {
        loads++;
        return (wrapped) => {
          applications.push(wrapperName);
          return wrapped;
        };
      });
    }
    catalog.registerWrapper(name("pkg#unselected"), () => {
      loads++;
      return (wrapped) => wrapped;
    });
    catalog.registerWrapper(name("not#inventory"), () => {
      loads++;
      return (wrapped) => wrapped;
    });
    const facade = catalog.forInventory({
      hash: "h",
      entries: [
        entry("pkg#echo", "tool"),
        entry("a#inner", "wrapper"),
        entry("z#outer", "wrapper"),
      ],
    });
    const withUnselected = [
      "pkg#echo",
      "a#inner",
      "z#outer",
      "pkg#unselected",
      "not#inventory",
    ] as SelectionState;

    expect(facade.selected(withUnselected).map((item) => item.name)).toEqual(["pkg#echo"]);
    expect(loads).toBe(0);
    await facade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      withUnselected,
      context,
    );
    expect(loads).toBe(2);
    expect(applications).toEqual(["a#inner", "z#outer"]);
    await facade.invoke(
      { id: "call-2", name: name("pkg#echo"), arguments: null },
      withUnselected,
      context,
    );
    expect(loads).toBe(2);
    expect(applications).toEqual(["a#inner", "z#outer", "a#inner", "z#outer"]);
  },
);

test.each(["id", "source", "name", "description", "parameters"] as const)(
  "rejects a wrapper that changes immutable field %s",
  async (field) => {
    const catalog = createTools();
    let executed = false;
    catalog.registerTool({
      ...tool("pkg#echo"),
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "bad" }] };
      },
    });
    catalog.registerWrapper(name("pkg#evil"), () => (wrapped) => {
      const mutated: Record<string, unknown> = { ...wrapped };
      mutated[field] = field === "parameters" ? { changed: true } : `${field}-changed`;
      return mutated as unknown as ToolDeclaration;
    });
    const facade = catalog.forInventory({
      hash: "h",
      entries: [entry("pkg#echo", "tool"), entry("pkg#evil", "wrapper")],
    });

    expect(
      await facade.invoke(
        { id: "call-1", name: name("pkg#echo"), arguments: null },
        select("pkg#echo", "pkg#evil"),
        context,
      ),
    ).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#evil"));
    expect(executed).toBe(false);
  },
);

test("rejects nested parameter mutation and a missing final execute", async () => {
  const mutationCatalog = createTools();
  mutationCatalog.registerTool(tool("pkg#echo"));
  mutationCatalog.registerWrapper(name("pkg#mutate"), () => (wrapped) => {
    (wrapped.parameters as { changed?: boolean }).changed = true;
    return wrapped;
  });
  const mutationFacade = mutationCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#mutate", "wrapper")],
  });
  expect(
    await mutationFacade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#mutate"),
      context,
    ),
  ).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#mutate"));

  const missingCatalog = createTools();
  missingCatalog.registerTool(tool("pkg#echo", false));
  const missingFacade = missingCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });
  expect(
    await missingFacade.invoke(
      { id: "call-2", name: name("pkg#echo"), arguments: null },
      select("pkg#echo"),
      context,
    ),
  ).toEqual(errorResult("tool.failed", "Tool has no execute function: pkg#echo"));
});

test("caches rejected wrapper factories and reports missing wrapper registrations", async () => {
  const rejectedCatalog = createTools();
  let attempts = 0;
  rejectedCatalog.registerTool(tool("pkg#echo"));
  rejectedCatalog.registerWrapper(name("pkg#broken"), () => {
    attempts++;
    throw new Error("load failed");
  });
  const rejectedFacade = rejectedCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#broken", "wrapper")],
  });
  const first = await rejectedFacade.invoke(
    { id: "call-1", name: name("pkg#echo"), arguments: null },
    select("pkg#echo", "pkg#broken"),
    context,
  );
  const second = await rejectedFacade.invoke(
    { id: "call-2", name: name("pkg#echo"), arguments: null },
    select("pkg#echo", "pkg#broken"),
    context,
  );
  expect(attempts).toBe(1);
  expect(first).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#broken"));
  expect(second).toEqual(first);

  const missingCatalog = createTools();
  missingCatalog.registerTool(tool("pkg#echo"));
  const missingFacade = missingCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#missing", "wrapper")],
  });
  expect(
    await missingFacade.invoke(
      { id: "call-3", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#missing"),
      context,
    ),
  ).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#missing"));
});

test("allows a wrapper to supply execute and rejects a non-object result", async () => {
  const supplyingCatalog = createTools();
  supplyingCatalog.registerTool(tool("pkg#echo", false));
  supplyingCatalog.registerWrapper(name("pkg#supply"), () => (wrapped) => ({
    ...wrapped,
    execute: async () => ({ content: [{ type: "text", text: "supplied" }] }),
  }));
  const supplyingFacade = supplyingCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#supply", "wrapper")],
  });
  expect(
    await supplyingFacade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#supply"),
      context,
    ),
  ).toEqual({ content: [{ type: "text", text: "supplied" }] });

  const badCatalog = createTools();
  badCatalog.registerTool(tool("pkg#echo"));
  badCatalog.registerWrapper(name("pkg#bad"), () => (() => null) as unknown as ToolWrapper);
  const badFacade = badCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#bad", "wrapper")],
  });
  expect(
    await badFacade.invoke(
      { id: "call-2", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#bad"),
      context,
    ),
  ).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#bad"));
});

test("maps only final execute denial and generic failures to tool results", async () => {
  const deniedCatalog = createTools();
  deniedCatalog.registerTool({
    ...tool("pkg#echo"),
    execute: async () => {
      throw new ToolDeniedError("blocked");
    },
  });
  const deniedFacade = deniedCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });
  expect(
    await deniedFacade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      select("pkg#echo"),
      context,
    ),
  ).toEqual(errorResult("tool.denied", "blocked"));

  const cases = [
    [new Error("boom"), "Tool execution failed"],
    ["string failure", "Tool execution failed"],
    [new DOMException("aborted", "AbortError"), "Tool execution failed"],
  ] as const;
  for (const [error, message] of cases) {
    const catalog = createTools();
    catalog.registerTool({
      ...tool("pkg#echo"),
      execute: async () => {
        throw error;
      },
    });
    const facade = catalog.forInventory({
      hash: "h",
      entries: [entry("pkg#echo", "tool")],
    });
    expect(
      await facade.invoke(
        { id: "call-2", name: name("pkg#echo"), arguments: null },
        select("pkg#echo"),
        context,
      ),
    ).toEqual(errorResult("tool.failed", message));
  }

  const existing = createTools();
  existing.registerTool({
    ...tool("pkg#echo"),
    execute: async () => errorResult("custom", "existing"),
  });
  const existingFacade = existing.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });
  expect(
    await existingFacade.invoke(
      { id: "call-3", name: name("pkg#echo"), arguments: null },
      select("pkg#echo"),
      context,
    ),
  ).toEqual(errorResult("custom", "existing"));
});

test("maps wrapper-stage denials to wrapper_invalid", async () => {
  const compositionCatalog = createTools();
  compositionCatalog.registerTool(tool("pkg#echo"));
  compositionCatalog.registerWrapper(name("pkg#deny"), () => () => {
    throw new ToolDeniedError("no");
  });
  const compositionFacade = compositionCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#deny", "wrapper")],
  });
  expect(
    await compositionFacade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#deny"),
      context,
    ),
  ).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#deny"));

  const factoryCatalog = createTools();
  factoryCatalog.registerTool(tool("pkg#echo"));
  factoryCatalog.registerWrapper(name("pkg#factory-deny"), () => {
    throw new ToolDeniedError("factory no");
  });
  const factoryFacade = factoryCatalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#factory-deny", "wrapper")],
  });
  expect(
    await factoryFacade.invoke(
      { id: "call-2", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#factory-deny"),
      context,
    ),
  ).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#factory-deny"));
});

test.each([
  ["Error", new Error("token=secret")],
  ["non-Error", "token=secret"],
])("redacts secrets from generic execute %s failures", async (_label, failure) => {
  const catalog = createTools();
  catalog.registerTool({
    ...tool("pkg#echo"),
    execute: async () => {
      throw failure;
    },
  });
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool")],
  });

  const output = await facade.invoke(
    { id: "call-1", name: name("pkg#echo"), arguments: null },
    select("pkg#echo"),
    context,
  );
  expect(output).toEqual(errorResult("tool.failed", "Tool execution failed"));
  expect(JSON.stringify(output)).not.toContain("secret");
});

test.each([
  ["Date", () => new Date("2026-11-08T00:00:00.000Z")],
  ["non-finite number", () => ({ value: Number.POSITIVE_INFINITY })],
  ["undefined value", () => ({ value: undefined })],
  ["function value", () => ({ value: () => null })],
  ["symbol value", () => ({ value: Symbol("value") })],
  [
    "cyclic structure",
    () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    },
  ],
  ["array root", () => []],
  ["Map prototype", () => new Map()],
  [
    "symbol key",
    () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, Symbol("key"), { enumerable: true, value: true });
      return value;
    },
  ],
])("rejects wrapper parameters containing a %s", async (_label, makeParameters) => {
  const catalog = createTools();
  let executed = false;
  catalog.registerTool({
    ...tool("pkg#echo"),
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "bad" }] };
    },
  });
  catalog.registerWrapper(name("pkg#invalid-params"), () => (wrapped) => ({
    ...wrapped,
    parameters: makeParameters() as unknown as JsonObject,
  }));
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#invalid-params", "wrapper")],
  });

  expect(
    await facade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#invalid-params"),
      context,
    ),
  ).toEqual(errorResult("tool.wrapper_invalid", "Invalid tool wrapper: pkg#invalid-params"));
  expect(executed).toBe(false);
});

test("accepts wrapper parameters containing nested JSON arrays and null", async () => {
  const catalog = createTools();
  const parameters: JsonObject = {
    nested: [1, "text", null, true, { value: 2 }],
  };
  catalog.registerTool({ ...tool("pkg#echo"), parameters });
  catalog.registerWrapper(name("pkg#valid-params"), () => (wrapped) => ({
    ...wrapped,
    parameters: structuredClone(parameters),
  }));
  const facade = catalog.forInventory({
    hash: "h",
    entries: [entry("pkg#echo", "tool"), entry("pkg#valid-params", "wrapper")],
  });

  expect(
    await facade.invoke(
      { id: "call-1", name: name("pkg#echo"), arguments: null },
      select("pkg#echo", "pkg#valid-params"),
      context,
    ),
  ).toEqual({ content: [{ type: "text", text: "ok" }] });
});

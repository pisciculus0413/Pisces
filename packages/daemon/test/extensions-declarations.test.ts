import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDeclarations,
  type ContentBlock,
  type DefinitionSnapshot,
  type EntryName,
  evaluateSelection,
  PiscesError,
  type QueueEntryInput,
  replaySelection,
  type SelectionView,
  type SessionNodeDraft,
} from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { enrichQueueEntries } from "../src/extensions/declarations.js";
import { createExtensions } from "../src/extensions/extensions.js";
import type { ExtensionBinding, ExtensionsOptions } from "../src/extensions/types.js";
import {
  contextSource,
  makePackage,
  toolSource,
  wrapperSource,
  writeSidecar,
} from "./extensions-fixtures.js";

const RUN = "demo#run" as EntryName;
const AUDIT = "demo#audit" as EntryName;
const NOTE = "demo#note" as EntryName;
const GHOST = "ghost#missing" as EntryName;

type EntryKind = "tool" | "wrapper" | "context" | "skill";

let root = "";
let configDir = "";
let options: ExtensionsOptions;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-declarations-"));
  configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  options = { configDir, builtinDir: join(root, "builtin") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

const agent = (value: string): QueueEntryInput => ({
  kind: "agent",
  role: "user",
  source: "user",
  content: text(value),
});

const declaration = (payload: unknown, source = "user"): QueueEntryInput => ({
  kind: "control",
  role: "declaration",
  source,
  content: text(JSON.stringify(payload)),
});

const control = (
  content: ContentBlock[],
  role: "declaration" | "user" = "declaration",
): QueueEntryInput => ({ kind: "control", role, source: "user", content });

const declarationNode = (payload: unknown): SessionNodeDraft => ({
  kind: "control",
  role: "declaration",
  source: "user",
  content: text(JSON.stringify(payload)),
});

const systemNode = (source: EntryName, value: string): SessionNodeDraft => ({
  kind: "agent",
  role: "system",
  source,
  content: text(value),
});

const snapshot = (
  name: EntryName,
  kind: "tool" | "wrapper",
  value: string,
): DefinitionSnapshot => ({
  name,
  kind,
  description: `frozen ${value}`,
  parameters: { value },
  definitionHash: `hash-${value}`,
  ...(kind === "wrapper" ? { configHash: `config-${value}` } : {}),
});

interface DeclarationOutput {
  toggle: EntryName[];
  definitions?: DefinitionSnapshot[];
}

const parsed = (entry: QueueEntryInput): DeclarationOutput => {
  const block = entry.content[0];
  if (block === undefined || block.type !== "text") throw new Error("expected a text declaration");
  return JSON.parse(block.text) as DeclarationOutput;
};

const definitionsOf = (entry: QueueEntryInput): DefinitionSnapshot[] =>
  parsed(entry).definitions ?? [];

const inventoryDefinition = (binding: ExtensionBinding, name: EntryName): DefinitionSnapshot => {
  const definition = binding.inventory.entries.find((entry) => entry.name === name)?.definition;
  if (definition === undefined) throw new Error(`missing inventory definition for ${name}`);
  return definition;
};

// Real temporary workspace + real discovery + real frozen binding.
async function addDemoPackage(
  workspace: string,
  kinds: readonly EntryKind[],
): Promise<ExtensionBinding> {
  const pkg = join(workspace, ".pisces", "extensions", "demo");
  const files: Record<string, string> = {};
  if (kinds.includes("tool")) files["tools/run.ts"] = toolSource(join(root, "run.sentinel"));
  if (kinds.includes("wrapper"))
    files["wrappers/audit.ts"] = wrapperSource(join(root, "audit.sentinel"));
  if (kinds.includes("context"))
    files["context/note.ts"] = contextSource(join(root, "note.sentinel"));
  if (kinds.includes("skill")) files["skills/guide/SKILL.md"] = "guide body";
  await makePackage(pkg, { name: "demo", files });
  if (kinds.includes("tool")) await writeSidecar(pkg, "tools/run.ts", { description: "Runs" });
  if (kinds.includes("wrapper")) {
    await writeSidecar(pkg, "wrappers/audit.ts", {
      description: "Audits",
      config: { defaults: { level: 1 }, schema: { type: "object" } },
    });
  }
  if (kinds.includes("context"))
    await writeSidecar(pkg, "context/note.ts", { description: "Notes" });
  if (kinds.includes("skill")) {
    await writeSidecar(pkg, "skills/guide", { name: "guide" });
  }
  return createExtensions(options).prepare(workspace);
}

test("attaches the same full snapshots whether a toggle opens or closes", async () => {
  const binding = await addDemoPackage(join(root, "open-close"), ["tool", "wrapper"]);
  const opening = enrichQueueEntries(
    binding,
    replaySelection([]),
    [],
    [declaration({ toggle: [RUN, AUDIT] })],
  );
  const closingView = replaySelection([declarationNode({ toggle: [RUN, AUDIT] })]);
  expect(closingView.selection).toEqual([AUDIT, RUN]);
  const closing = enrichQueueEntries(
    binding,
    closingView,
    [],
    [declaration({ toggle: [RUN, AUDIT] })],
  );

  const on = parsed(opening[0] as QueueEntryInput);
  const off = parsed(closing[0] as QueueEntryInput);
  expect(off.definitions).toEqual(on.definitions);
  expect(on.definitions).toEqual([
    inventoryDefinition(binding, AUDIT),
    inventoryDefinition(binding, RUN),
  ]);
  expect(on.definitions?.find((entry) => entry.name === AUDIT)?.configHash).toBe(
    inventoryDefinition(binding, AUDIT).configHash,
  );
  expect(on.definitions?.find((entry) => entry.name === RUN)?.configHash).toBeUndefined();
  // Snapshots are copies, not the binding's frozen objects.
  expect(on.definitions?.[0]).not.toBe(inventoryDefinition(binding, AUDIT));
  expect(on.definitions?.[1]).not.toBe(inventoryDefinition(binding, RUN));
  // No server-side identity is allocated by enrichment.
  expect(Object.keys(opening[0] as QueueEntryInput).sort()).toEqual([
    "content",
    "kind",
    "role",
    "source",
  ]);
  expect(off.toggle).toEqual([RUN, AUDIT]);
});

test("reopens from the surviving declaration alone after an earlier declaration is deleted", async () => {
  const binding = await addDemoPackage(join(root, "deleted"), ["tool", "wrapper"]);
  // The declaration that opened RUN is gone; the branch replays without definitions.
  const view = replaySelection([]);
  const pending: QueueEntryInput[] = [];
  const batch = enrichQueueEntries(binding, view, pending, [
    agent("hello"),
    declaration({ toggle: [AUDIT] }),
  ]);
  expect(view.definitions).toEqual([]);
  expect(batch[0]).toEqual(agent("hello"));
  expect(parsed(batch[1] as QueueEntryInput).toggle).toEqual([AUDIT]);
  expect(definitionsOf(batch[1] as QueueEntryInput)).toEqual([inventoryDefinition(binding, AUDIT)]);
  const applied = applyDeclarations(view, [batch[1] as SessionNodeDraft]);
  expect(applied.selection).toEqual([AUDIT]);
  expect(applied.definitions).toEqual([inventoryDefinition(binding, AUDIT)]);
});

test("closes a default branch with the historical snapshot so it reopens safely elsewhere", async () => {
  // RUN is gone from the binding: only branch history can describe it.
  const binding = await addDemoPackage(join(root, "historical"), ["wrapper"]);
  const old = snapshot(RUN, "tool", "v1");
  const historicalView = replaySelection([declarationNode({ toggle: [RUN], definitions: [old] })]);
  expect(historicalView.selection).toEqual([RUN]);
  expect(historicalView.definitions).toEqual([old]);

  const batch = enrichQueueEntries(binding, historicalView, [], [declaration({ toggle: [RUN] })]);
  expect(definitionsOf(batch[0] as QueueEntryInput)).toEqual([old]);

  // The same declaration XORs back to an opening toggle on the default branch.
  const defaultView = replaySelection([]);
  expect(defaultView.selection).toEqual([]);
  const reopened = applyDeclarations(defaultView, [batch[0] as SessionNodeDraft]);
  expect(reopened.selection).toEqual([RUN]);
  expect(reopened.definitions).toEqual([old]);
  expect(reopened.definitions[0]?.definitionHash).toBe("hash-v1");

  // A vanished content source can still be closed; no tool definition is invented for it.
  const contentView = replaySelection([
    systemNode(RUN, "historical body"),
    declarationNode({ toggle: [RUN] }),
  ]);
  expect(contentView.selection).toEqual([RUN]);
  expect(contentView.contentNames).toEqual([RUN]);
  const closedContent = enrichQueueEntries(
    binding,
    contentView,
    [],
    [declaration({ toggle: [RUN] })],
  );
  expect(definitionsOf(closedContent[0] as QueueEntryInput)).toEqual([]);
  const flipped: SelectionView = { ...contentView, selection: [RUN] };
  const evaluation = evaluateSelection(flipped, binding.entries);
  expect(evaluation.executionSelection).toEqual([]);
  expect(evaluation.contentSelection).toEqual([RUN]);
  expect(evaluation.unresolvedSources).toEqual([]);
});

test("closes a vanished tool with its complete historical snapshot", async () => {
  const binding = await addDemoPackage(join(root, "vanished"), ["wrapper"]);
  const old = snapshot(RUN, "tool", "frozen");
  const view = replaySelection([declarationNode({ toggle: [RUN], definitions: [old] })]);
  const batch = enrichQueueEntries(binding, view, [], [declaration({ toggle: [RUN] })]);
  const definitions = definitionsOf(batch[0] as QueueEntryInput);
  expect(definitions).toEqual([old]);
  expect(definitions[0]?.definitionHash).toBe("hash-frozen");
  expect(Object.keys(definitions[0] as DefinitionSnapshot).sort()).toEqual([
    "definitionHash",
    "description",
    "kind",
    "name",
    "parameters",
  ]);
  expect(binding.entries.kind(RUN)).toBeUndefined();

  // The flip side of the XOR still evaluates through Core as a stale tool, not a new one.
  const reopened: SelectionView = { ...view, selection: [RUN] };
  const evaluation = evaluateSelection(reopened, binding.entries);
  expect(evaluation.unresolvedSources).toEqual([]);
  expect(evaluation.executionSelection).toEqual([]);
  expect(evaluation.effective).toEqual([{ name: RUN, definitionHash: "hash-frozen", stale: true }]);
});

test("rejects a known cross-kind reopen before producing any snapshot", async () => {
  const binding = await addDemoPackage(join(root, "retype"), ["tool", "wrapper"]);
  const oldTool = snapshot(AUDIT, "tool", "old-tool");
  const view = replaySelection([declarationNode({ toggle: [], definitions: [oldTool] })]);
  expect(view.selection).toEqual([]);
  expect(inventoryDefinition(binding, AUDIT).kind).toBe("wrapper");

  const pending: QueueEntryInput[] = [agent("queued")];
  const inputs = [declaration({ toggle: [AUDIT] })];
  const beforeView = structuredClone(view);
  const beforePending = structuredClone(pending);
  const beforeInputs = structuredClone(inputs);
  expect(() => enrichQueueEntries(binding, view, pending, inputs)).toThrowError(
    expect.objectContaining({
      code: "queue.invalid_control",
      message: "Declaration changes a known entry kind",
    }),
  );
  expect(view).toEqual(beforeView);
  expect(pending).toEqual(beforePending);
  expect(inputs).toEqual(beforeInputs);
  expect(inventoryDefinition(binding, AUDIT).kind).toBe("wrapper");
  expect(inventoryDefinition(binding, AUDIT).definitionHash).not.toBe("hash-old-tool");

  // Closing the known entry under its changed kind stays legal and keeps the old kind.
  const closingView = replaySelection([
    declarationNode({ toggle: [AUDIT], definitions: [oldTool] }),
  ]);
  expect(closingView.selection).toEqual([AUDIT]);
  const closed = enrichQueueEntries(binding, closingView, [], [declaration({ toggle: [AUDIT] })]);
  const closedDefinitions = definitionsOf(closed[0] as QueueEntryInput);
  expect(closedDefinitions).toEqual([oldTool]);
  expect(closedDefinitions[0]?.kind).toBe("tool");

  // Historical content cannot be reopened as a newly typed tool.
  const contentView = replaySelection([systemNode(RUN, "historical body")]);
  expect(contentView.contentNames).toEqual([RUN]);
  expect(binding.entries.kind(RUN)).toBe("tool");
  expect(() =>
    enrichQueueEntries(binding, contentView, [], [declaration({ toggle: [RUN] })]),
  ).toThrowError(
    expect.objectContaining({
      code: "queue.invalid_control",
      message: "Declaration changes a known entry kind",
    }),
  );

  // Closing a name whose history is content stays legal; Core keeps it as content.
  const selectedContentView = replaySelection([
    systemNode(RUN, "historical body"),
    declarationNode({ toggle: [RUN] }),
  ]);
  expect(selectedContentView.selection).toEqual([RUN]);
  expect(selectedContentView.contentNames).toEqual([RUN]);
  const closedContent = enrichQueueEntries(
    binding,
    selectedContentView,
    [],
    [declaration({ toggle: [RUN] })],
  );
  expect(parsed(closedContent[0] as QueueEntryInput).toggle).toEqual([RUN]);
  const flipped: SelectionView = { ...selectedContentView, selection: [RUN] };
  const evaluation = evaluateSelection(flipped, binding.entries);
  expect(evaluation.executionSelection).toEqual([]);
  expect(evaluation.contentSelection).toEqual([RUN]);
});

test("a persisted closing declaration cannot legalise a later reopen under a new kind", async () => {
  const binding = await addDemoPackage(join(root, "content-close"), ["tool"]);
  expect(binding.entries.kind(RUN)).toBe("tool");
  const view = replaySelection([
    systemNode(RUN, "historical body"),
    declarationNode({ toggle: [RUN] }),
  ]);
  expect(view.selection).toEqual([RUN]);
  expect(view.contentNames).toEqual([RUN]);
  expect(view.definitions).toEqual([]);

  const closed = enrichQueueEntries(binding, view, [], [declaration({ toggle: [RUN] })]);
  const out = parsed(closed[0] as QueueEntryInput);
  expect(out.toggle).toEqual([RUN]);
  expect(out.definitions ?? []).toEqual([]);

  // Context.assemble persists the enriched declaration verbatim: replaying that
  // branch must not turn the discarded new-kind snapshot into future evidence.
  const persisted = replaySelection([
    systemNode(RUN, "historical body"),
    declarationNode({ toggle: [RUN] }),
    declarationNode(out),
  ]);
  expect(persisted.contentNames).toEqual([RUN]);
  expect(persisted.definitions).toEqual([]);
  expect(() =>
    enrichQueueEntries(binding, persisted, [], [declaration({ toggle: [RUN] })]),
  ).toThrowError(
    expect.objectContaining({
      code: "queue.invalid_control",
      message: "Declaration changes a known entry kind",
    }),
  );
});

test("rejects every forged or malformed declaration as one atomic batch", async () => {
  const binding = await addDemoPackage(join(root, "rejects"), ["tool", "wrapper", "context"]);
  const view = replaySelection([]);
  const pending: QueueEntryInput[] = [agent("queued")];
  const runDefinition = inventoryDefinition(binding, RUN);
  const forged: Array<[string, QueueEntryInput[], string, string]> = [
    [
      "inline empty definitions",
      [agent("hi"), declaration({ toggle: [RUN], definitions: [] })],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "inline definitions",
      [declaration({ toggle: [RUN], definitions: [runDefinition] })],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "entry-name source",
      [declaration({ toggle: [RUN], definitions: [runDefinition] }, RUN)],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "unknown payload key",
      [declaration({ toggle: [RUN], extra: "leak" })],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "duplicate names",
      [declaration({ toggle: [RUN, RUN] })],
      "queue.duplicate_name",
      "Invalid declaration",
    ],
    [
      "invalid name",
      [declaration({ toggle: ["not-an-entry"] })],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "non-declaration control",
      [control(text('{"toggle":[]}'), "user")],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "two content blocks",
      [control([...text('{"toggle":[]}'), ...text('{"toggle":[]}')])],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "non-text block",
      [control([{ type: "reasoning", text: '{"toggle":[]}' }])],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    ["invalid JSON", [control(text("{"))], "queue.invalid_control", "Invalid declaration"],
    ["array payload", [control(text("[]"))], "queue.invalid_control", "Invalid declaration"],
    ["null payload", [control(text("null"))], "queue.invalid_control", "Invalid declaration"],
    [
      "non-array toggle",
      [declaration({ toggle: RUN })],
      "queue.invalid_control",
      "Invalid declaration",
    ],
    [
      "unknown name open",
      [declaration({ toggle: [GHOST] })],
      "queue.invalid_control",
      "Unknown declaration entry",
    ],
  ];
  for (const [label, batch, code, message] of forged) {
    const before = structuredClone(batch);
    let failure: unknown;
    try {
      enrichQueueEntries(binding, view, pending, batch);
    } catch (error) {
      failure = error;
    }
    expect(failure, label).toBeInstanceOf(PiscesError);
    expect((failure as PiscesError).code, label).toBe(code);
    expect((failure as Error).message, label).toBe(message);
    expect((failure as Error).message, label).not.toContain("definitions");
    expect((failure as Error).message, label).not.toContain("leak");
    expect(batch, label).toEqual(before);
  }

  // Closing a name with no current and no historical evidence is rejected too.
  const ghostView = replaySelection([declarationNode({ toggle: [GHOST] })]);
  expect(ghostView.selection).toEqual([GHOST]);
  const beforeGhost = structuredClone(ghostView);
  expect(() =>
    enrichQueueEntries(binding, ghostView, [], [declaration({ toggle: [GHOST] })]),
  ).toThrowError(
    expect.objectContaining({
      code: "queue.invalid_control",
      message: "Unknown declaration entry",
    }),
  );
  expect(ghostView).toEqual(beforeGhost);

  // Pending definitions are validation input only, never persisted evidence.
  const pendingView: QueueEntryInput[] = [
    declaration({ toggle: [], definitions: [snapshot(GHOST, "tool", "pending")] }),
    declaration({ toggle: [GHOST] }),
  ];
  expect(() =>
    enrichQueueEntries(binding, view, pendingView, [declaration({ toggle: [GHOST] })]),
  ).toThrowError(expect.objectContaining({ code: "queue.invalid_control" }));
});

test("returns deep copies that never expose or rewrite caller state", async () => {
  const binding = await addDemoPackage(join(root, "deep-copy"), ["tool", "context"]);
  const pendingDef = snapshot(RUN, "tool", "pending-only");
  const pending: QueueEntryInput[] = [declaration({ toggle: [], definitions: [pendingDef] })];
  const view = replaySelection([systemNode(NOTE, "note body")]);
  expect(view.contentNames).toEqual([NOTE]);
  const agentInput = agent("hello");
  const declarationInput = declaration({ toggle: [RUN, NOTE] });
  const beforeView = structuredClone(view);
  const beforePending = structuredClone(pending);
  const beforeAgent = structuredClone(agentInput);
  const beforeDeclaration = structuredClone(declarationInput);
  const beforeInventory = structuredClone(inventoryDefinition(binding, RUN));

  const batch = enrichQueueEntries(binding, view, pending, [agentInput, declarationInput]);

  expect(batch).toHaveLength(2);
  expect(batch[0]).not.toBe(agentInput);
  expect(batch[0]?.content[0]).not.toBe(agentInput.content[0]);
  expect(batch[1]).not.toBe(declarationInput);
  expect(batch[1]?.content[0]).not.toBe(declarationInput.content[0]);
  const out = parsed(batch[1] as QueueEntryInput);
  expect(out.toggle).toEqual([RUN, NOTE]);
  // Pending-only definitions are neither shown nor reused; NOTE is historical content.
  expect(out.definitions).toEqual([inventoryDefinition(binding, RUN)]);
  expect(out.definitions?.[0]).not.toBe(inventoryDefinition(binding, RUN));
  expect(out.definitions?.[0]?.definitionHash).not.toBe("hash-pending-only");

  // A batch without declarations only clones its agent entries.
  const agents = enrichQueueEntries(binding, view, [], [agentInput]);
  expect(agents).toEqual([agentInput]);
  expect(agents[0]).not.toBe(agentInput);

  (batch[0] as QueueEntryInput).content[0] = { type: "text", text: "mutated" };
  (batch[0] as QueueEntryInput).source = "mutated";
  (batch[0] as QueueEntryInput).content.push({ type: "text", text: "injected" });
  (batch[1] as QueueEntryInput).content[0] = { type: "text", text: "{}" };
  batch.push(agent("injected"));

  expect(agentInput).toEqual(beforeAgent);
  expect(declarationInput).toEqual(beforeDeclaration);
  expect(view).toEqual(beforeView);
  expect(pending).toEqual(beforePending);
  expect(inventoryDefinition(binding, RUN)).toEqual(beforeInventory);
  expect(view.definitions).toEqual([]);
});

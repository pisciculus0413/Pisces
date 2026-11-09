import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DefinitionSnapshot,
  EntryName,
  JsonObject,
  SessionId,
  ToolInvocationContext,
  ToolResult,
} from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createExtensions } from "../src/extensions/extensions.js";
import type { ExtensionBinding, ExtensionsOptions } from "../src/extensions/types.js";
import { makePackage, writeJson, writeText } from "./extensions-fixtures.js";

const RUN = "demo#run" as EntryName;
const AUDIT = "demo#audit" as EntryName;
const NOTE = "demo#note" as EntryName;
const GUIDE = "demo#guide" as EntryName;

const invocation: ToolInvocationContext = {
  sessionId: "s1" as SessionId,
  workspace: "/workspace",
  signal: new AbortController().signal,
};

let root = "";
let configDir = "";
let options: ExtensionsOptions;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-binding-"));
  configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  options = { configDir, builtinDir: join(root, "builtin") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const workspace = (name: string): string => join(root, name);

const packageRoot = (workspaceDir: string, name: string): string =>
  join(workspaceDir, ".pisces", "extensions", name);

// Appends one line per module evaluation so tests can prove import laziness and caching.
function counterPrelude(log: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(log)}, "load\\n");`,
    "",
  ].join("\n");
}

function toolModule(log: string, output: string): string {
  return [
    counterPrelude(log),
    "export default async function run() {",
    `  return { content: [{ type: "text", text: ${JSON.stringify(output)} }] };`,
    "}",
    "",
  ].join("\n");
}

function brokenToolModule(log: string): string {
  return [
    counterPrelude(log),
    "export default async function run() {",
    '  return { content: [{ type: "text", text: "unreachable" }] };',
    "}",
    'throw new Error("broken module");',
    "",
  ].join("\n");
}

function wrapperModule(log: string, exportedConfig?: JsonObject): string {
  const configLine =
    exportedConfig === undefined ? "" : `export const config = ${JSON.stringify(exportedConfig)};`;
  return [
    counterPrelude(log),
    configLine,
    "export default function createWrapper(config) {",
    "  return (tool) => ({",
    "    ...tool,",
    '    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(config) }] }),',
    "  });",
    "}",
    "",
  ].join("\n");
}

function rejectingWrapperModule(log: string): string {
  return [
    counterPrelude(log),
    "export default function createWrapper() {",
    '  return Promise.reject(new Error("wrapper load failed"));',
    "}",
    "",
  ].join("\n");
}

function contextModule(log: string, output: string): string {
  return [
    counterPrelude(log),
    "export default async function resolve() {",
    `  return [{ source: ${JSON.stringify(NOTE)}, content: [{ type: "text", text: ${JSON.stringify(output)} }] }];`,
    "}",
    "",
  ].join("\n");
}

async function loadCount(log: string): Promise<number> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line === "load").length;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return 0;
    throw error;
  }
}

function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") throw new Error("Missing text result");
  return block.text;
}

async function invoke(
  binding: ExtensionBinding,
  name: EntryName,
  selection: EntryName[] = [name],
): Promise<ToolResult> {
  return binding.tools.invoke({ id: `call:${name}`, name, arguments: null }, selection, invocation);
}

async function invokeText(
  binding: ExtensionBinding,
  name: EntryName,
  selection: EntryName[] = [name],
): Promise<string> {
  const result = await invoke(binding, name, selection);
  if (result.isError) throw new Error(textOf(result));
  return textOf(result);
}

async function addPackage(
  workspaceDir: string,
  name: string,
  files: Record<string, string>,
  manifest?: unknown,
): Promise<string> {
  const rootDir = packageRoot(workspaceDir, name);
  await makePackage(rootDir, {
    name,
    files,
    ...(manifest === undefined ? {} : { manifest }),
  });
  return rootDir;
}

test("rescans on every prepare while an old binding keeps its frozen files and module", async () => {
  const ws = workspace("frozen");
  const log = join(root, "frozen.log");
  const rootDir = await addPackage(ws, "demo", {
    "tools/run.ts": toolModule(log, "old"),
    "tools/run.ts.meta.json": JSON.stringify({ description: "old" }),
    "skills/guide.meta.json": JSON.stringify({ name: "guide" }),
    "skills/guide/SKILL.md": "old skill",
  });
  await writeJson(join(ws, ".pisces", "config.json"), { extensions: [RUN] });

  const extensions = createExtensions(options);
  const old = await extensions.prepare(ws);
  expect(await invokeText(old, RUN)).toBe("old");
  expect(await loadCount(log)).toBe(1);

  await writeText(join(rootDir, "tools", "run.ts"), toolModule(log, "fresh"));
  await writeJson(join(rootDir, "tools", "run.ts.meta.json"), { description: "fresh" });
  await writeText(join(rootDir, "skills", "guide", "SKILL.md"), "new skill");
  await writeJson(join(ws, ".pisces", "config.json"), { extensions: [GUIDE] });

  const fresh = await extensions.prepare(ws);

  expect(old.inventory.hash).not.toBe(fresh.inventory.hash);
  expect(old.config.extensions).toEqual([RUN]);
  expect(fresh.config.extensions).toEqual([GUIDE]);
  expect(old.inventory.entries.find((entry) => entry.name === RUN)?.description).toBe("old");
  expect(fresh.inventory.entries.find((entry) => entry.name === RUN)?.description).toBe("fresh");
  expect(old.tools.selected([RUN])[0]?.description).toBe("old");
  expect(fresh.tools.selected([RUN])[0]?.description).toBe("fresh");
  expect(old.skills.selected([GUIDE])).toEqual([
    { name: GUIDE, source: "demo", content: [{ type: "text", text: "old skill" }] },
  ]);
  expect(fresh.skills.selected([GUIDE])).toEqual([
    { name: GUIDE, source: "demo", content: [{ type: "text", text: "new skill" }] },
  ]);
  expect(old.entries.kind(RUN)).toBe("tool");
  expect(fresh.entries.kind(RUN)).toBe("tool");

  // The old binding reuses its cached module: frozen bytes are never re-executed.
  expect(await invokeText(old, RUN)).toBe("old");
  expect(await loadCount(log)).toBe(1);
  expect(await invokeText(fresh, RUN)).toBe("fresh");
  expect(await loadCount(log)).toBe(2);
});

test("runs each workspace's own implementation for the same entry name", async () => {
  const leftLog = join(root, "left.log");
  const rightLog = join(root, "right.log");
  const leftWs = workspace("left");
  const rightWs = workspace("right");
  await addPackage(leftWs, "demo", { "tools/run.ts": toolModule(leftLog, "left") });
  await addPackage(rightWs, "demo", { "tools/run.ts": toolModule(rightLog, "right") });

  const extensions = createExtensions(options);
  const [left, right] = await Promise.all([
    extensions.prepare(leftWs),
    extensions.prepare(rightWs),
  ]);

  expect(left.inventory.entries.map((entry) => entry.name)).toEqual([RUN]);
  expect(right.inventory.entries.map((entry) => entry.name)).toEqual([RUN]);

  const [leftText, rightText] = await Promise.all([invokeText(left, RUN), invokeText(right, RUN)]);
  expect(leftText).toBe("left");
  expect(rightText).toBe("right");
  expect(await loadCount(leftLog)).toBe(1);
  expect(await loadCount(rightLog)).toBe(1);
});

test("loads no module code until a tool is invoked, a source resolved, or a wrapper applied", async () => {
  const ws = workspace("lazy");
  const toolLog = join(root, "lazy-tool.log");
  const wrapperLog = join(root, "lazy-wrapper.log");
  const contextLog = join(root, "lazy-context.log");
  await addPackage(ws, "demo", {
    "tools/run.ts": toolModule(toolLog, "ran"),
    "wrappers/audit.ts": wrapperModule(wrapperLog, { level: 1 }),
    "wrappers/audit.ts.meta.json": JSON.stringify({
      config: { defaults: { level: 1 }, schema: { type: "object" } },
    }),
    "context/note.ts": contextModule(contextLog, "note body"),
    "skills/guide.meta.json": JSON.stringify({ name: "guide" }),
    "skills/guide/SKILL.md": "guide body",
  });

  const extensions = createExtensions(options);
  const binding = await extensions.prepare(ws);

  expect(binding.tools.selected([RUN, AUDIT]).map((entry) => entry.name)).toEqual([RUN]);
  expect(binding.skills.selected([GUIDE]).map((entry) => entry.name)).toEqual([GUIDE]);
  expect(binding.sources.get(NOTE)?.id).toBe(NOTE);
  expect(binding.sources.get(RUN)).toBeUndefined();
  expect(binding.entries.kind(RUN)).toBe("tool");
  expect(binding.entries.kind(AUDIT)).toBe("wrapper");
  expect(binding.entries.kind(GUIDE)).toBe("skill");
  expect(binding.entries.kind(NOTE)).toBe("context");
  expect(binding.entries.kind("demo#missing" as EntryName)).toBeUndefined();

  const toolDefinition = binding.inventory.entries.find((entry) => entry.name === RUN)?.definition;
  const wrapperDefinition = binding.inventory.entries.find(
    (entry) => entry.name === AUDIT,
  )?.definition;
  expect(toolDefinition).toBeDefined();
  expect(wrapperDefinition?.configHash).toBeDefined();
  expect(binding.entries.matchesDefinition?.(toolDefinition as DefinitionSnapshot)).toBe(true);
  expect(binding.entries.matchesDefinition?.(wrapperDefinition as DefinitionSnapshot)).toBe(true);

  expect(await loadCount(toolLog)).toBe(0);
  expect(await loadCount(wrapperLog)).toBe(0);
  expect(await loadCount(contextLog)).toBe(0);

  expect(await invokeText(binding, RUN)).toBe("ran");
  expect(await loadCount(toolLog)).toBe(1);
  expect(await loadCount(wrapperLog)).toBe(0);
  expect(await loadCount(contextLog)).toBe(0);

  const source = binding.sources.get(NOTE);
  expect(source).toBeDefined();
  const exposed = source as NonNullable<typeof source>;
  expect(Object.isFrozen(exposed)).toBe(true);
  expect(Reflect.set(exposed, "id", "demo#other")).toBe(false);
  expect(Reflect.set(exposed, "resolve", async () => [])).toBe(false);
  expect(exposed.id).toBe(NOTE);
  expect(binding.sources.get(NOTE)).not.toBe(exposed);
  expect(Object.isFrozen(binding.sources.get(NOTE))).toBe(true);
  const fragments = await exposed.resolve({
    sessionId: "s1" as SessionId,
    workspace: ws,
  });
  expect(fragments).toEqual([{ source: NOTE, content: [{ type: "text", text: "note body" }] }]);
  expect(await loadCount(contextLog)).toBe(1);
  expect(await loadCount(wrapperLog)).toBe(0);

  expect(await invokeText(binding, RUN, [RUN, AUDIT])).toBe('{"level":1}');
  expect(await loadCount(wrapperLog)).toBe(1);
});

test("compares definitions with the frozen binding without touching disk or modules", async () => {
  const ws = workspace("definition");
  const log = join(root, "definition.log");
  await addPackage(ws, "demo", {
    "tools/run.ts": toolModule(log, "ran"),
    "tools/run.ts.meta.json": JSON.stringify({ description: "frozen tool" }),
  });

  const extensions = createExtensions(options);
  const binding = await extensions.prepare(ws);
  const definition = binding.inventory.entries.find((entry) => entry.name === RUN)
    ?.definition as DefinitionSnapshot;
  expect(definition).toBeDefined();

  const matches = (candidate: DefinitionSnapshot): boolean =>
    binding.entries.matchesDefinition?.(candidate) === true;

  expect(matches(definition)).toBe(true);
  expect(matches({ ...definition, name: "other#run" as EntryName })).toBe(false);
  expect(matches({ ...definition, kind: "wrapper" })).toBe(false);
  expect(matches({ ...definition, definitionHash: "0".repeat(64) })).toBe(false);
  expect(matches({ ...definition, configHash: "0".repeat(64) })).toBe(false);
  expect(matches({ ...definition, description: "changed" })).toBe(true);
  expect(await loadCount(log)).toBe(0);
});

test("feeds the frozen merged wrapper config to the factory and rejects mismatched module config", async () => {
  const goodToolLog = join(root, "good-tool.log");
  const goodWrapperLog = join(root, "good-wrapper.log");
  const goodWs = workspace("config-good");
  await addPackage(goodWs, "demo", { "tools/run.ts": toolModule(goodToolLog, "ran") });
  await addPackage(goodWs, "configpkg", {
    "wrappers/audit.ts": wrapperModule(goodWrapperLog, { limit: 1, nested: { a: 1 } }),
    "wrappers/audit.ts.meta.json": JSON.stringify({
      config: {
        defaults: { limit: 1, nested: { a: 1 } },
        schema: {
          type: "object",
          properties: { limit: { type: "integer" }, nested: { type: "object" } },
          required: ["limit"],
        },
      },
    }),
  });
  await writeJson(join(goodWs, ".pisces", "config.json"), {
    entryConfig: { "configpkg#audit": { nested: { b: 2 } } },
  });

  const extensions = createExtensions(options);
  const good = await extensions.prepare(goodWs);
  const audit = "configpkg#audit" as EntryName;
  expect(good.inventory.entries.find((entry) => entry.name === audit)?.definition?.configHash).toBe(
    createHash("sha256").update('{"limit":1,"nested":{"a":1,"b":2}}').digest("hex"),
  );

  // A later disk change cannot alter the config already frozen into this binding.
  await writeJson(join(goodWs, ".pisces", "config.json"), {
    entryConfig: { "configpkg#audit": { limit: 7, nested: { b: 9 } } },
  });
  // The module exports the sidecar defaults, not the merged values; the factory gets merged.
  expect(await invokeText(good, RUN, [RUN, audit])).toBe('{"limit":1,"nested":{"a":1,"b":2}}');
  expect(await invokeText(good, RUN, [RUN, audit])).toBe('{"limit":1,"nested":{"a":1,"b":2}}');
  expect(await loadCount(goodToolLog)).toBe(0);
  expect(await loadCount(goodWrapperLog)).toBe(1);

  const badWs = workspace("config-bad");
  const badLog = join(root, "bad-wrapper.log");
  await addPackage(badWs, "demo", { "tools/run.ts": toolModule(badLog, "ran") });
  await addPackage(badWs, "configpkg", {
    "wrappers/audit.ts": wrapperModule(badLog, { limit: 999 }),
    "wrappers/audit.ts.meta.json": JSON.stringify({
      config: { defaults: { limit: 1 }, schema: {} },
    }),
  });
  const bad = await extensions.prepare(badWs);
  const rejected = await invoke(bad, RUN, [RUN, audit]);
  expect(rejected.isError).toBe(true);
  expect(rejected.code).toBe("tool.wrapper_invalid");
  const again = await invoke(bad, RUN, [RUN, audit]);
  expect(again.code).toBe("tool.wrapper_invalid");
  expect(await loadCount(badLog)).toBe(1);

  // A module export is never a hidden default source when the sidecar declares none.
  const hiddenWs = workspace("config-hidden");
  const hiddenToolLog = join(root, "hidden-tool.log");
  const hiddenWrapperLog = join(root, "hidden-wrapper.log");
  await addPackage(hiddenWs, "demo", { "tools/run.ts": toolModule(hiddenToolLog, "ran") });
  await addPackage(hiddenWs, "hidden", {
    "wrappers/audit.ts": wrapperModule(hiddenWrapperLog, { mode: "hidden" }),
  });
  const hiddenBinding = await extensions.prepare(hiddenWs);
  const hidden = "hidden#audit" as EntryName;
  expect((await invoke(hiddenBinding, RUN, [RUN, hidden])).code).toBe("tool.wrapper_invalid");
  expect(await loadCount(hiddenWrapperLog)).toBe(1);
  expect(await loadCount(hiddenToolLog)).toBe(0);

  const asyncWs = workspace("config-async");
  const asyncLog = join(root, "async-wrapper.log");
  await addPackage(asyncWs, "demo", {
    "tools/run.ts": toolModule(asyncLog, "ran"),
    "wrappers/audit.ts": [
      counterPrelude(asyncLog),
      "export default function createWrapper(config) {",
      "  return Promise.resolve((tool) => ({",
      "    ...tool,",
      '    execute: async () => ({ content: [{ type: "text", text: "async:" + config.mode }] }),',
      "  }));",
      "}",
      "",
    ].join("\n"),
    "wrappers/audit.ts.meta.json": JSON.stringify({
      config: { defaults: { mode: "frozen" }, schema: {} },
    }),
  });
  const asyncBinding = await extensions.prepare(asyncWs);
  expect(await invokeText(asyncBinding, RUN, [RUN, AUDIT])).toBe("async:frozen");
  expect(await invokeText(asyncBinding, RUN, [RUN, AUDIT])).toBe("async:frozen");
  expect(await loadCount(asyncLog)).toBe(1);
});

test("caches a broken module per binding without poisoning a healthy binding", async () => {
  const brokenLog = join(root, "broken.log");
  const healthyLog = join(root, "healthy.log");
  const brokenWs = workspace("broken");
  const healthyWs = workspace("healthy");
  await addPackage(brokenWs, "demo", { "tools/run.ts": brokenToolModule(brokenLog) });
  await addPackage(healthyWs, "demo", { "tools/run.ts": toolModule(healthyLog, "healthy") });

  const extensions = createExtensions(options);
  const [broken, healthy] = await Promise.all([
    extensions.prepare(brokenWs),
    extensions.prepare(healthyWs),
  ]);

  const first = await invoke(broken, RUN);
  const second = await invoke(broken, RUN);
  expect(first.isError).toBe(true);
  expect(first.code).toBe("tool.failed");
  expect(second.code).toBe("tool.failed");
  expect(await loadCount(brokenLog)).toBe(1);

  expect(await invokeText(healthy, RUN)).toBe("healthy");
  expect(await loadCount(healthyLog)).toBe(1);
});

test("caches a rejected wrapper factory promise inside one binding only", async () => {
  const ws = workspace("rejected");
  const log = join(root, "rejected.log");
  await addPackage(ws, "demo", {
    "tools/run.ts": toolModule(log, "ran"),
    "wrappers/audit.ts": rejectingWrapperModule(log),
  });

  const extensions = createExtensions(options);
  const [first, second] = await Promise.all([extensions.prepare(ws), extensions.prepare(ws)]);

  const [firstResult, secondResult] = await Promise.all([
    invoke(first, RUN, [RUN, AUDIT]),
    invoke(second, RUN, [RUN, AUDIT]),
  ]);
  expect(firstResult.code).toBe("tool.wrapper_invalid");
  expect(secondResult.code).toBe("tool.wrapper_invalid");
  // One execution per binding: the promise cache is per binding, not global by module path.
  expect(await loadCount(log)).toBe(2);

  const [againFirst, againSecond] = await Promise.all([
    invoke(first, RUN, [RUN, AUDIT]),
    invoke(second, RUN, [RUN, AUDIT]),
  ]);
  expect(againFirst.code).toBe("tool.wrapper_invalid");
  expect(againSecond.code).toBe("tool.wrapper_invalid");
  expect(await loadCount(log)).toBe(2);
});

test("rejects explicit user config errors and isolates frozen wrapper failures", async () => {
  const ws = workspace("issues");
  const log = join(root, "issues.log");
  await addPackage(ws, "demo", { "tools/run.ts": toolModule(log, "ran") });
  await addPackage(ws, "broken", {
    "wrappers/audit.ts": wrapperModule(log),
    "wrappers/audit.ts.meta.json": JSON.stringify({
      config: { defaults: {}, schema: { type: "object", required: ["mode"] } },
    }),
  });

  const extensions = createExtensions(options);
  await writeJson(join(ws, ".pisces", "config.json"), { entryConfig: { [RUN]: {} } });
  await expect(extensions.prepare(ws)).rejects.toMatchObject({ code: "config.invalid" });

  await writeJson(join(ws, ".pisces", "config.json"), {});
  const binding = await extensions.prepare(ws);
  const broken = "broken#audit" as EntryName;
  expect(binding.issues).toContainEqual({
    code: "extensions.invalid",
    source: "broken",
    name: broken,
  });
  expect(binding.entries.kind(broken)).toBeUndefined();
  expect(binding.tools.selected([broken])).toEqual([]);
  expect(await invokeText(binding, RUN)).toBe("ran");
  expect(await loadCount(log)).toBe(1);
});

test("maps a missing workspace to the safe configuration error", async () => {
  const extensions = createExtensions(options);
  await expect(extensions.prepare(join(root, "missing"))).rejects.toMatchObject({
    code: "config.invalid",
    message: "Invalid extension configuration",
  });
});

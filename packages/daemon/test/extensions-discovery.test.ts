import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type EntryInfo, type EntryName, type JsonValue, PiscesError } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { defaultBuiltinDir, discoverExtensions } from "../src/extensions/discovery.js";
import type { ExtensionConfig } from "../src/extensions/types.js";
import {
  contextSource,
  makePackage,
  toolSource,
  wrapperSource,
  writeSidecar,
  writeText,
} from "./extensions-fixtures.js";

const INVALID = "Invalid extension configuration";

const entryName = (value: string): EntryName => value as EntryName;

let root = "";
let configDir = "";
let workspace = "";
let builtinDir = "";
let sentinel = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-discovery-"));
  configDir = join(root, "config");
  workspace = join(root, "workspace");
  builtinDir = join(root, "builtin");
  sentinel = join(root, "sentinel.txt");
  await mkdir(configDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const options = (): { configDir: string; builtinDir: string } => ({ configDir, builtinDir });

const extensionsDir = (...parts: string[]): string => join(configDir, "extensions", ...parts);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

const digest = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

// Independent canonical JSON: sorted object keys, array order preserved.
function canonical(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const record = value as Record<string, JsonValue>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key] as JsonValue)}`)
    .join(",")}}`;
}

const hashJson = (value: JsonValue): string => digest(canonical(value));

async function fileDigest(path: string): Promise<string> {
  return digest(await readFile(path));
}

async function rejectsConfig(run: () => Promise<unknown>): Promise<PiscesError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect((error as PiscesError).code).toBe("config.invalid");
    expect((error as Error).message).toBe(INVALID);
    return error as PiscesError;
  }
  throw new Error("expected the operation to fail");
}

test("discovers scoped and conventional entries without executing entry code", async () => {
  const scoped = extensionsDir("@scope", "pkg");
  await makePackage(scoped, {
    name: "@scope/pkg",
    files: { "tools/read.ts": toolSource(sentinel) },
  });
  const other = extensionsDir("other");
  await makePackage(other, {
    name: "other",
    manifest: { skills: ["skills/skill"] },
    files: {
      "skills/skill/SKILL.md": "Skill body\n",
      "skills/skill/extra.txt": "not injected",
    },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual([
    "@scope/pkg#read",
    "other#skill",
  ]);
  const tool = result.inventory.entries[0] as EntryInfo;
  expect(tool.type).toBe("tool");
  expect(tool.source).toBe("@scope/pkg");
  expect(tool.description).toBe("");
  expect(tool.definition).toEqual({
    name: "@scope/pkg#read",
    kind: "tool",
    description: "",
    parameters: {},
    definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(tool.definitionHash).toBe(tool.definition?.definitionHash);
  const toolRecord = result.records.get(entryName("@scope/pkg#read"));
  expect(toolRecord?.packageRoot).toBe(resolve(scoped));
  expect(toolRecord?.entryPath).toBe(join(resolve(scoped), "tools/read.ts"));

  const skill = result.inventory.entries[1] as EntryInfo;
  expect(skill.type).toBe("skill");
  expect(skill.source).toBe("other");
  expect(skill.description).toBe("");
  expect(skill.definition).toBeUndefined();
  expect(skill.definitionHash).toBeUndefined();
  const skillRecord = result.records.get(entryName("other#skill"));
  expect(skillRecord?.skillContent).toEqual([{ type: "text", text: "Skill body\n" }]);
  expect(skillRecord?.entryDigest).toBe(await fileDigest(join(other, "skills/skill/SKILL.md")));

  expect(result.issues).toEqual([]);
  expect(result.records.size).toBe(2);
  expect(await exists(sentinel)).toBe(false);
});

test("produces the same inventory hash for identical bytes at different install paths", async () => {
  const build = async (base: string, order: string[]): Promise<string> => {
    const packages: Record<string, () => Promise<unknown>> = {
      alpha: () =>
        makePackage(join(base, "extensions", "alpha"), {
          name: "alpha",
          files: { "tools/a.ts": toolSource("/nonexistent/pisces-stable-sentinel") },
        }),
      beta: () =>
        makePackage(join(base, "extensions", "beta"), {
          name: "beta",
          manifest: { skills: ["skills/b"] },
          files: { "skills/b/SKILL.md": "Beta body\n" },
        }),
    };
    for (const name of order) await packages[name]?.();
    return base;
  };
  const firstDir = await build(join(root, "first"), ["alpha", "beta"]);
  const secondDir = await build(join(root, "second"), ["beta", "alpha"]);

  const first = await discoverExtensions(
    { configDir: firstDir, builtinDir: join(root, "no-builtin-1") },
    workspace,
    {},
  );
  const second = await discoverExtensions(
    { configDir: secondDir, builtinDir: join(root, "no-builtin-2") },
    workspace,
    {},
  );

  expect(first.inventory.hash).toBe(second.inventory.hash);
  expect(first.inventory.entries.map((entry) => entry.definitionHash)).toEqual(
    second.inventory.entries.map((entry) => entry.definitionHash),
  );
  expect(first.inventory.entries.map((entry) => entry.name)).toEqual(["alpha#a", "beta#b"]);
  expect(first.records.get(entryName("alpha#a"))?.entryDigest).toBe(
    second.records.get(entryName("alpha#a"))?.entryDigest,
  );
});

test("deduplicates package roots reached through symlinks by realpath", async () => {
  const target = join(root, "shared", "pkg");
  await makePackage(target, { name: "shared", files: { "tools/s.ts": toolSource(sentinel) } });
  await mkdir(join(configDir, "extensions"), { recursive: true });
  await mkdir(join(workspace, ".pisces", "extensions"), { recursive: true });
  await symlink(target, extensionsDir("shared"));
  await symlink(target, join(workspace, ".pisces", "extensions", "shared"));

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["shared#s"]);
  expect(result.issues).toEqual([]);
  expect(result.records.get(entryName("shared#s"))?.packageRoot).toBe(resolve(target));
  expect(await exists(sentinel)).toBe(false);
});

test("excludes every version of a duplicated package#name", async () => {
  await makePackage(extensionsDir("one"), {
    name: "dup",
    files: { "tools/x.ts": toolSource(sentinel) },
  });
  await makePackage(join(workspace, ".pisces", "extensions", "two"), {
    name: "dup",
    files: { "tools/x.ts": toolSource(sentinel) },
  });
  await makePackage(extensionsDir("keep"), {
    name: "keep",
    files: { "tools/y.ts": toolSource(sentinel) },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["keep#y"]);
  expect(result.records.has(entryName("dup#x"))).toBe(false);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.duplicate", source: "dup#x" }),
  );
  expect(await exists(sentinel)).toBe(false);
});

test("explicit manifests replace conventions, support globs and exclusions", async () => {
  const pkg = extensionsDir("globbed");
  await makePackage(pkg, {
    name: "globbed",
    manifest: { tools: ["src/*.ts", "!src/skip.ts"] },
    files: {
      "src/a.ts": toolSource(sentinel),
      "src/skip.ts": toolSource(sentinel),
      "tools/ignored.ts": toolSource(sentinel),
    },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["globbed#a"]);
  expect(result.issues).toEqual([]);
  expect(await exists(sentinel)).toBe(false);
});

test("explicit empty manifest disables conventional directories", async () => {
  const pkg = extensionsDir("empty-manifest");
  await makePackage(pkg, {
    name: "empty-manifest",
    manifest: {},
    files: { "tools/present.ts": toolSource(sentinel) },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries).toEqual([]);
  expect(result.issues).toEqual([]);
  expect(result.inventory.hash).toBe(hashJson([]));
  expect(await exists(sentinel)).toBe(false);
});

test("rejects entries resolving outside the package root", async () => {
  const pkg = extensionsDir("trav");
  await makePackage(pkg, {
    name: "trav",
    manifest: { tools: ["../outside.ts"] },
  });
  await writeText(join(configDir, "extensions", "outside.ts"), toolSource(sentinel));

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries).toEqual([]);
  expect(result.records.size).toBe(0);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "trav" }),
  );
  expect(JSON.stringify(result.issues)).not.toContain(configDir);
  expect(await exists(sentinel)).toBe(false);
});

test("isolates packages with missing entry bodies", async () => {
  await makePackage(extensionsDir("missing"), {
    name: "missing",
    manifest: { tools: ["tools/absent.ts"] },
  });
  await makePackage(extensionsDir("ok"), {
    name: "ok",
    manifest: { tools: ["tools/good.ts"] },
    files: { "tools/good.ts": toolSource(sentinel) },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["ok#good"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "missing" }),
  );
  expect(await exists(sentinel)).toBe(false);
});

test("isolates entries with a corrupt sidecar instead of reading its contents", async () => {
  const pkg = extensionsDir("bad-sidecar");
  await makePackage(pkg, {
    name: "bad-sidecar",
    manifest: { tools: ["tools/bad.ts", "tools/good.ts"] },
    files: {
      "tools/bad.ts": toolSource(sentinel),
      "tools/good.ts": toolSource(sentinel),
    },
  });
  await writeText(join(pkg, "tools/bad.ts.meta.json"), '{"name": "leak hunter2"');

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["bad-sidecar#good"]);
  expect(result.records.has(entryName("bad-sidecar#bad"))).toBe(false);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "bad-sidecar" }),
  );
  expect(JSON.stringify(result.issues)).not.toContain("hunter2");
  expect(await exists(sentinel)).toBe(false);
});

test("rejects invalid wrapper schemas without executing or loading them", async () => {
  const pkg = extensionsDir("bad-schema");
  await makePackage(pkg, {
    name: "bad-schema",
    manifest: { wrappers: ["wrappers/bad.ts", "wrappers/remote.ts", "wrappers/ok.ts"] },
    files: {
      "wrappers/bad.ts": wrapperSource(sentinel),
      "wrappers/remote.ts": wrapperSource(sentinel),
      "wrappers/ok.ts": wrapperSource(sentinel),
    },
  });
  await writeSidecar(pkg, "wrappers/bad.ts", {
    name: "bad",
    config: { defaults: {}, schema: { type: 5 } },
  });
  await writeSidecar(pkg, "wrappers/remote.ts", {
    name: "remote",
    config: { defaults: {}, schema: { $ref: "https://example.invalid/schema.json" } },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["bad-schema#ok"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "bad-schema" }),
  );
  expect(await exists(sentinel)).toBe(false);
});

test("fails with config.invalid for unknown or non-wrapper entryConfig targets", async () => {
  const pkg = extensionsDir("configured");
  await makePackage(pkg, {
    name: "configured",
    manifest: { tools: ["tools/t.ts"], wrappers: ["wrappers/w.ts"] },
    files: {
      "tools/t.ts": toolSource(sentinel),
      "wrappers/w.ts": wrapperSource(sentinel),
    },
  });

  await writeSidecar(pkg, "wrappers/w.ts", {
    config: {
      defaults: { limit: 1 },
      schema: { type: "object", properties: { limit: { type: "number" } } },
    },
  });

  await rejectsConfig(() =>
    discoverExtensions(options(), workspace, {
      entryConfig: { "configured#nope": {} },
    }),
  );
  await rejectsConfig(() =>
    discoverExtensions(options(), workspace, {
      entryConfig: { "configured#t": {} },
    }),
  );
  await rejectsConfig(() =>
    discoverExtensions(options(), workspace, {
      entryConfig: { "configured#w": { limit: "not-a-number" } },
    }),
  );
  expect(await exists(sentinel)).toBe(false);
});

test("merges wrapper defaults with overrides and freezes the declared config", async () => {
  const pkg = extensionsDir("wrapped");
  await makePackage(pkg, {
    name: "wrapped",
    manifest: { wrappers: ["wrappers/w.ts"] },
    files: { "wrappers/w.ts": wrapperSource(sentinel) },
  });
  await writeSidecar(pkg, "wrappers/w.ts", {
    description: "Wraps calls",
    parameters: { type: "object" },
    config: {
      defaults: { limit: 5, nested: { mode: "safe" } },
      schema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          nested: {
            type: "object",
            properties: { mode: { type: "string" }, tag: { type: "string" } },
          },
        },
      },
    },
  });

  const config: ExtensionConfig = {
    entryConfig: { "wrapped#w": { nested: { tag: "user" } } },
  };
  const snapshot = structuredClone(config);
  const expected = { limit: 5, nested: { mode: "safe", tag: "user" } };

  const result = await discoverExtensions(options(), workspace, config);
  const record = result.records.get(entryName("wrapped#w"));

  expect(record?.wrapperConfig).toEqual(expected);
  expect(record?.wrapperConfigSpec).toEqual({
    defaults: { limit: 5, nested: { mode: "safe" } },
    schema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        nested: {
          type: "object",
          properties: { mode: { type: "string" }, tag: { type: "string" } },
        },
      },
    },
  });
  const configHash = hashJson(expected);
  expect(record?.info.definition?.configHash).toBe(configHash);
  expect(record?.info.definitionHash).toBe(record?.info.definition?.definitionHash);
  expect(Object.isFrozen(record?.wrapperConfig)).toBe(true);
  expect(Object.isFrozen(record?.wrapperConfig?.nested)).toBe(true);
  expect(Object.isFrozen(record?.wrapperConfigSpec)).toBe(true);
  expect(Object.isFrozen(record?.wrapperConfigSpec?.defaults)).toBe(true);
  expect(config).toEqual(snapshot);

  const withoutOverride = await discoverExtensions(options(), workspace, {});
  expect(withoutOverride.inventory.hash).not.toBe(result.inventory.hash);

  const again = await discoverExtensions(options(), workspace, config);
  expect(again.inventory.hash).toBe(result.inventory.hash);
  expect(again.records.get(entryName("wrapped#w"))?.info.definition?.configHash).toBe(configHash);

  config.entryConfig = { "wrapped#w": { nested: { tag: "mutated" } } };
  expect(record?.wrapperConfig).toEqual(expected);
  expect(await exists(sentinel)).toBe(false);
});

test("normalizes a wrapper without sidecar config to empty defaults and schema", async () => {
  const pkg = extensionsDir("plain-wrapper");
  await makePackage(pkg, {
    name: "plain-wrapper",
    manifest: { wrappers: ["wrappers/w.ts"] },
    files: { "wrappers/w.ts": wrapperSource(sentinel) },
  });

  const result = await discoverExtensions(options(), workspace, {});
  const record = result.records.get(entryName("plain-wrapper#w"));

  expect(record?.wrapperConfig).toEqual({});
  expect(record?.wrapperConfigSpec).toEqual({ defaults: {}, schema: {} });
  expect(record?.info.definition?.configHash).toBe(hashJson({}));
  expect(Object.isFrozen(record?.wrapperConfig)).toBe(true);
  expect(Object.isFrozen(record?.wrapperConfigSpec?.schema)).toBe(true);
});

test("records providers and clients as unsupported contributions without entries", async () => {
  const pkg = extensionsDir("contrib");
  await makePackage(pkg, {
    name: "contrib",
    manifest: {
      tools: ["tools/ok.ts"],
      providers: ["providers/p.ts"],
      clients: [{ id: "c", entry: "clients/c.ts" }],
    },
    files: {
      "tools/ok.ts": toolSource(sentinel),
      "providers/p.ts": toolSource(sentinel),
      "clients/c.ts": toolSource(sentinel),
    },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["contrib#ok"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.unsupported_contribution", source: "contrib" }),
  );
  expect(
    result.issues.filter((issue) => issue.code === "extensions.unsupported_contribution"),
  ).toHaveLength(2);
  expect(await exists(sentinel)).toBe(false);
});

test("isolates corrupt package manifests and does not leak their contents", async () => {
  await writeText(join(extensionsDir("broken"), "package.json"), '{"name": "hunter2"');
  await makePackage(extensionsDir("ok"), {
    name: "ok",
    files: { "tools/good.ts": toolSource(sentinel) },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["ok#good"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "broken" }),
  );
  expect(JSON.stringify(result.issues)).not.toContain("hunter2");
  expect(JSON.stringify(result.issues)).not.toContain(root);
  expect(await exists(sentinel)).toBe(false);
});

test("pins the documented definition hash recipe to entry bytes and metadata", async () => {
  const pkg = extensionsDir("recipe");
  const source = toolSource(sentinel);
  await makePackage(pkg, {
    name: "recipe",
    files: { "tools/x.ts": source },
  });
  await writeSidecar(pkg, "tools/x.ts", {
    name: "x",
    description: "Do thing",
    parameters: { alpha: { type: "string" }, beta: { type: "number" } },
  });

  const entryDigest = digest(source);
  const expectedDefinitionHash = digest(
    `{"description":"Do thing","entry":"${entryDigest}","kind":"tool","name":"recipe#x","parameters":{"alpha":{"type":"string"},"beta":{"type":"number"}}}`,
  );

  const result = await discoverExtensions(options(), workspace, {});
  const entry = result.records.get(entryName("recipe#x"));

  expect(entry?.entryDigest).toBe(entryDigest);
  expect(entry?.info.definition).toEqual({
    name: "recipe#x",
    kind: "tool",
    description: "Do thing",
    parameters: { alpha: { type: "string" }, beta: { type: "number" } },
    definitionHash: expectedDefinitionHash,
  });
  expect(entry?.info.definitionHash).toBe(expectedDefinitionHash);
  expect(await exists(sentinel)).toBe(false);
});

test("reports skills without SKILL.md as invalid", async () => {
  const pkg = extensionsDir("empty-skill");
  await makePackage(pkg, {
    name: "empty-skill",
    manifest: { skills: ["skills/empty"] },
    files: { "skills/empty/note.txt": "not a skill body" },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries).toEqual([]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "empty-skill" }),
  );
});

test("discovers context sources without fabricating definitions", async () => {
  const pkg = extensionsDir("ctx");
  await makePackage(pkg, {
    name: "ctx",
    manifest: { context: ["ctx/c.ts"] },
    files: { "ctx/c.ts": contextSource(sentinel) },
  });
  await writeSidecar(pkg, "ctx/c.ts", { description: "Context source" });

  const result = await discoverExtensions(options(), workspace, {});
  const entry = result.inventory.entries[0] as EntryInfo;
  const record = result.records.get(entryName("ctx#c"));

  expect(entry.type).toBe("context");
  expect(entry.description).toBe("Context source");
  expect(entry.definition).toBeUndefined();
  expect(entry.definitionHash).toBeUndefined();
  expect(record?.entryDigest).toBe(digest(contextSource(sentinel)));
  expect(await exists(sentinel)).toBe(false);
});

test("returns frozen copies callers cannot use to rewrite discovery state", async () => {
  const pkg = extensionsDir("frozen");
  await makePackage(pkg, {
    name: "frozen",
    manifest: { tools: ["tools/t.ts"], wrappers: ["wrappers/w.ts"] },
    files: {
      "tools/t.ts": toolSource(sentinel),
      "wrappers/w.ts": wrapperSource(sentinel),
    },
  });

  const first = await discoverExtensions(options(), workspace, {});
  const second = await discoverExtensions(options(), workspace, {});

  expect(Object.isFrozen(first.inventory)).toBe(true);
  expect(Object.isFrozen(first.inventory.entries)).toBe(true);
  expect(Object.isFrozen(first.issues)).toBe(true);
  expect(Object.isFrozen(first.inventory.entries[0])).toBe(true);
  expect(Object.isFrozen(first.inventory.entries[0]?.definition)).toBe(true);
  expect(Object.isFrozen(first.inventory.entries[0]?.definition?.parameters)).toBe(true);
  const record = first.records.get(entryName("frozen#t"));
  expect(Object.isFrozen(record)).toBe(true);
  expect(record?.info).not.toBe(first.inventory.entries[0]);

  const entries = first.inventory.entries as EntryInfo[];
  expect(() => entries.push(entries[0] as EntryInfo)).toThrow(TypeError);
  expect(() => {
    (
      first.records.get(entryName("frozen#t"))?.wrapperConfig as Record<string, JsonValue>
    ).injected = true;
  }).toThrow(TypeError);

  expect(second.inventory.hash).toBe(first.inventory.hash);
  expect(second.records).not.toBe(first.records);
  expect(second.records.get(entryName("frozen#t"))).not.toBe(record);
  expect(await exists(sentinel)).toBe(false);
});

test("defaultBuiltinDir is module-relative and absent by default without being created", async () => {
  const expected = resolve(fileURLToPath(new URL("../../../extensions/builtin/", import.meta.url)));
  expect(resolve(defaultBuiltinDir())).toBe(expected);
  expect(await exists(expected)).toBe(false);

  const result = await discoverExtensions({ configDir }, workspace, {});

  expect(result.inventory.entries).toEqual([]);
  expect(await exists(expected)).toBe(false);
});

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Bounded child helper: kill and reap the child if it outlives the timeout.
function runBoundedChild(args: string[], timeoutMs: number): Promise<ChildResult> {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveChild) => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout;
    let reapTimer: NodeJS.Timeout;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      resolveChild({ code, stdout, stderr, timedOut });
    };
    killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    reapTimer = setTimeout(() => done(null), timeoutMs + 5_000);
    child.once("close", (code) => done(code));
    child.once("error", () => done(null));
  });
}

const sidecarWrapper = async (packageName: string, sidecar: unknown): Promise<string> => {
  const pkg = extensionsDir(packageName);
  await makePackage(pkg, {
    name: packageName,
    manifest: { wrappers: ["wrappers/w.ts"] },
    files: { "wrappers/w.ts": wrapperSource(sentinel) },
  });
  await writeSidecar(pkg, "wrappers/w.ts", sidecar);
  return pkg;
};

test("rejects async wrapper schemas in a bounded fresh dist process", async () => {
  const pkg = extensionsDir("async-schema");
  await makePackage(pkg, {
    name: "async-schema",
    manifest: { wrappers: ["wrappers/async.ts"], tools: ["tools/ok.ts"] },
    files: {
      "wrappers/async.ts": wrapperSource(sentinel),
      "tools/ok.ts": toolSource(sentinel),
    },
  });
  await writeSidecar(pkg, "wrappers/async.ts", {
    config: {
      defaults: {},
      // Missing required property makes an invoked async validator reject.
      schema: { $async: true, type: "object", required: ["x"] },
    },
  });

  const distPath = fileURLToPath(new URL("../dist/extensions/discovery.js", import.meta.url));
  const childPath = fileURLToPath(
    new URL("./fixtures/extensions-async-child.mjs", import.meta.url),
  );
  expect(await exists(distPath)).toBe(true);
  const child = await runBoundedChild(
    [childPath, distPath, configDir, workspace, builtinDir],
    20_000,
  );
  const label = `exit=${child.code} timedOut=${child.timedOut} stderr=${child.stderr} stdout=${child.stdout}`;
  expect(child.timedOut, label).toBe(false);
  expect(child.code, label).toBe(0);
  expect(child.stderr, label).toBe("");
  const payload = JSON.parse(child.stdout) as { names: string[]; codes: string[] };
  expect(payload.names).toEqual(["async-schema#ok"]);
  expect(payload.codes).toContain("extensions.invalid");
  expect(await exists(sentinel)).toBe(false);
});

test("isolates wrappers whose merged defaults fail their schema without user config", async () => {
  const pkg = extensionsDir("bad-defaults");
  await makePackage(pkg, {
    name: "bad-defaults",
    manifest: { wrappers: ["wrappers/bad.ts"], tools: ["tools/ok.ts"] },
    files: {
      "wrappers/bad.ts": wrapperSource(sentinel),
      "tools/ok.ts": toolSource(sentinel),
    },
  });
  await writeSidecar(pkg, "wrappers/bad.ts", {
    config: {
      defaults: { limit: "not-a-number" },
      schema: { type: "object", properties: { limit: { type: "number" } } },
    },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["bad-defaults#ok"]);
  expect(result.records.has(entryName("bad-defaults#bad"))).toBe(false);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "bad-defaults" }),
  );
  expect(await exists(sentinel)).toBe(false);
});

test("accepts a valid user override that completes partial defaults", async () => {
  const pkg = await sidecarWrapper("partial-defaults", {
    config: {
      defaults: {},
      schema: {
        type: "object",
        required: ["limit"],
        properties: { limit: { type: "number" } },
      },
    },
  });

  const result = await discoverExtensions(options(), workspace, {
    entryConfig: { "partial-defaults#w": { limit: 2 } },
  });
  const record = result.records.get(entryName("partial-defaults#w"));

  expect(result.issues).toEqual([]);
  expect(record?.wrapperConfig).toEqual({ limit: 2 });
  expect(record?.info.definition?.configHash).toBe(hashJson({ limit: 2 }));
  expect(await exists(join(pkg, "wrappers/w.ts"))).toBe(true);
  expect(await exists(sentinel)).toBe(false);
});

test("keeps config.invalid for explicit entryConfig on invalid or duplicate wrappers", async () => {
  const invalid = extensionsDir("invalid-target");
  await makePackage(invalid, {
    name: "invalid-target",
    manifest: { wrappers: ["wrappers/w.ts"] },
    files: { "wrappers/w.ts": wrapperSource(sentinel) },
  });
  await writeSidecar(invalid, "wrappers/w.ts", {
    config: { defaults: {}, schema: { type: 5 } },
  });
  await rejectsConfig(() =>
    discoverExtensions(options(), workspace, {
      entryConfig: { "invalid-target#w": {} },
    }),
  );

  await makePackage(extensionsDir("dupe-wrapper"), {
    name: "dupe-wrapper",
    manifest: { wrappers: ["wrappers/w.ts"] },
    files: { "wrappers/w.ts": wrapperSource(sentinel) },
  });
  await makePackage(join(workspace, ".pisces", "extensions", "two"), {
    name: "dupe-wrapper",
    manifest: { wrappers: ["wrappers/w.ts"] },
    files: { "wrappers/w.ts": wrapperSource(sentinel) },
  });
  await rejectsConfig(() =>
    discoverExtensions(options(), workspace, {
      entryConfig: { "dupe-wrapper#w": {} },
    }),
  );
  expect(await exists(sentinel)).toBe(false);
});

test("applies literal and absolute exclusions to positive literal entries", async () => {
  const relative = extensionsDir("literal-exclusion");
  await makePackage(relative, {
    name: "literal-exclusion",
    manifest: { tools: ["tools/a.ts", "!tools/a.ts"] },
    files: { "tools/a.ts": toolSource(sentinel) },
  });
  const absoluteName = "absolute-exclusion";
  const absolute = extensionsDir(absoluteName);
  const absoluteEntry = join(absolute, "tools", "b.ts");
  await makePackage(absolute, {
    name: absoluteName,
    manifest: { tools: [absoluteEntry, `!${absoluteEntry}`] },
    files: { "tools/b.ts": toolSource(sentinel) },
  });
  const globNegative = extensionsDir("literal-glob-negative");
  await makePackage(globNegative, {
    name: "literal-glob-negative",
    manifest: { tools: ["tools/keep.ts", "!tools/*.ts"] },
    files: { "tools/keep.ts": toolSource(sentinel) },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries).toEqual([]);
  expect(result.issues).toEqual([]);
  expect(await exists(sentinel)).toBe(false);
});

test("deduplicates conventional aliases and derives the alias sidecar logically", async () => {
  const pkg = extensionsDir("alias");
  await makePackage(pkg, {
    name: "alias",
    files: { "tools/real.ts": toolSource(sentinel) },
  });
  await symlink("real.ts", join(pkg, "tools", "alias.ts"));
  await writeSidecar(pkg, "tools/alias.ts", {
    name: "aliased",
    description: "from alias sidecar",
  });
  await writeSidecar(pkg, "tools/real.ts", { name: "real-name" });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["alias#aliased"]);
  expect(result.inventory.entries[0]?.description).toBe("from alias sidecar");
  expect(result.issues).toEqual([]);
  const record = result.records.get(entryName("alias#aliased"));
  expect(record?.entryPath).toBe(join(resolve(pkg), "tools/real.ts"));
  expect(await exists(sentinel)).toBe(false);
});

test("collapses duplicate conventional aliases to one lexical representative", async () => {
  const pkg = extensionsDir("multi-alias");
  await makePackage(pkg, {
    name: "multi-alias",
    files: { "tools/real.ts": toolSource(sentinel) },
  });
  await symlink("real.ts", join(pkg, "tools", "b.ts"));
  await symlink("real.ts", join(pkg, "tools", "a.ts"));

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["multi-alias#a"]);
  expect(result.issues).toEqual([]);
  expect(await exists(sentinel)).toBe(false);
});

test("rejects conventional and explicit entries whose realpath escapes the package", async () => {
  await writeText(join(root, "outside.ts"), toolSource(sentinel));
  const conventional = extensionsDir("conventional-escape");
  await makePackage(conventional, {
    name: "conventional-escape",
    files: { "tools/in.ts": toolSource(sentinel) },
  });
  await symlink(join(root, "outside.ts"), join(conventional, "tools", "out.ts"));

  const explicit = extensionsDir("explicit-escape");
  await makePackage(explicit, {
    name: "explicit-escape",
    manifest: { tools: ["tools/escape.ts"] },
    files: { "tools/keep.ts": toolSource(sentinel) },
  });
  await symlink(join(root, "outside.ts"), join(explicit, "tools", "escape.ts"));

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["conventional-escape#in"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "conventional-escape" }),
  );
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "explicit-escape" }),
  );
  expect(JSON.stringify(result.issues)).not.toContain(root);
  expect(await exists(sentinel)).toBe(false);
});

test("uses the logical skill alias for sidecar and basename", async () => {
  const pkg = extensionsDir("skill-alias");
  await makePackage(pkg, {
    name: "skill-alias",
    files: { "skills/real/SKILL.md": "Aliased body\n" },
  });
  await symlink("real", join(pkg, "skills", "link"));
  await writeSidecar(pkg, "skills/link", { name: "linked" });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["skill-alias#linked"]);
  expect(result.records.get(entryName("skill-alias#linked"))?.skillContent).toEqual([
    { type: "text", text: "Aliased body\n" },
  ]);
  expect(result.issues).toEqual([]);
});

test("isolates unreadable conventional kind directories with ELOOP", async () => {
  const pkg = extensionsDir("kind-loop");
  await makePackage(pkg, {
    name: "kind-loop",
    files: { "wrappers/w.ts": wrapperSource(sentinel) },
  });
  await symlink("tools", join(pkg, "tools"));

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["kind-loop#w"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "kind-loop" }),
  );
  expect(JSON.stringify(result.issues)).not.toContain(root);
  expect(await exists(sentinel)).toBe(false);
});

test("isolates ELOOP scoped containers and package roots", async () => {
  await mkdir(join(configDir, "extensions"), { recursive: true });
  await symlink("@scope", join(configDir, "extensions", "@scope"));
  await symlink("looped", join(configDir, "extensions", "looped"));
  await makePackage(extensionsDir("healthy"), {
    name: "healthy",
    files: { "tools/good.ts": toolSource(sentinel) },
  });

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["healthy#good"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "@scope" }),
  );
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "looped" }),
  );
  expect(JSON.stringify(result.issues)).not.toContain(root);
  expect(await exists(sentinel)).toBe(false);
});

test("isolates ELOOP entry symlinks and keeps healthy siblings", async () => {
  const pkg = extensionsDir("entry-loop");
  await makePackage(pkg, {
    name: "entry-loop",
    files: { "tools/good.ts": toolSource(sentinel) },
  });
  await symlink("bad.ts", join(pkg, "tools", "bad.ts"));

  const result = await discoverExtensions(options(), workspace, {});

  expect(result.inventory.entries.map((entry) => entry.name)).toEqual(["entry-loop#good"]);
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: "extensions.invalid", source: "entry-loop" }),
  );
  expect(await exists(sentinel)).toBe(false);
});

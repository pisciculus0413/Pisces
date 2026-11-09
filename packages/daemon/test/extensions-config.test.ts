import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type EntryName, type JsonObject, PiscesError } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mergeConfigLayers,
  readConfigLayer,
  readGlobalConfig,
  readWorkspaceConfig,
} from "../src/extensions/config.js";
import { canonicalJson, sha256 } from "../src/extensions/hash.js";
import type { ExtensionConfig } from "../src/extensions/types.js";

const INVALID = "Invalid extension configuration";
const UNKNOWN_KEY = "Unknown extension configuration key";
const INVALID_JSON = "Value is not valid JSON";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-config-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function rejects(run: () => Promise<unknown>): Promise<PiscesError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    return error as PiscesError;
  }
  throw new Error("expected the operation to fail");
}

function rejectsSync(run: () => unknown): PiscesError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    return error as PiscesError;
  }
  throw new Error("expected the operation to fail");
}

test("canonicalJson sorts object keys recursively and keeps array order", () => {
  expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  expect(canonicalJson([{ z: 1, a: 2 }, "x", 3, true, null])).toBe(
    '[{"a":2,"z":1},"x",3,true,null]',
  );
  expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
  expect(canonicalJson({ "\u00e9": 1, a: -0.5 })).toBe('{"a":-0.5,"\u00e9":1}');
});

test("canonicalJson sorts integer-like keys by code unit, not numerically", () => {
  const value = JSON.parse('{"10":1,"2":2,"01":4,"a":3}');
  expect(canonicalJson(value)).toBe('{"01":4,"10":1,"2":2,"a":3}');
  const nested = JSON.parse('{"b":{"10":1,"2":2},"a":true}');
  expect(canonicalJson(nested)).toBe('{"a":true,"b":{"10":1,"2":2}}');
});

test("canonicalJson rejects values that are not JSON", () => {
  expect(rejectsSync(() => canonicalJson(Number.NaN)).code).toBe("config.invalid");
  expect(rejectsSync(() => canonicalJson(Number.POSITIVE_INFINITY)).code).toBe("config.invalid");
  expect(rejectsSync(() => canonicalJson(undefined as never)).code).toBe("config.invalid");
  expect(rejectsSync(() => canonicalJson({ a: undefined as never })).code).toBe("config.invalid");
  expect(rejectsSync(() => canonicalJson(new Date(0) as never)).code).toBe("config.invalid");
  expect(rejectsSync(() => canonicalJson(new Map() as never)).code).toBe("config.invalid");
  const error = rejectsSync(() => canonicalJson(Number.NaN));
  expect(error.message).toBe(INVALID_JSON);
  expect(error.message).not.toContain("NaN");
  expect(error.data).toBeUndefined();
  expect(error.cause).toBeUndefined();
});

test("sha256 hashes strings and bytes deterministically", () => {
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256(new TextEncoder().encode("abc"))).toBe(sha256("abc"));
  expect(sha256("Pisces")).toBe(sha256(new TextEncoder().encode("Pisces")));
});

test("a missing configuration file is an empty layer", async () => {
  expect(await readConfigLayer(join(root, "absent.json"), "global")).toEqual({});
  expect(await readConfigLayer(join(root, "missing", "config.json"), "workspace")).toEqual({});
  expect(await readGlobalConfig(join(root, "missing-config-dir"))).toEqual({});
});

test("unreadable configuration is invalid rather than empty", async () => {
  const path = join(root, "config.json");
  await mkdir(path);
  const error = await rejects(() => readConfigLayer(path, "global"));
  expect(error.code).toBe("config.invalid");
  expect(error.message).toBe(INVALID);
  expect(error.message).not.toContain(path);
});

test("malformed JSON is a fixed safe config.invalid error", async () => {
  const path = join(root, "config.json");
  await writeText(path, '{"defaultProvider":"leaky-secret"');
  const error = await rejects(() => readConfigLayer(path, "global"));
  expect(error.code).toBe("config.invalid");
  expect(error.message).toBe(INVALID);
  expect(error.message).not.toContain("leaky-secret");
  expect(error.message).not.toContain(path);
  expect(error.cause).toBeUndefined();
  expect(error.data).toBeUndefined();

  await writeText(path, "");
  expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");

  for (const text of ["null", "[]", '"text"', "3"]) {
    await writeText(path, text);
    expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
  }
});

test("unknown top-level keys fail with config.unknown_key and no leak", async () => {
  const path = join(root, "global", "config.json");
  await writeJson(path, { defaultProvider: "p", defaultModel: "m", providers: "leaky-secret" });
  const error = await rejects(() => readConfigLayer(path, "global"));
  expect(error.code).toBe("config.unknown_key");
  expect(error.message).toBe(UNKNOWN_KEY);
  expect(error.message).not.toContain("providers");
  expect(error.message).not.toContain("leaky-secret");
  expect(error.data).toBeUndefined();
});

test("workspace scopes forbid defaultWorkspace as an unknown key", async () => {
  const path = join(root, "workspace", ".pisces", "config.json");
  await writeJson(path, { defaultWorkspace: "/absolute/workspace" });
  const error = await rejects(() => readConfigLayer(path, "workspace"));
  expect(error.code).toBe("config.unknown_key");
  expect(error.message).toBe(UNKNOWN_KEY);
  expect(error.message).not.toContain("defaultWorkspace");
});

test("global defaultWorkspace must be a non-empty absolute path", async () => {
  const path = join(root, "global", "config.json");
  for (const value of ["relative/path", "", ".", "../up"]) {
    await writeJson(path, { defaultWorkspace: value });
    expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
  }
  await writeJson(path, { defaultWorkspace: "/absolute/workspace" });
  expect(await readConfigLayer(path, "global")).toEqual({
    defaultWorkspace: "/absolute/workspace",
  });
  await writeJson(path, { defaultWorkspace: 3 });
  expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
});

test("defaultProvider and defaultModel must be paired within a layer", async () => {
  const path = join(root, "global", "config.json");
  await writeJson(path, { defaultProvider: "p" });
  expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
  await writeJson(path, { defaultModel: "m" });
  expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
  await writeJson(path, { defaultProvider: "", defaultModel: "m" });
  expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
  await writeJson(path, { defaultProvider: "p", defaultModel: "m" });
  expect(await readConfigLayer(path, "global")).toEqual({
    defaultProvider: "p",
    defaultModel: "m",
  });
});

test("extensions must be an array of entry names and may be empty", async () => {
  const path = join(root, "global", "config.json");
  await writeJson(path, { extensions: ["pkg#a", "other#b"] });
  expect(await readConfigLayer(path, "global")).toEqual({
    extensions: ["pkg#a", "other#b"],
  });
  await writeJson(path, { extensions: [] });
  expect(await readConfigLayer(path, "global")).toEqual({ extensions: [] });
  for (const value of ["pkg#a", ["pkg"], ["a#b#c"], ["a#b c"], [1], null, {}]) {
    await writeJson(path, { extensions: value });
    expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
  }
});

test("entryConfig values must be entry-shaped JSON objects", async () => {
  const path = join(root, "global", "config.json");
  const valid = {
    entryConfig: {
      "pkg#wrapper": { option: true, nested: { list: [1, "two", null] } },
    },
  };
  await writeJson(path, valid);
  expect(await readConfigLayer(path, "global")).toEqual(valid);
  for (const value of [[], "x", { "pkg#wrapper": [] }, { "pkg#wrapper": null }]) {
    await writeJson(path, { entryConfig: value });
    expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
  }
  await writeJson(path, { entryConfig: { "not an entry": {} } });
  expect((await rejects(() => readConfigLayer(path, "global"))).code).toBe("config.invalid");
});

test("own __proto__ keys stay data without polluting or vanishing", async () => {
  const path = join(root, "global", "config.json");
  await writeText(path, '{"entryConfig":{"pkg#wrapper":{"__proto__":{"polluted":true},"keep":1}}}');
  const layer = await readConfigLayer(path, "global");
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  const nested = layer.entryConfig?.["pkg#wrapper"];
  expect(nested).toBeDefined();
  expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(nested as object, "__proto__");
  expect(descriptor?.value).toEqual({ polluted: true });
  expect(Object.keys(nested as object).sort()).toEqual(["__proto__", "keep"]);
  expect(canonicalJson(nested as JsonObject)).toBe('{"__proto__":{"polluted":true},"keep":1}');

  const merged = mergeConfigLayers([layer, { entryConfig: { "pkg#wrapper": { extra: 2 } } }]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  const mergedEntry = merged.entryConfig?.["pkg#wrapper"];
  expect(Object.getOwnPropertyDescriptor(mergedEntry as object, "__proto__")?.value).toEqual({
    polluted: true,
  });
  expect(mergedEntry?.keep).toBe(1);
  expect(mergedEntry?.extra).toBe(2);
});

test("mergeConfigLayers replaces arrays and merges objects recursively", () => {
  const globalLayer: ExtensionConfig = {
    defaultProvider: "p",
    defaultModel: "m",
    extensions: ["pkg#a" as EntryName],
    entryConfig: {
      "pkg#wrapper": { keep: 1, nested: { x: 1, y: 2 }, list: [1, 2] },
    },
  };
  const workspaceLayer: ExtensionConfig = {
    extensions: [],
    entryConfig: {
      "pkg#wrapper": { nested: { y: 4, z: 5 }, list: [9] },
      "pkg#other": { flag: true },
    },
  };

  const merged = mergeConfigLayers([globalLayer, workspaceLayer]);
  expect(merged).toEqual({
    defaultProvider: "p",
    defaultModel: "m",
    extensions: [],
    entryConfig: {
      "pkg#wrapper": { keep: 1, nested: { x: 1, y: 4, z: 5 }, list: [9] },
      "pkg#other": { flag: true },
    },
  });
  expect(
    mergeConfigLayers([{ extensions: ["p#a" as EntryName] }, { extensions: [] }]).extensions,
  ).toEqual([]);
  expect(mergeConfigLayers([{}, {}])).toEqual({});
  expect(mergeConfigLayers([{ extensions: [] }]).extensions).toEqual([]);
});

test("mergeConfigLayers deep-copies without mutating its inputs", () => {
  const globalEntry = { nested: { x: 1 }, list: [1, 2] };
  const globalLayer: ExtensionConfig = {
    extensions: ["pkg#a" as EntryName],
    entryConfig: { "pkg#wrapper": globalEntry },
  };
  const workspaceLayer: ExtensionConfig = {
    entryConfig: { "pkg#wrapper": { nested: { y: 2 } } },
  };
  const merged = mergeConfigLayers([globalLayer, workspaceLayer]);

  (merged.extensions as EntryName[]).push("pkg#b" as EntryName);
  const mergedEntry = merged.entryConfig?.["pkg#wrapper"] as JsonObject | undefined;
  expect(mergedEntry).toBeDefined();
  const entry = mergedEntry as JsonObject;
  (entry.nested as { x: number }).x = 99;
  (entry.list as number[]).push(3);

  expect(globalLayer.extensions).toEqual(["pkg#a"]);
  expect(globalEntry).toEqual({ nested: { x: 1 }, list: [1, 2] });
  expect(workspaceLayer.entryConfig).toEqual({ "pkg#wrapper": { nested: { y: 2 } } });
});

test("readGlobalConfig reads <configDir>/config.json", async () => {
  const configDir = join(root, "config");
  await writeJson(join(configDir, "config.json"), {
    defaultWorkspace: "/workspace/one",
    defaultProvider: "provider",
    defaultModel: "model",
    extensions: ["pkg#a"],
    entryConfig: { "pkg#wrapper": { option: true } },
  });
  expect(await readGlobalConfig(configDir)).toEqual({
    defaultWorkspace: "/workspace/one",
    defaultProvider: "provider",
    defaultModel: "model",
    extensions: ["pkg#a"],
    entryConfig: { "pkg#wrapper": { option: true } },
  });
});

test("readWorkspaceConfig merges global then <workspace>/.pisces/config.json", async () => {
  const configDir = join(root, "config");
  const workspace = join(root, "workspace");
  await writeJson(join(configDir, "config.json"), {
    defaultWorkspace: "/workspace/one",
    defaultProvider: "provider",
    defaultModel: "model",
    extensions: ["pkg#a"],
    entryConfig: { "pkg#wrapper": { keep: 1, nested: { x: 1, y: 2 } } },
  });
  await writeJson(join(workspace, ".pisces", "config.json"), {
    defaultProvider: "provider2",
    defaultModel: "model2",
    entryConfig: { "pkg#wrapper": { nested: { y: 4 } } },
  });
  expect(await readWorkspaceConfig(configDir, workspace)).toEqual({
    defaultWorkspace: "/workspace/one",
    defaultProvider: "provider2",
    defaultModel: "model2",
    extensions: ["pkg#a"],
    entryConfig: { "pkg#wrapper": { keep: 1, nested: { x: 1, y: 4 } } },
  });
});

test("readWorkspaceConfig tolerates a missing workspace layer", async () => {
  const configDir = join(root, "config");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeJson(join(configDir, "config.json"), { defaultProvider: "p", defaultModel: "m" });
  expect(await readWorkspaceConfig(configDir, workspace)).toEqual({
    defaultProvider: "p",
    defaultModel: "m",
  });
  expect(await readWorkspaceConfig(join(root, "absent-config"), workspace)).toEqual({});
});

test("readWorkspaceConfig rejects workspace defaultWorkspace and pairing violations", async () => {
  const configDir = join(root, "config");
  const workspace = join(root, "workspace");
  await writeJson(join(configDir, "config.json"), { defaultWorkspace: "/abs" });
  await writeJson(join(workspace, ".pisces", "config.json"), { defaultWorkspace: "/other" });
  const unknown = await rejects(() => readWorkspaceConfig(configDir, workspace));
  expect(unknown.code).toBe("config.unknown_key");
  expect(unknown.message).toBe(UNKNOWN_KEY);

  await writeJson(join(workspace, ".pisces", "config.json"), { defaultProvider: "p" });
  expect((await rejects(() => readWorkspaceConfig(configDir, workspace))).code).toBe(
    "config.invalid",
  );
});

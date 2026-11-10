import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiscesError } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import {
  type CliProviderConfig,
  validateGlobalDraft,
  validateWorkspaceDraft,
} from "../src/config.js";
import { readConfigDraft, writeConfigFile } from "../src/config-edit.js";
import { getValue, parseConfigPath, setValue, unsetValue } from "../src/config-path.js";

const INVALID = "Invalid configuration";
const UNKNOWN_KEY = "Unknown configuration key";
const STORAGE_IO = "Configuration file could not be written";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pisces-config-path-"));
  roots.push(dir);
  return dir;
}

function expectCode(run: () => unknown, code: string, message: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect((error as PiscesError).code).toBe(code);
    expect((error as PiscesError).message).toBe(message);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function expectCodeAsync(
  run: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect((error as PiscesError).code).toBe(code);
    expect((error as PiscesError).message).toBe(message);
    return;
  }
  throw new Error(`expected ${code}`);
}

const provider = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  models: [
    { id: "m1", contextWindow: 128_000, maxOutput: 16_384, modalities: ["text"] },
    { id: "m2", contextWindow: 8_000, maxOutput: 1_000, modalities: ["text"] },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Path grammar
// ---------------------------------------------------------------------------

test("parses dotted object segments, numeric indices and JSON-quoted keys", () => {
  expect(parseConfigPath("providers.0.models.1.maxOutput")).toEqual([
    "providers",
    0,
    "models",
    1,
    "maxOutput",
  ]);
  expect(parseConfigPath('entryConfig."@scope/pkg#tool".timeout')).toEqual([
    "entryConfig",
    "@scope/pkg#tool",
    "timeout",
  ]);
  expect(parseConfigPath('entryConfig."a.b"')).toEqual(["entryConfig", "a.b"]);
  expect(parseConfigPath('a."with\\"quote"')).toEqual(["a", 'with"quote']);
  // A quoted numeric segment is a key, never an array index.
  expect(parseConfigPath('a."0"')).toEqual(["a", "0"]);
  expect(parseConfigPath("list.-")).toEqual(["list", "-"]);
});

test("rejects empty segments, prototype keys and malformed quotes", () => {
  for (const input of ["", ".", "a.", ".a", "a..b"]) {
    expectCode(() => parseConfigPath(input), "config.invalid", INVALID);
  }
  for (const input of [
    "__proto__",
    "a.__proto__",
    "constructor",
    "a.prototype.b",
    'a."__proto__"',
    'a."constructor"',
  ]) {
    expectCode(() => parseConfigPath(input), "config.invalid", INVALID);
  }
  for (const input of ['a."unterminated', 'a.b"c', 'a.""', 'a."b"c']) {
    expectCode(() => parseConfigPath(input), "config.invalid", INVALID);
  }
});

// ---------------------------------------------------------------------------
// getValue
// ---------------------------------------------------------------------------

const sample = (): Record<string, unknown> => ({
  providers: [{ id: "openai", models: [{ maxOutput: 1 }, { maxOutput: 2 }] }],
  entryConfig: { "@scope/pkg#tool": { timeout: 5, "a.b": "dotted" } },
});

test("reads nested values by path", () => {
  const root = sample();
  expect(getValue(root, ["providers", 0, "models", 1, "maxOutput"])).toBe(2);
  expect(getValue(root, ["entryConfig", "@scope/pkg#tool", "timeout"])).toBe(5);
  expect(getValue(root, ["entryConfig", "@scope/pkg#tool", "a.b"])).toBe("dotted");
  expect(getValue(root, [])).toBe(root);
});

test("missing paths and inherited properties read as undefined", () => {
  const root = sample();
  expect(getValue(root, ["missing"])).toBeUndefined();
  expect(getValue(root, ["providers", 5])).toBeUndefined();
  expect(getValue(root, ["providers", "0"])).toBeUndefined();
  expect(getValue(root, ["providers", 0, "id", "deeper"])).toBeUndefined();
  expect(getValue(root, ["toString"])).toBeUndefined();
  expect(getValue(root, ["__proto__"])).toBeUndefined();
});

// ---------------------------------------------------------------------------
// setValue
// ---------------------------------------------------------------------------

test("set creates missing object parents without mutating the original", () => {
  const root: Record<string, unknown> = {};
  const result = setValue(root, ["a", "b", "c"], 1) as Record<string, unknown>;
  expect(result).toEqual({ a: { b: { c: 1 } } });
  expect(root).toEqual({});

  const nested: Record<string, unknown> = { a: { b: 1 } };
  const next = setValue(nested, ["a", "c"], 2) as Record<string, unknown>;
  expect(next).toEqual({ a: { b: 1, c: 2 } });
  expect(nested).toEqual({ a: { b: 1 } });
});

test("set replaces array elements and appends with -", () => {
  const root = sample();
  const replaced = setValue(root, ["providers", 0, "models", 0, "maxOutput"], 9);
  expect(getValue(replaced, ["providers", 0, "models", 0, "maxOutput"])).toBe(9);
  expect(getValue(root, ["providers", 0, "models", 0, "maxOutput"])).toBe(1);

  const appended = setValue({ list: [1] }, ["list", "-"], 2) as Record<string, unknown>;
  expect(appended).toEqual({ list: [1, 2] });
});

test("set rejects out-of-range arrays, string keys on arrays and primitive parents", () => {
  expectCode(() => setValue({ list: [1] }, ["list", 2], 3), "config.invalid", INVALID);
  expectCode(() => setValue({ list: [1] }, ["list", "x"], 3), "config.invalid", INVALID);
  expectCode(() => setValue({ list: [1] }, ["list", -1], 3), "config.invalid", INVALID);
  expectCode(() => setValue({ a: 1 }, ["a", "b"], 2), "config.invalid", INVALID);
});

// ---------------------------------------------------------------------------
// unsetValue
// ---------------------------------------------------------------------------

test("unset removes object keys and array elements", () => {
  const root = sample();
  const withoutTimeout = unsetValue(root, ["entryConfig", "@scope/pkg#tool", "timeout"]);
  expect(withoutTimeout).toEqual({
    providers: [{ id: "openai", models: [{ maxOutput: 1 }, { maxOutput: 2 }] }],
    entryConfig: { "@scope/pkg#tool": { "a.b": "dotted" } },
  });
  expect(getValue(root, ["entryConfig", "@scope/pkg#tool", "timeout"])).toBe(5);

  const withoutIndex = unsetValue(root, ["providers", 0, "models", 0]);
  expect(getValue(withoutIndex, ["providers", 0, "models"])).toEqual([{ maxOutput: 2 }]);
});

test("unset of a missing path returns undefined", () => {
  const root = sample();
  expect(unsetValue(root, ["missing"])).toBeUndefined();
  expect(unsetValue(root, ["providers", 7])).toBeUndefined();
  expect(unsetValue(root, ["providers", "0"])).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

test("global drafts accept an empty file and both config groups", () => {
  expect(() => validateGlobalDraft({})).not.toThrow();
  expect(() =>
    validateGlobalDraft({
      dataDir: "/tmp/pisces",
      providers: [provider()],
      defaults: { provider: "openai", model: "m1" },
      templatesDir: "/tmp/templates",
      defaultWorkspace: "/tmp/notes",
      extensions: ["@pisces/builtin-shell#shell"],
      entryConfig: { "@scope/pkg#wrapper": { timeoutMs: 5000 } },
    }),
  ).not.toThrow();
});

test("global drafts allow missing dataDir and providers", () => {
  expect(() => validateGlobalDraft({ defaults: { provider: "p", model: "m" } })).not.toThrow();
  expect(() => validateGlobalDraft({ extensions: [] })).not.toThrow();
});

test("global drafts reject duplicate provider and model ids", () => {
  expectCode(
    () => validateGlobalDraft({ providers: [provider(), provider()] }),
    "config.invalid",
    INVALID,
  );
  expectCode(
    () =>
      validateGlobalDraft({
        providers: [
          provider({
            models: [
              { id: "m", contextWindow: 1, maxOutput: 1, modalities: ["text"] },
              { id: "m", contextWindow: 1, maxOutput: 1, modalities: ["text"] },
            ],
          }),
        ],
      }),
    "config.invalid",
    INVALID,
  );
});

test("global drafts reject dangling defaults when providers are present", () => {
  expectCode(
    () =>
      validateGlobalDraft({
        providers: [provider()],
        defaults: { provider: "missing", model: "m1" },
      }),
    "config.invalid",
    INVALID,
  );
  expectCode(
    () =>
      validateGlobalDraft({
        providers: [provider()],
        defaults: { provider: "openai", model: "missing" },
      }),
    "config.invalid",
    INVALID,
  );
  expectCode(() => validateGlobalDraft({ defaults: { provider: "p" } }), "config.invalid", INVALID);
});

test("global drafts reject unknown keys, bad shapes and bad extension values", () => {
  expectCode(() => validateGlobalDraft({ extra: true }), "config.unknown_key", UNKNOWN_KEY);
  expectCode(() => validateGlobalDraft({ dataDir: "relative/path" }), "config.invalid", INVALID);
  expectCode(
    () => validateGlobalDraft({ defaultWorkspace: "relative/path" }),
    "config.invalid",
    INVALID,
  );
  expectCode(
    () => validateGlobalDraft({ extensions: ["no-entry-name"] }),
    "config.invalid",
    INVALID,
  );
  expectCode(
    () => validateGlobalDraft({ entryConfig: { "@scope/pkg#tool": "nope" } }),
    "config.invalid",
    INVALID,
  );
  expectCode(() => validateGlobalDraft([]), "config.invalid", INVALID);
});

test("workspace drafts accept only defaults, extensions and entryConfig", () => {
  expect(() => validateWorkspaceDraft({})).not.toThrow();
  expect(() =>
    validateWorkspaceDraft({
      defaults: { provider: "openai", model: "m1" },
      extensions: ["@pisces/builtin-shell#shell"],
      entryConfig: { "@scope/pkg#tool": { timeoutMs: 1000 } },
    }),
  ).not.toThrow();

  for (const key of ["defaultWorkspace", "dataDir", "providers", "templatesDir"]) {
    expectCode(
      () => validateWorkspaceDraft({ [key]: "/tmp/x" }),
      "config.unknown_key",
      UNKNOWN_KEY,
    );
  }
});

test("workspace defaults are cross-checked against readable global providers", () => {
  const providers: CliProviderConfig[] = [
    {
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [{ id: "m1", contextWindow: 128_000, maxOutput: 16_384, modalities: ["text"] }],
    },
  ];
  expect(() =>
    validateWorkspaceDraft({ defaults: { provider: "openai", model: "m1" } }, providers),
  ).not.toThrow();
  expectCode(
    () => validateWorkspaceDraft({ defaults: { provider: "openai", model: "m2" } }, providers),
    "config.invalid",
    INVALID,
  );
  expectCode(
    () => validateWorkspaceDraft({ defaults: { provider: "other", model: "m1" } }, providers),
    "config.invalid",
    INVALID,
  );
  // No readable global providers means format-only validation.
  expect(() =>
    validateWorkspaceDraft({ defaults: { provider: "other", model: "m2" } }),
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// Reading and atomic writing
// ---------------------------------------------------------------------------

test("readConfigDraft treats a missing file as an empty object", async () => {
  const dir = await tempDir();
  expect(await readConfigDraft(join(dir, "missing.json"))).toEqual({});
});

test("readConfigDraft rejects malformed JSON with config.invalid", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  await writeFile(path, "{ not json");
  await expectCodeAsync(() => readConfigDraft(path), "config.invalid", INVALID);
});

test("writeConfigFile writes indented JSON with 0600 and creates 0700 parents", async () => {
  const dir = await tempDir();
  const path = join(dir, "deep", "nested", "config.json");
  await writeConfigFile(path, { b: 1, a: { z: 2 } });
  expect(await readFile(path, "utf8")).toBe('{\n  "b": 1,\n  "a": {\n    "z": 2\n  }\n}\n');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "deep"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, "deep", "nested"))).mode & 0o777).toBe(0o700);
  expect(await readdir(join(dir, "deep", "nested"))).toEqual(["config.json"]);
});

test("writeConfigFile refuses a symlinked target and leaves it untouched", async () => {
  const dir = await tempDir();
  const original = join(dir, "original.json");
  await writeFile(original, '{"keep":true}\n');
  const path = join(dir, "config.json");
  await symlink(original, path);
  await expectCodeAsync(() => writeConfigFile(path, { replace: true }), "storage.io", STORAGE_IO);
  expect(await readFile(original, "utf8")).toBe('{"keep":true}\n');
});

test("writeConfigFile cleans up the temporary file when the rename fails", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  // A directory at the target path makes the final rename fail after the temp file exists.
  await mkdir(path);
  await expectCodeAsync(() => writeConfigFile(path, { a: 1 }), "storage.io", STORAGE_IO);
  expect(await readdir(dir)).toEqual(["config.json"]);
});

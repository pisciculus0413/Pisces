import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EntryName, PiscesError } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveConfigLocation } from "../src/extensions/config.js";
import { createExtensions } from "../src/extensions/extensions.js";
import { makePackage, wrapperSource, writeJson, writeText } from "./extensions-fixtures.js";

const INVALID = "Invalid extension configuration";
const WRAP = "demo#wrap" as EntryName;
const RUN = "demo#run" as EntryName;

let root = "";
let workspace = "";
let builtinDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-config-path-"));
  workspace = join(root, "workspace");
  builtinDir = join(root, "builtin");
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function addWrapper(extensionsRoot: string, name = "demo", entry = "wrap"): Promise<void> {
  await makePackage(join(extensionsRoot, name), {
    name,
    files: { [`wrappers/${entry}.ts`]: wrapperSource(join(root, "sentinel.txt")) },
  });
}

async function addTool(extensionsRoot: string, name = "demo", entry = "run"): Promise<void> {
  await makePackage(join(extensionsRoot, name), {
    name,
    files: {
      [`tools/${entry}.ts`]: [
        "export default async function run() {",
        '  return { content: [{ type: "text", text: "ran" }] };',
        "}",
        "",
      ].join("\n"),
    },
  });
}

test("resolveConfigLocation derives the config file and extension root", () => {
  expect(resolveConfigLocation({ configDir: "/cfg" })).toEqual({
    configDir: "/cfg",
    configPath: join("/cfg", "config.json"),
  });
  expect(resolveConfigLocation({ configPath: "/alt/alt.json" })).toEqual({
    configDir: "/alt",
    configPath: "/alt/alt.json",
  });
  expect(resolveConfigLocation({ configDir: "/cfg", configPath: "/alt/alt.json" })).toEqual({
    configDir: "/cfg",
    configPath: "/alt/alt.json",
  });
});

test("resolveConfigLocation rejects a location without a config directory or path", () => {
  expect(() => resolveConfigLocation({})).toThrow(PiscesError);
  try {
    resolveConfigLocation({});
  } catch (error) {
    expect((error as PiscesError).code).toBe("config.invalid");
    expect((error as Error).message).toBe(INVALID);
    return;
  }
  throw new Error("expected a safe config.invalid");
});

test("prepare with only configPath reads that file and scans the sibling extensions directory", async () => {
  const configDir = join(root, "config");
  const configPath = join(configDir, "alt.json");
  await addWrapper(join(configDir, "extensions"));
  await writeJson(configPath, {
    defaultWorkspace: "/workspace/alt",
    defaults: { provider: "alt", model: "alt-model" },
    extensions: [WRAP],
    entryConfig: { "demo#wrap": { option: true } },
  });
  // Unreadable sentinel: reading `<configDir>/config.json` would fail the whole prepare.
  await writeText(join(configDir, "config.json"), "{ not json");

  const extensions = createExtensions({ configPath, builtinDir });
  const binding = await extensions.prepare(workspace);

  expect(binding.config).toEqual({
    defaultWorkspace: "/workspace/alt",
    defaults: { provider: "alt", model: "alt-model" },
    extensions: [WRAP],
    entryConfig: { "demo#wrap": { option: true } },
  });
  expect(binding.inventory.entries.map((entry) => entry.name)).toEqual([WRAP]);
  expect(await extensions.readGlobalConfig()).toEqual({
    defaultWorkspace: "/workspace/alt",
    defaults: { provider: "alt", model: "alt-model" },
    extensions: [WRAP],
    entryConfig: { "demo#wrap": { option: true } },
  });
});

test("configPath is not read at construction: an edit is observed by prepare", async () => {
  const configDir = join(root, "config");
  const configPath = join(configDir, "alt.json");
  await writeJson(configPath, { defaults: { provider: "old", model: "old-model" } });

  const extensions = createExtensions({ configPath, builtinDir });
  await writeJson(configPath, { defaults: { provider: "new", model: "new-model" } });

  const binding = await extensions.prepare(workspace);
  expect(binding.config.defaults).toEqual({ provider: "new", model: "new-model" });
  expect(await extensions.readGlobalConfig()).toEqual({
    defaults: { provider: "new", model: "new-model" },
  });
});

test("configDir only still reads config.json and scans configDir/extensions", async () => {
  const configDir = join(root, "config");
  await writeJson(join(configDir, "config.json"), {
    defaults: { provider: "dir", model: "dir-model" },
  });
  await addTool(join(configDir, "extensions"));

  const extensions = createExtensions({ configDir, builtinDir });
  const binding = await extensions.prepare(workspace);

  expect(binding.config).toEqual({ defaults: { provider: "dir", model: "dir-model" } });
  expect(binding.inventory.entries.map((entry) => entry.name)).toEqual([RUN]);
  expect(await extensions.readGlobalConfig()).toEqual({
    defaults: { provider: "dir", model: "dir-model" },
  });
});

test("configPath wins for the file while configDir still selects the extension root", async () => {
  const configDir = join(root, "config");
  const configPath = join(root, "alt", "alt.json");
  await addTool(join(configDir, "extensions"));
  await addWrapper(join(root, "alt", "extensions"), "shadow");
  await writeJson(join(configDir, "config.json"), {
    defaults: { provider: "dir", model: "dir-model" },
  });
  await writeJson(configPath, { defaults: { provider: "path", model: "path-model" } });

  const binding = await createExtensions({ configDir, configPath, builtinDir }).prepare(workspace);

  expect(binding.config.defaults).toEqual({ provider: "path", model: "path-model" });
  expect(binding.inventory.entries.map((entry) => entry.name)).toEqual([RUN]);
});

test("neither configDir nor configPath fails construction with a safe config.invalid", () => {
  let caught: unknown;
  try {
    createExtensions({ builtinDir });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PiscesError);
  const error = caught as PiscesError;
  expect(error.code).toBe("config.invalid");
  expect(error.message).toBe(INVALID);
  expect(error.message).not.toContain(root);
  expect(error.cause).toBeUndefined();
  expect(error.data).toBeUndefined();
});

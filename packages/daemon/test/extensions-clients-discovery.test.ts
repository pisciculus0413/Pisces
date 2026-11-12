import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { discoverClients } from "../src/extensions/discovery.js";
import { makePackage, writeText } from "./extensions-fixtures.js";

let root = "";
let configDir = "";
let builtinDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-clients-discovery-"));
  configDir = join(root, "config");
  builtinDir = join(root, "builtin");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const clientPackage = (
  id: string,
  entry: string,
): { manifest: unknown; files: Record<string, string> } => ({
  manifest: { clients: [{ id, entry }] },
  files: { "client.mjs": "process.exit(0);\n" },
});

test("reads clients from the builtin and config sources", async () => {
  await makePackage(join(builtinDir, "built"), {
    name: "@builtin/shell",
    ...clientPackage("built-repl", "./client.mjs"),
  });
  await makePackage(join(configDir, "extensions", "demo"), {
    name: "@demo/x",
    ...clientPackage("repl", "./client.mjs"),
  });

  const result = await discoverClients({ configDir, builtinDir });

  const entry = await realpath(join(configDir, "extensions", "demo", "client.mjs"));
  expect(result).toEqual([
    {
      id: "built-repl",
      source: "@builtin/shell",
      entry: await realpath(join(builtinDir, "built", "client.mjs")),
    },
    { id: "repl", source: "@demo/x", entry },
  ]);
});

test("skips a client whose entry is missing", async () => {
  await makePackage(join(configDir, "extensions", "demo"), {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: "./absent.mjs" }] },
  });

  expect(await discoverClients({ configDir, builtinDir })).toEqual([]);
});

test("rejects an entry outside the package root", async () => {
  await writeText(join(configDir, "extensions", "evil.mjs"), "process.exit(0);\n");
  await makePackage(join(configDir, "extensions", "demo"), {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: "../evil.mjs" }] },
  });

  expect(await discoverClients({ configDir, builtinDir })).toEqual([]);
});

test("rejects an entry that is not a script", async () => {
  await makePackage(join(configDir, "extensions", "demo"), {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: "./data.json" }] },
    files: { "data.json": "{}\n" },
  });

  expect(await discoverClients({ configDir, builtinDir })).toEqual([]);
});

test("drops every package that reuses a client id", async () => {
  await makePackage(join(configDir, "extensions", "first"), {
    name: "@demo/first",
    ...clientPackage("repl", "./client.mjs"),
  });
  await makePackage(join(configDir, "extensions", "second"), {
    name: "@demo/second",
    ...clientPackage("repl", "./client.mjs"),
  });

  expect(await discoverClients({ configDir, builtinDir })).toEqual([]);
});

test("accepts an absolute entry inside the package root", async () => {
  const packageRoot = join(configDir, "extensions", "demo");
  await makePackage(packageRoot, {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: join(packageRoot, "client.mjs") }] },
    files: { "client.mjs": "process.exit(0);\n" },
  });

  expect(await discoverClients({ configDir, builtinDir })).toEqual([
    { id: "repl", source: "@demo/x", entry: await realpath(join(packageRoot, "client.mjs")) },
  ]);
});

test("rejects a symlinked entry that resolves outside the package root", async () => {
  const outside = join(configDir, "extensions", "outside.mjs");
  await writeText(outside, "process.exit(0);\n");
  const packageRoot = join(configDir, "extensions", "demo");
  await makePackage(packageRoot, {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: "./client.mjs" }] },
  });
  await symlink(outside, join(packageRoot, "client.mjs"));

  expect(await discoverClients({ configDir, builtinDir })).toEqual([]);
});

test("ignores missing extension directories", async () => {
  expect(await discoverClients({ configDir, builtinDir })).toEqual([]);
});

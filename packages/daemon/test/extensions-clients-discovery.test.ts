import { mkdtemp, realpath, rm } from "node:fs/promises";
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
  expect(result).toEqual({
    clients: [
      {
        id: "built-repl",
        source: "@builtin/shell",
        entry: await realpath(join(builtinDir, "built", "client.mjs")),
      },
      { id: "repl", source: "@demo/x", entry },
    ],
    issues: [],
  });
});

test("skips a client whose entry is missing", async () => {
  await makePackage(join(configDir, "extensions", "demo"), {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: "./absent.mjs" }] },
  });

  const result = await discoverClients({ configDir, builtinDir });

  expect(result.clients).toEqual([]);
  expect(result.issues).toEqual([{ code: "extensions.invalid", source: "@demo/x" }]);
});

test("rejects an entry outside the package root", async () => {
  await writeText(join(configDir, "extensions", "evil.mjs"), "process.exit(0);\n");
  await makePackage(join(configDir, "extensions", "demo"), {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: "../evil.mjs" }] },
  });

  const result = await discoverClients({ configDir, builtinDir });

  expect(result.clients).toEqual([]);
  expect(result.issues).toEqual([{ code: "extensions.invalid", source: "@demo/x" }]);
});

test("rejects an entry that is not a script", async () => {
  await makePackage(join(configDir, "extensions", "demo"), {
    name: "@demo/x",
    manifest: { clients: [{ id: "repl", entry: "./data.json" }] },
    files: { "data.json": "{}\n" },
  });

  const result = await discoverClients({ configDir, builtinDir });

  expect(result.clients).toEqual([]);
  expect(result.issues).toEqual([{ code: "extensions.invalid", source: "@demo/x" }]);
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

  const result = await discoverClients({ configDir, builtinDir });

  expect(result.clients).toEqual([]);
  expect(result.issues).toEqual([
    { code: "extensions.duplicate", source: "@demo/first", name: "repl" },
    { code: "extensions.duplicate", source: "@demo/second", name: "repl" },
  ]);
});

test("ignores missing extension directories", async () => {
  const result = await discoverClients({ configDir, builtinDir });

  expect(result).toEqual({ clients: [], issues: [] });
});

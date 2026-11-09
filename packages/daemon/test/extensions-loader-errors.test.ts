import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryName } from "@pisces/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createExtensionLoader, ExtensionLoadError } from "../src/extensions/loader.js";
import type { DiscoveredEntry } from "../src/extensions/types.js";
import { writeText } from "./extensions-fixtures.js";

// Test-only fault injection: never stored in production and never mutates host packages.
const SECRET = "host-secret-do-not-leak";
vi.mock("@pisces/daemon", () => {
  throw new Error(SECRET);
});

let root = "";
let packageRoot = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-loader-errors-"));
  packageRoot = join(root, "pkg");
  await mkdir(packageRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("normalizes host preparation failures without leaking raw errors", async () => {
  const entryPath = join(packageRoot, "tool.ts");
  await writeText(entryPath, "export default function run() { return 1; }\n");
  const entryDigest = createHash("sha256")
    .update(await readFile(entryPath))
    .digest("hex");
  const entry: DiscoveredEntry = {
    info: { type: "tool", source: "pkg", name: "pkg#tool" as EntryName },
    packageRoot,
    entryPath,
    entryDigest,
  };

  let loaded: unknown;
  try {
    await createExtensionLoader().load(entry);
  } catch (error) {
    loaded = error;
  }
  expect(loaded).toBeInstanceOf(ExtensionLoadError);
  expect((loaded as Error).message).not.toContain(SECRET);
  expect((loaded as Error).cause).toBeUndefined();
});

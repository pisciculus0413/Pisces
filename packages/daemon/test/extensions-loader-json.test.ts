import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createExtensionLoader } from "../src/extensions/loader.js";
import type { DiscoveredEntry } from "../src/extensions/types.js";
import { writeJson, writeText } from "./extensions-fixtures.js";

let root = "";
let packageRoot = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-json-"));
  packageRoot = join(root, "pkg");
  await mkdir(packageRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function entryFor(relative = "entry.ts"): Promise<DiscoveredEntry> {
  const entryPath = join(packageRoot, relative);
  return {
    info: { type: "tool", source: "pkg", name: "pkg#tool" as DiscoveredEntry["info"]["name"] },
    packageRoot,
    entryPath,
    entryDigest: createHash("sha256")
      .update(await readFile(entryPath))
      .digest("hex"),
  };
}

async function writeEntry(): Promise<void> {
  await writeText(
    join(packageRoot, "entry.ts"),
    [
      'import esm from "./value.json";',
      'const cjs = require("./value.json");',
      "export default function run() {",
      '  return { esm, cjs, again: require("./value.json") };',
      "}",
      "",
    ].join("\n"),
  );
}

const JSON_VALUES: unknown[] = [{ x: 1 }, [1, 2], "x", 0, 2, false, true, null, { default: 7 }];

test.each(JSON_VALUES.map((value) => [JSON.stringify(value), value]))(
  "keeps raw JSON values through loader: %s",
  async (_label, value) => {
    await writeJson(join(packageRoot, "value.json"), value);
    await writeEntry();
    const module = await createExtensionLoader().load(await entryFor());
    const result = (module.default as () => { esm: unknown; cjs: unknown; again: unknown })();
    expect(result.cjs).toEqual(value);
    expect(result.esm).toBe(result.cjs);
    expect(result.again).toBe(result.cjs);
    if (typeof value === "object" && value !== null) {
      expect(Reflect.ownKeys(result.cjs as object)).toEqual(Reflect.ownKeys(value));
    }
  },
);

test("reports invalid JSON and keeps failure and graph boundaries", async () => {
  await writeText(join(packageRoot, "value.json"), "{ invalid");
  await writeEntry();
  await writeText(join(packageRoot, "other.ts"), 'export default () => "other-ok";\n');

  const loader = createExtensionLoader();
  const entry = await entryFor();
  const first = loader.load(entry);
  const repeated = loader.load(entry);
  expect(repeated).toBe(first);
  await expect(first).rejects.toThrow("Extension module JSON is invalid");
  await expect(repeated).rejects.toThrow("Extension module JSON is invalid");

  const other = await loader.load(await entryFor("other.ts"));
  expect((other.default as () => string)()).toBe("other-ok");

  await writeJson(join(packageRoot, "value.json"), { ok: 1 });
  await expect(loader.load(entry)).rejects.toThrow("Extension module JSON is invalid");

  const fresh = await createExtensionLoader().load(entry);
  const result = (fresh.default as () => { esm: { ok: number }; cjs: unknown })();
  expect(result.cjs).toBe(result.esm);
  expect(result.esm).toEqual({ ok: 1 });
});

// An async root can enter synchronous transpilation through an ordinary CJS require.
test.each([
  { x: 1 },
  false,
  { default: 7 },
  { __esModule: true, default: 7 },
  { __esModule: true, x: 1 },
])("keeps synchronous ESM JSON imports raw through a CJS bridge: %j", async (value) => {
  await writeJson(join(packageRoot, "value.json"), value);
  await writeText(
    join(packageRoot, "dep.ts"),
    'import value from "./value.json"; export const picked = value; export const raw = require("./value.json");',
  );
  await writeText(join(packageRoot, "bridge.cjs"), 'module.exports = require("./dep.ts");');
  await writeText(
    join(packageRoot, "entry.ts"),
    'const bridge = require("./bridge.cjs"); export default () => bridge;',
  );
  const module = await createExtensionLoader().load(await entryFor());
  const result = (module.default as () => { picked: unknown; raw: unknown })();
  expect(result.picked).toBe(result.raw);
  expect(result.raw).toEqual(value);
  if (typeof value === "object")
    expect(Reflect.ownKeys(result.raw as object)).toEqual(Reflect.ownKeys(value));
});

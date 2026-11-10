import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DiscoveredEntry } from "../src/extensions/types.js";
import { writeText } from "./extensions-fixtures.js";

const state = vi.hoisted(() => ({
  mode: "missing" as "missing" | 0 | 2 | 1,
  evalCalls: 0,
  sentinels: [] as string[],
}));

vi.mock("jiti", () => ({
  createJiti: () => {
    const instance: Record<string, unknown> = {
      evalModule: async () => {
        state.evalCalls += 1;
        await Promise.all(state.sentinels.map((path) => writeFile(path, "evaluated")));
        throw new Error("fake evalModule must not run");
      },
    };
    if (state.mode !== "missing") {
      Object.defineProperty(instance, "piscesExtensionModeVersion", {
        value: state.mode,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    }
    return instance;
  },
}));

import { createExtensionLoader, ExtensionLoadError } from "../src/extensions/loader.js";

let root = "";
let packageRoot = "";

beforeEach(async () => {
  state.evalCalls = 0;
  state.sentinels = [];
  state.mode = "missing";
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-patch-guard-"));
  packageRoot = join(root, "pkg");
  await mkdir(packageRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function entry(): Promise<DiscoveredEntry> {
  const entryPath = join(packageRoot, "entry.ts");
  await writeText(entryPath, 'export default () => "unexpected";\n');
  return {
    info: { type: "tool", source: "pkg", name: "pkg#tool" as DiscoveredEntry["info"]["name"] },
    origin: "config",
    packageRoot,
    entryPath,
    entryDigest: createHash("sha256")
      .update(await readFile(entryPath))
      .digest("hex"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

test("rejects missing or wrong patch before eval", async () => {
  for (const mode of ["missing", 0, 2] as const) {
    state.mode = mode;
    const sentinel = join(root, `eval-${String(mode)}`);
    state.sentinels = [sentinel];

    expect(() => createExtensionLoader()).not.toThrow();
    const loadedEntry = await entry();
    await expect(createExtensionLoader().load(loadedEntry)).rejects.toThrow(
      "Extension loader patch is unavailable",
    );
    expect(state.evalCalls, String(mode)).toBe(0);
    expect(await exists(sentinel)).toBe(false);
  }

  const failure = await createExtensionLoader()
    .load(await entry())
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ExtensionLoadError);
  expect((failure as Error).cause).toBeUndefined();
});

test("accepts the exact marker value", async () => {
  state.mode = 1;
  const loadedEntry = await entry();
  await expect(createExtensionLoader().load(loadedEntry)).rejects.toThrow(
    "Extension module failed to load",
  );
  expect(state.evalCalls).toBe(1);
});

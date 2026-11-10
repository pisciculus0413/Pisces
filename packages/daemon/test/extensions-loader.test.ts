import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type EntryInfo, type EntryName, ToolDeniedError } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { DiscoveredEntry } from "../src/extensions/types.js";
import { writeJson, writeText } from "./extensions-fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST_LOADER = join(REPO_ROOT, "packages", "daemon", "dist", "extensions", "loader.js");
const DIST_CORE = join(REPO_ROOT, "packages", "core", "dist", "index.js");

let root = "";
let packageRoot = "";
let sentinel = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-loader-"));
  packageRoot = join(root, "pkg");
  sentinel = join(root, "counter");
  await mkdir(packageRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const entryName = (value: string): EntryName => value as EntryName;

function toolEntry(
  type: EntryInfo["type"],
  entryPath: string,
  entryDigest: string,
): DiscoveredEntry {
  return {
    info: { type, source: "pkg", name: entryName(`pkg#${type}`) },
    origin: "config",
    packageRoot,
    entryPath,
    entryDigest,
  };
}

async function entryFor(type: EntryInfo["type"], relativePath: string): Promise<DiscoveredEntry> {
  const entryPath = join(packageRoot, relativePath);
  const entryDigest = digest(await readFile(entryPath));
  return toolEntry(type, entryPath, entryDigest);
}

async function readCount(): Promise<number> {
  try {
    return Number(await readFile(sentinel, "utf8"));
  } catch {
    return 0;
  }
}

// Top-level side effect proves whether (and how often) the entry module executed.
function countPrelude(): string {
  return [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    `const COUNTER = ${JSON.stringify(sentinel)};`,
    'const count = existsSync(COUNTER) ? Number(readFileSync(COUNTER, "utf8")) + 1 : 1;',
    "writeFileSync(COUNTER, String(count));",
    "",
  ].join("\n");
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

test("creating a loader does not import any extension entry", async () => {
  await writeText(
    join(packageRoot, "tools", "lazy.ts"),
    `${countPrelude()}export default () => 1;\n`,
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  createExtensionLoader();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await readCount()).toBe(0);
});

test("loads TS with static and dynamic host imports using the actual host class", async () => {
  await writeText(
    join(packageRoot, "tools", "identity.ts"),
    [
      countPrelude(),
      'import { ToolDeniedError } from "@pisces/core";',
      "export default async function run() {",
      '  const dynamic = await import("@pisces/core");',
      '  const error = new ToolDeniedError("denied");',
      '  if (!(error instanceof dynamic.ToolDeniedError)) throw new Error("host copies differ");',
      "  throw error;",
      "}",
      "",
    ].join("\n"),
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const loader = createExtensionLoader();
  const module = await loader.load(await entryFor("tool", "tools/identity.ts"));
  expect(typeof module.default).toBe("function");
  let loaded: unknown;
  try {
    await (module.default as () => Promise<unknown>)();
  } catch (error) {
    loaded = error;
  }
  expect(loaded).toBeInstanceOf(ToolDeniedError);
  expect(await readCount()).toBe(1);
});

test("loads TSX with an extension-local JSX runtime", async () => {
  await writeText(
    join(packageRoot, "tools", "jsx", "jsx-runtime.ts"),
    [
      "export function jsx(type: unknown, props: unknown) {",
      "  return { type, props };",
      "}",
      "export const jsxs = jsx;",
      'export const Fragment = "fragment";',
      "",
    ].join("\n"),
  );
  await writeText(
    join(packageRoot, "tools", "view.tsx"),
    [
      countPrelude(),
      "/** @jsxImportSource ./jsx */",
      'import { ToolDeniedError } from "@pisces/core";',
      "export default async function run() {",
      '  const node = <box label="x"><inner /></box>;',
      '  const dynamic = await import("@pisces/core");',
      '  const error = new ToolDeniedError("jsx");',
      "  return { node, host: error instanceof dynamic.ToolDeniedError };",
      "}",
      "",
    ].join("\n"),
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const module = await createExtensionLoader().load(await entryFor("tool", "tools/view.tsx"));
  const result = (await (module.default as () => Promise<unknown>)()) as {
    node: { type: string; props: { label: string; children: { type: string } } };
    host: boolean;
  };
  expect(result.node).toEqual({
    type: "box",
    props: { label: "x", children: { type: "inner", props: {} } },
  });
  expect(result.host).toBe(true);
});

test("resolves tsconfig paths through extends and baseUrl", async () => {
  await writeJson(join(packageRoot, "tsconfig.base.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: { "@shared/*": ["shared/*"] },
    },
  });
  await writeJson(join(packageRoot, "tsconfig.json"), {
    extends: "./tsconfig.base.json",
    compilerOptions: { target: "ES2022" },
  });
  await writeText(join(packageRoot, "shared", "value.ts"), 'export const marker = "paths-ok";\n');
  await writeText(
    join(packageRoot, "tools", "paths.ts"),
    [
      countPrelude(),
      'import { marker } from "@shared/value";',
      "export default function run() {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const module = await createExtensionLoader().load(await entryFor("tool", "tools/paths.ts"));
  expect((module.default as () => string)()).toBe("paths-ok");
});

test("loads relative TS dependencies and TS packages from extension node_modules", async () => {
  await writeText(join(packageRoot, "lib", "local.ts"), 'export const local = "relative-ts";\n');
  await writeJson(join(packageRoot, "node_modules", "local-ts", "package.json"), {
    name: "local-ts",
    version: "1.0.0",
    main: "index.ts",
  });
  await writeText(
    join(packageRoot, "node_modules", "local-ts", "index.ts"),
    'export const dependency = "node-modules-ts";\n',
  );
  await writeText(
    join(packageRoot, "tools", "deps.ts"),
    [
      countPrelude(),
      'import { dependency } from "local-ts";',
      'import { local } from "../lib/local";',
      "export default function run() {",
      "  return { dependency, local };",
      "}",
      "",
    ].join("\n"),
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const module = await createExtensionLoader().load(await entryFor("tool", "tools/deps.ts"));
  expect((module.default as () => unknown)()).toEqual({
    dependency: "node-modules-ts",
    local: "relative-ts",
  });
});

test("concurrent loads of one entry share a single module execution", async () => {
  await writeText(
    join(packageRoot, "tools", "once.ts"),
    `${countPrelude()}export default () => "once";\n`,
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const loader = createExtensionLoader();
  const entry = await entryFor("tool", "tools/once.ts");
  const [first, second] = await Promise.all([loader.load(entry), loader.load(entry)]);
  expect(first).toBe(second);
  expect(await readCount()).toBe(1);
});

test("caches failures and does not affect other entries", async () => {
  await writeText(
    join(packageRoot, "tools", "bad-default.ts"),
    `${countPrelude()}export default 42;\n`,
  );
  await writeText(
    join(packageRoot, "tools", "good.ts"),
    `${countPrelude()}export default () => "good";\n`,
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const loader = createExtensionLoader();
  const bad = await entryFor("tool", "tools/bad-default.ts");
  const first = loader.load(bad);
  const second = loader.load(bad);
  expect(first).toBe(second);
  await expect(first).rejects.toThrow(/default/u);
  await expect(second).rejects.toThrow(/default/u);
  expect(await readCount()).toBe(1);
  const good = await loader.load(await entryFor("tool", "tools/good.ts"));
  expect((good.default as () => string)()).toBe("good");
  expect(await readCount()).toBe(2);
});

test("rejects non-function default exports for tool, wrapper and context", async () => {
  for (const type of ["tool", "wrapper", "context"] as const) {
    await writeText(
      join(packageRoot, "entries", `${type}.ts`),
      `${countPrelude()}export default { type: ${JSON.stringify(type)} };\n`,
    );
    const { createExtensionLoader } = await import("../src/extensions/loader.js");
    await expect(
      createExtensionLoader().load(await entryFor(type, `entries/${type}.ts`)),
    ).rejects.toThrow(/default/u);
  }
  expect(await readCount()).toBe(3);
});

test("rejects skill entries without loading code", async () => {
  await writeText(join(packageRoot, "skills", "skill", "SKILL.md"), "# Skill\n");
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const skill = await entryFor("skill", "skills/skill/SKILL.md");
  await expect(createExtensionLoader().load(skill)).rejects.toThrow(/skill/iu);
});

test("isolates syntax errors to the failing entry", async () => {
  await writeText(join(packageRoot, "tools", "broken.ts"), "export default function broken( {\n");
  await writeText(
    join(packageRoot, "tools", "fine.ts"),
    `${countPrelude()}export default () => "fine";\n`,
  );
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const loader = createExtensionLoader();
  await expect(loader.load(await entryFor("tool", "tools/broken.ts"))).rejects.toThrow();
  const fine = await loader.load(await entryFor("tool", "tools/fine.ts"));
  expect((fine.default as () => string)()).toBe("fine");
  expect(await readCount()).toBe(1);
});

test("refuses to execute an entry whose bytes no longer match the frozen digest", async () => {
  const path = join(packageRoot, "tools", "frozen.ts");
  await writeText(join(packageRoot, "tools", "seed.ts"), `${countPrelude()}export default 1;\n`);
  const frozen = await entryFor("tool", "tools/seed.ts");
  await writeText(path, `${countPrelude()}export default () => "changed";\n`);
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const loader = createExtensionLoader();
  await expect(loader.load({ ...frozen, entryPath: path })).rejects.toThrow(/changed/iu);
  expect(await readCount()).toBe(0);
  const current = await entryFor("tool", "tools/frozen.ts");
  const module = await loader.load(current);
  expect((module.default as () => string)()).toBe("changed");
  expect(await readCount()).toBe(1);
});

test("does not reuse a stale entry module across loader instances", async () => {
  const path = join(packageRoot, "tools", "versioned.ts");
  await writeText(path, `${countPrelude()}export default () => "v1";\n`);
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const first = createExtensionLoader();
  const second = createExtensionLoader();
  const v1 = await entryFor("tool", "tools/versioned.ts");
  const firstModule = await first.load(v1);
  const secondModule = await second.load(v1);
  expect(firstModule).not.toBe(secondModule);
  expect((firstModule.default as () => string)()).toBe("v1");
  expect((secondModule.default as () => string)()).toBe("v1");
  expect(await readCount()).toBe(2);

  await writeText(path, `${countPrelude()}export default () => "v2";\n`);
  const v2 = await entryFor("tool", "tools/versioned.ts");
  expect(v2.entryDigest).not.toBe(v1.entryDigest);
  const updated = await first.load(v2);
  expect((updated.default as () => string)()).toBe("v2");
  expect(await readCount()).toBe(3);
  await first.load(v1);
  expect(await readCount()).toBe(3);
});

interface ChildResult {
  staticIdentity: boolean;
  dynamicIdentity: boolean;
  instanceIdentity: boolean;
  paths: string;
  nodeModules: string;
  jsx: boolean;
}

function runDistChild(
  cwd: string,
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.VITEST;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("refuses to load a changed CommonJS entry from disk", async () => {
  const path = join(packageRoot, "tools", "plain.cjs");
  const source = (value: string): string =>
    [
      'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
      `const COUNTER = ${JSON.stringify(sentinel)};`,
      'const count = existsSync(COUNTER) ? Number(readFileSync(COUNTER, "utf8")) + 1 : 1;',
      "writeFileSync(COUNTER, String(count));",
      `exports.default = () => ${JSON.stringify(value)};`,
      "",
    ].join("\n");
  await writeText(path, source("cjs-v1"));
  const { createExtensionLoader } = await import("../src/extensions/loader.js");
  const v1 = await entryFor("tool", "tools/plain.cjs");
  const first = await createExtensionLoader().load(v1);
  const second = await createExtensionLoader().load(v1);
  expect((first.default as () => string)()).toBe("cjs-v1");
  expect((second.default as () => string)()).toBe("cjs-v1");
  expect(await readCount()).toBe(2);

  await writeText(path, source("cjs-v2"));
  await expect(createExtensionLoader().load(v1)).rejects.toThrow(/changed/iu);
  expect(await readCount()).toBe(2);
});

test("compiled dist loader preserves host identity and path resolution in a fresh process", async () => {
  if (!(await exists(DIST_LOADER))) {
    throw new Error(`missing ${DIST_LOADER}; run pnpm exec tsc -b tsconfig.build.json first`);
  }
  const distRoot = join(root, "dist-pkg");
  await writeJson(join(distRoot, "tsconfig.base.json"), {
    compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["shared/*"] } },
  });
  await writeJson(join(distRoot, "tsconfig.json"), {
    extends: "./tsconfig.base.json",
    compilerOptions: { target: "ES2022" },
  });
  await writeText(join(distRoot, "shared", "value.ts"), 'export const marker = "dist-paths";\n');
  await writeJson(join(distRoot, "node_modules", "dist-ts", "package.json"), {
    name: "dist-ts",
    version: "1.0.0",
    main: "index.ts",
  });
  await writeText(
    join(distRoot, "node_modules", "dist-ts", "index.ts"),
    'export const dependency = "dist-node-modules";\n',
  );
  await writeText(
    join(distRoot, "tools", "entry.ts"),
    [
      'import { ToolDeniedError } from "@pisces/core";',
      'import { marker } from "@shared/value";',
      'import { dependency } from "dist-ts";',
      "export default async function run() {",
      '  const dynamic = await import("@pisces/core");',
      '  const error = new ToolDeniedError("dist");',
      "  return {",
      "    marker,",
      "    dependency,",
      "    staticClass: ToolDeniedError,",
      "    dynamicClass: dynamic.ToolDeniedError,",
      "    error,",
      '    dynamicError: new dynamic.ToolDeniedError("dynamic"),',
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  await writeText(
    join(distRoot, "tools", "jsx", "jsx-runtime.ts"),
    [
      "export function jsx(type: unknown, props: unknown) {",
      "  return { type, props };",
      "}",
      "export const jsxs = jsx;",
      'export const Fragment = "fragment";',
      "",
    ].join("\n"),
  );
  await writeText(
    join(distRoot, "tools", "view.tsx"),
    [
      "/** @jsxImportSource ./jsx */",
      "export default function run() {",
      '  return <box label="dist"><inner /></box>;',
      "}",
      "",
    ].join("\n"),
  );

  const script = [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    `const core = await import(${JSON.stringify(pathToFileURL(DIST_CORE).href)});`,
    `const { createExtensionLoader } = await import(${JSON.stringify(pathToFileURL(DIST_LOADER).href)});`,
    "const loader = createExtensionLoader();",
    "async function load(kind, path) {",
    "  const bytes = readFileSync(path);",
    '  const entryDigest = createHash("sha256").update(bytes).digest("hex");',
    "  const module = await loader.load({",
    `    info: { type: kind, source: "dist", name: "dist#" + kind },`,
    `    packageRoot: ${JSON.stringify(distRoot)},`,
    "    entryPath: path,",
    "    entryDigest,",
    "  });",
    "  return module.default();",
    "}",
    `const entry = await load("tool", ${JSON.stringify(join(distRoot, "tools", "entry.ts"))});`,
    `const view = await load("tool", ${JSON.stringify(join(distRoot, "tools", "view.tsx"))});`,
    "const result = {",
    "  staticIdentity: entry.staticClass === core.ToolDeniedError,",
    "  dynamicIdentity: entry.dynamicClass === core.ToolDeniedError,",
    "  instanceIdentity:",
    "    entry.error instanceof core.ToolDeniedError &&",
    "    entry.dynamicError instanceof core.ToolDeniedError,",
    "  paths: entry.marker,",
    "  nodeModules: entry.dependency,",
    '  jsx: view.type === "box" && view.props.label === "dist",',
    "};",
    "console.log(JSON.stringify(result));",
  ].join("\n");

  const child = await runDistChild(distRoot, script);
  expect(child.code, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()) as ChildResult;
  expect(result).toEqual({
    staticIdentity: true,
    dynamicIdentity: true,
    instanceIdentity: true,
    paths: "dist-paths",
    nodeModules: "dist-node-modules",
    jsx: true,
  });
}, 30_000);

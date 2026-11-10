import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type EntryName, ToolDeniedError } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createExtensionLoader } from "../src/extensions/loader.js";
import type { DiscoveredEntry } from "../src/extensions/types.js";
import { writeJson, writeText } from "./extensions-fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST_LOADER = join(REPO_ROOT, "packages", "daemon", "dist", "extensions", "loader.js");
const DIST_CORE = join(REPO_ROOT, "packages", "core", "dist", "index.js");
let root = "";
let packageRoot = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-loader-cjs-"));
  packageRoot = join(root, "pkg");
  await mkdir(packageRoot, { recursive: true });
  await writeJson(join(packageRoot, "node_modules", "cjs-dep", "package.json"), {
    name: "cjs-dep",
    version: "1.0.0",
    main: "index.cjs",
  });
  await writeText(
    join(packageRoot, "node_modules", "cjs-dep", "index.cjs"),
    'const { ToolDeniedError } = require("@pisces/core");\nmodule.exports = { fromDep: ToolDeniedError };\n',
  );
  await writeJson(join(packageRoot, "node_modules", "@pisces", "core", "package.json"), {
    name: "@pisces/core",
    version: "9.9.9",
    main: "index.cjs",
  });
  await writeText(
    join(packageRoot, "node_modules", "@pisces", "core", "index.cjs"),
    "class ToolDeniedError extends Error {}\nmodule.exports = { ToolDeniedError };\n",
  );
  await writeText(
    join(packageRoot, "tools", "entry.ts"),
    'import { fromDep } from "cjs-dep";\nexport default function run() { return fromDep; }\n',
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function entry(): Promise<DiscoveredEntry> {
  const entryPath = join(packageRoot, "tools", "entry.ts");
  return {
    info: { type: "tool", source: "pkg", name: "pkg#tool" as EntryName },
    origin: "config",
    packageRoot,
    entryPath,
    entryDigest: createHash("sha256")
      .update(await readFile(entryPath))
      .digest("hex"),
  };
}

function runDistChild(
  cwd: string,
  script: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
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
    }, 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("source loader CJS transitive import resolves host ToolDeniedError", async () => {
  try {
    const module = await createExtensionLoader().load(await entry());
    expect((module.default as () => unknown)()).toBe(ToolDeniedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dist loader CJS transitive import resolves host ToolDeniedError", async () => {
  try {
    const script = [
      'import { createHash } from "node:crypto";',
      'import { readFileSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      `const core = await import(${JSON.stringify(pathToFileURL(DIST_CORE).href)});`,
      `const { createExtensionLoader } = await import(${JSON.stringify(pathToFileURL(DIST_LOADER).href)});`,
      `const path = ${JSON.stringify(join(packageRoot, "tools", "entry.ts"))};`,
      "const bytes = readFileSync(path);",
      "const module = await createExtensionLoader().load({",
      '  info: { type: "tool", source: "pkg", name: "pkg#tool" },',
      `  packageRoot: ${JSON.stringify(packageRoot)},`,
      "  entryPath: path,",
      '  entryDigest: createHash("sha256").update(bytes).digest("hex"),',
      "});",
      "console.log(JSON.stringify({ host: module.default() === core.ToolDeniedError }));",
    ].join("\n");
    const child = await runDistChild(packageRoot, script);
    expect(child.code, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ host: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

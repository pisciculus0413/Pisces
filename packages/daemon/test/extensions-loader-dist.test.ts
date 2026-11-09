import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeJson, writeText } from "./extensions-fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CHILD = join(
  REPO_ROOT,
  "packages",
  "daemon",
  "test",
  "fixtures",
  "extensions-loader-child.mjs",
);
const DIST_LOADER = join(REPO_ROOT, "packages", "daemon", "dist", "extensions", "loader.js");

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-dist-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(caseName: string, packageRoot: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.VITEST;
    const child = spawn(process.execPath, [CHILD, caseName, packageRoot], {
      cwd: packageRoot,
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
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

async function writeVendoredHosts(packageRoot: string): Promise<void> {
  const hosts = {
    core: ["@pisces/core", "module.exports = { ToolDeniedError: class VendoredCore {} };\n"],
    protocol: [
      "@pisces/protocol",
      'module.exports = { encodeFrame: () => "vendored-protocol" };\n',
    ],
    daemon: [
      "@pisces/daemon",
      'module.exports = { bootstrapGateway: async () => "vendored-daemon" };\n',
    ],
  } as const;
  for (const [id, source] of Object.values(hosts)) {
    await writeJson(join(packageRoot, "node_modules", ...id.split("/"), "package.json"), {
      name: id,
      version: "9.9.9",
      main: "index.cjs",
    });
    await writeText(join(packageRoot, "node_modules", ...id.split("/"), "index.cjs"), source);
  }
}

async function prepareHosts(packageRoot: string): Promise<void> {
  await writeVendoredHosts(packageRoot);
  await writeJson(join(packageRoot, "node_modules", "cjs-dep", "package.json"), {
    name: "cjs-dep",
    version: "1.0.0",
    main: "index.cjs",
  });
  await writeText(
    join(packageRoot, "node_modules", "cjs-dep", "index.cjs"),
    'module.exports = require("./layer.cjs");\n',
  );
  await writeText(
    join(packageRoot, "node_modules", "cjs-dep", "layer.cjs"),
    [
      'const core = require("@pisces/core");',
      'const protocol = require("@pisces/protocol");',
      'const daemon = require("@pisces/daemon");',
      "module.exports = { core, protocol, daemon };",
      "",
    ].join("\n"),
  );
  await writeText(
    join(packageRoot, "entry.ts"),
    [
      'import { core, protocol, daemon } from "cjs-dep";',
      'const computed = "@pisces/" + "core";',
      "const required = require(computed);",
      "export default async function run() {",
      '  const dynamic = await import("@pisces/protocol");',
      '  const error = new required.ToolDeniedError("denied");',
      "  return {",
      "    core: core.ToolDeniedError,",
      "    protocol: protocol.encodeFrame,",
      "    daemon: daemon.bootstrapGateway,",
      "    dynamicProtocol: dynamic.encodeFrame,",
      "    requiredCore: required.ToolDeniedError,",
      "    error,",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
}

const JSON_VALUES: unknown[] = [{ x: 1 }, [1, 2], "x", 0, 2, false, true, null, { default: 7 }];

async function prepareJson(packageRoot: string): Promise<void> {
  await writeJson(join(packageRoot, "expected.json"), JSON_VALUES);
  const imports: string[] = [];
  const inputs: string[] = [];
  for (let index = 0; index < JSON_VALUES.length; index += 1) {
    await writeJson(join(packageRoot, "values", `${index}.json`), JSON_VALUES[index]);
    imports.push(`import v${index} from "./values/${index}.json";`);
    inputs.push(
      `{ esm: v${index}, cjs: require("./values/${index}.json"), again: require("./values/${index}.json") }`,
    );
  }
  await writeText(
    join(packageRoot, "entry.ts"),
    [
      ...imports,
      `const inputs = [${inputs.join(", ")}];`,
      "export default function run() { return inputs; }",
      "",
    ].join("\n"),
  );
}

async function prepareSemantics(packageRoot: string): Promise<void> {
  const metaPath = join(packageRoot, "deps", "meta.cjs");
  await writeText(metaPath, "module.exports = { filename: __filename, dirname: __dirname };\n");
  await writeText(
    join(packageRoot, "deps", "meta.mjs"),
    "export const metaURL = import.meta.url;\n",
  );
  await writeText(
    join(packageRoot, "deps", "tla.ts"),
    "export default await Promise.resolve(17);\n",
  );
  await writeText(join(packageRoot, "deps", "value.ts"), "export default 19;\n");
  await writeText(
    join(packageRoot, "deps", "computed.ts"),
    [
      "export default async function computed() {",
      '  const specifier = "./val" + "ue.ts";',
      "  return (await import(specifier)).default;",
      "}",
      "",
    ].join("\n"),
  );
  await writeText(
    join(packageRoot, "entry.ts"),
    [
      'const metaCjs = require("./deps/meta.cjs");',
      'import { metaURL } from "./deps/meta.mjs";',
      'import tla from "./deps/tla.ts";',
      'import computed from "./deps/computed.ts";',
      "export default async function run() {",
      "  return {",
      "    filename: metaCjs.filename,",
      "    dirname: metaCjs.dirname,",
      "    metaURL,",
      "    tla,",
      "    computed: await computed(),",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
}

async function prepareFormats(packageRoot: string): Promise<void> {
  await writeText(
    join(packageRoot, "deps", "bad.wasm"),
    [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(join(packageRoot, "sentinel"))}, "executed");`,
      'module.exports = "should-not-run";',
      "",
    ].join("\n"),
  );
  await writeText(
    join(packageRoot, "entry.ts"),
    'const value = require("./deps/bad.wasm");\nexport default () => value;\n',
  );
  await writeText(
    join(packageRoot, "control.ts"),
    'const fs = require("node:fs");\nexport default () => (typeof fs.readFileSync === "function" ? "control" : "broken");\n',
  );
}

test("checks actual dist cases", async () => {
  if (!(await exists(DIST_LOADER))) {
    throw new Error(`missing ${DIST_LOADER}; run pnpm exec tsc -b tsconfig.build.json first`);
  }

  const cases = [
    {
      name: "hosts",
      prepare: prepareHosts,
      expected: { core: true, protocol: true, daemon: true, error: true },
    },
    { name: "json", prepare: prepareJson, expected: { count: JSON_VALUES.length } },
    {
      name: "semantics",
      prepare: prepareSemantics,
      expected: { filename: true, metaURL: true, tla: 17, computed: 19 },
    },
    { name: "formats", prepare: prepareFormats, expected: { rejected: true, control: true } },
  ];

  for (const item of cases) {
    const packageRoot = join(root, item.name);
    await mkdir(packageRoot, { recursive: true });
    await item.prepare(packageRoot);
    const child = await runChild(item.name, packageRoot);
    expect(child.code, `${item.name}: ${child.stderr}`).toBe(0);
    expect(child.stderr, item.name).toBe("");
    expect(JSON.parse(child.stdout), item.name).toEqual(item.expected);
    expect(await exists(join(packageRoot, "sentinel")), item.name).toBe(false);
  }
}, 120_000);

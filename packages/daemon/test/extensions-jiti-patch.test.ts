import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti, type JitiOptions } from "jiti";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeJson, writeText } from "./extensions-fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NATIVE_FIXTURE = join(
  REPO_ROOT,
  "packages",
  "daemon",
  "test",
  "fixtures",
  "extensions-loader-native",
);
const requireFromDaemon = createRequire(join(REPO_ROOT, "packages", "daemon", "package.json"));

const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"] as const;
const FORMAT_CODE = "ERR_PISCES_EXTENSION_FORMAT";
const JSON_CODE = "ERR_PISCES_EXTENSION_JSON";
const MODE_CODE = "ERR_PISCES_EXTENSION_MODE";

// Private Pisces option/type additions are exercised before the installed package is patched.
type EngineOptions = JitiOptions & { transformAll?: boolean };
type MarkedJiti = ReturnType<typeof createJiti> & {
  readonly piscesExtensionModeVersion?: 1;
};

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-jiti-patch-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function options(extra: Partial<EngineOptions> = {}): EngineOptions {
  return {
    fsCache: false,
    moduleCache: false,
    interopDefault: false,
    tryNative: false,
    nativeModules: [],
    transformModules: [],
    jsx: { runtime: "automatic" },
    ...extra,
  };
}

function engine(extra: Partial<EngineOptions> = {}): MarkedJiti {
  return createJiti(join(root, "entry.ts"), options(extra)) as MarkedJiti;
}

function enabled(extra: Partial<EngineOptions> = {}): MarkedJiti {
  return engine({ transformAll: true, ...extra });
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

async function counter(path: string): Promise<number> {
  try {
    return Number(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return 0;
    throw error;
  }
}

async function rejectionCode(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  throw new Error("expected the operation to reject");
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...opts.env };
    delete env.NODE_OPTIONS;
    delete env.VITEST;
    const child = spawn(command, args, {
      cwd: opts.cwd,
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
    }, opts.timeout);
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

async function buildNativeAddon(): Promise<string> {
  const source = join(root, "native");
  await mkdir(source, { recursive: true });
  await copyFile(join(NATIVE_FIXTURE, "binding.gyp"), join(source, "binding.gyp"));
  await copyFile(join(NATIVE_FIXTURE, "sentinel.c"), join(source, "sentinel.c"));

  const nodeGyp = join(
    dirname(requireFromDaemon.resolve("node-gyp/package.json")),
    "bin",
    "node-gyp.js",
  );
  const runtimeRoot = dirname(dirname(process.execPath));
  const headers = join(runtimeRoot, "include", "node", "node.h");
  const args = [nodeGyp, "rebuild", "--release"];
  if (await exists(headers)) args.push(`--nodedir=${runtimeRoot}`);

  const built = await runProcess(process.execPath, args, {
    cwd: source,
    timeout: 120_000,
  });
  if (built.code !== 0) {
    throw new Error(`node-gyp failed (${built.code ?? built.signal}): ${built.stderr}`);
  }
  const addon = join(source, "build", "Release", "sentinel.node");
  if (!(await exists(addon))) throw new Error(`node-gyp did not produce ${addon}`);
  return addon;
}

test("marks enabled instance", () => {
  const on = enabled();
  expect(Object.getOwnPropertyDescriptor(on, "piscesExtensionModeVersion")).toEqual({
    value: 1,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  const omitted = engine();
  expect(Object.getOwnPropertyDescriptor(omitted, "piscesExtensionModeVersion")).toBeUndefined();

  const off = engine({ transformAll: false });
  expect(Object.getOwnPropertyDescriptor(off, "piscesExtensionModeVersion")).toBeUndefined();
});

test("evaluates verified bytes rather than disk", async () => {
  const entryPath = join(root, "tool.ts");
  const diskSentinel = join(root, "disk-ran");
  await writeText(
    entryPath,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(diskSentinel)}, "disk");`,
      'export default () => "disk";',
      "",
    ].join("\n"),
  );

  const evaluated = await enabled().evalModule('export default () => "verified";\n', {
    filename: entryPath,
    async: true,
    forceTranspile: true,
  });

  expect((evaluated as { default: () => string }).default()).toBe("verified");
  expect(await exists(diskSentinel)).toBe(false);
});

test("preserves upstream transform when omitted or false", async () => {
  await writeText(
    join(root, "jsx", "jsx-runtime.ts"),
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
    join(root, "view.tsx"),
    [
      "/** @jsxImportSource ./jsx */",
      "export default function view() {",
      '  return <box label="x"><inner /></box>;',
      "}",
      "",
    ].join("\n"),
  );
  const source = 'import view from "./view.tsx";\nexport default view;\n';
  const expected = {
    type: "box",
    props: { label: "x", children: { type: "inner", props: {} } },
  };

  for (const mode of [undefined, false, true] as const) {
    const jiti = mode === undefined ? engine() : engine({ transformAll: mode });
    const evaluated = await jiti.evalModule(source, {
      filename: join(root, "entry.ts"),
      async: true,
      forceTranspile: true,
    });
    expect((evaluated as { default: () => unknown }).default()).toEqual(expected);
  }
});

test("keeps virtual host identity through nested CJS and JS", async () => {
  await writeJson(join(root, "node_modules", "@pisces", "core", "package.json"), {
    name: "@pisces/core",
    version: "9.9.9",
    main: "index.cjs",
  });
  await writeText(
    join(root, "node_modules", "@pisces", "core", "index.cjs"),
    "module.exports = { ToolDeniedError: class Vendored {} };\n",
  );
  await writeText(join(root, "deps", "dep.cjs"), 'module.exports = require("@pisces/core");\n');
  await writeText(join(root, "deps", "dep.js"), 'module.exports = require("@pisces/core");\n');
  const host = { ToolDeniedError: class Host {} };

  const evaluated = await enabled({ virtualModules: { "@pisces/core": host } }).evalModule(
    'module.exports = { cjs: require("./deps/dep.cjs"), js: require("./deps/dep.js") };\n',
    { filename: join(root, "entry.cjs"), async: true, forceTranspile: true },
  );

  expect((evaluated as { cjs: unknown }).cjs).toBe(host);
  expect((evaluated as { js: unknown }).js).toBe(host);
});

test("terminates a private CJS cycle", async () => {
  await writeText(
    join(root, "cycle", "a.cjs"),
    [
      'exports.a = "a";',
      'const b = require("./b.cjs");',
      "exports.b = b.b;",
      "exports.seenA = b.seenA;",
      "",
    ].join("\n"),
  );
  await writeText(
    join(root, "cycle", "b.cjs"),
    ['exports.b = "b";', 'const a = require("./a.cjs");', "exports.seenA = a.a;", ""].join("\n"),
  );

  const evaluated = await enabled().evalModule(
    'const a = require("./cycle/a.cjs");\nmodule.exports = { a: a.a, b: a.b, seenA: a.seenA };\n',
    { filename: join(root, "entry.cjs"), async: true, forceTranspile: true },
  );

  expect(evaluated).toEqual({ a: "a", b: "b", seenA: "a" });
});

test("rejects conflicting forceTranspile false", async () => {
  const entryPath = join(root, "entry.cjs");
  const sentinel = join(root, "disk-sentinel");
  await writeText(
    entryPath,
    [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(sentinel)}, "disk");`,
      'module.exports = () => "disk";',
      "",
    ].join("\n"),
  );

  const conflictCode = await rejectionCode(() =>
    enabled().evalModule('module.exports = () => "verified";\n', {
      filename: entryPath,
      async: true,
      forceTranspile: false,
    }),
  );
  expect(conflictCode).toBe(MODE_CODE);
  expect(await exists(sentinel)).toBe(false);
  expect(await counter(sentinel)).toBe(0);

  const control = await enabled().evalModule('export default () => "verified";\n', {
    filename: entryPath,
    async: true,
    forceTranspile: true,
  });
  expect((control as { default: () => string }).default()).toBe("verified");
});

const JSON_VALUES: unknown[] = [{ x: 1 }, [1, 2], "x", 0, 2, false, true, null, { default: 7 }];

test.each(JSON_VALUES.map((value) => [JSON.stringify(value), value]))(
  "keeps raw JSON identity: %s",
  async (_label, value) => {
    await writeJson(join(root, "deps", "value.json"), value);
    await writeText(join(root, "deps", "cjs.cjs"), 'module.exports = require("./value.json");\n');
    await writeText(
      join(root, "deps", "esm.ts"),
      'import value from "./value.json";\nexport default value;\n',
    );

    const evaluated = await enabled().evalModule(
      [
        'import esm from "./deps/esm.ts";',
        'const cjs = require("./deps/cjs.cjs");',
        'const again = require("./deps/cjs.cjs");',
        "export default { esm, cjs, again };",
        "",
      ].join("\n"),
      { filename: join(root, "entry.ts"), async: true, forceTranspile: true },
    );

    const result = (evaluated as { default: { esm: unknown; cjs: unknown; again: unknown } })
      .default;
    expect(result.cjs).toEqual(value);
    expect(result.esm).toBe(result.cjs);
    expect(result.again).toBe(result.cjs);
    if (typeof value === "object" && value !== null) {
      expect(Reflect.ownKeys(result.cjs as object)).toEqual(Reflect.ownKeys(value));
    }
    if (typeof value === "object" && value !== null && Object.hasOwn(value, "default")) {
      expect((result.cjs as { default: unknown }).default).toBe(7);
    }
  },
);

test("isolates fresh graph JSON", async () => {
  await writeJson(join(root, "deps", "value.json"), { v: 1 });
  const source =
    'module.exports = { first: require("./deps/value.json"), second: require("./deps/value.json") };\n';

  const first = (await enabled().evalModule(source, {
    filename: join(root, "entry.cjs"),
    async: true,
    forceTranspile: true,
  })) as { first: { v: number; injected?: boolean }; second: unknown };
  expect(first.first).toBe(first.second);
  expect(first.first.v).toBe(1);
  first.first.v = 99;
  first.first.injected = true;

  await writeJson(join(root, "deps", "value.json"), { v: 2 });
  const second = (await enabled().evalModule(source, {
    filename: join(root, "entry.cjs"),
    async: true,
    forceTranspile: true,
  })) as { first: { v: number; injected?: boolean }; second: unknown };
  expect(second.first).toBe(second.second);
  expect(second.first).not.toBe(first.first);
  expect(second.first.v).toBe(2);
  expect(second.first.injected).toBeUndefined();
});

test("rejects invalid JSON with the private JSON reason", async () => {
  await writeText(join(root, "deps", "value.json"), "{ bad json");
  await writeText(join(root, "deps", "cjs.cjs"), 'module.exports = require("./value.json");\n');
  await writeText(
    join(root, "deps", "esm.ts"),
    'import value from "./value.json";\nexport default value;\n',
  );

  await expect(
    enabled().evalModule('module.exports = require("./deps/cjs.cjs");\n', {
      filename: join(root, "entry.cjs"),
      async: true,
      forceTranspile: true,
    }),
  ).rejects.toMatchObject({ code: JSON_CODE });
  await expect(
    enabled().evalModule('import value from "./deps/esm.ts";\nexport default value;\n', {
      filename: join(root, "entry.ts"),
      async: true,
      forceTranspile: true,
    }),
  ).rejects.toMatchObject({ code: JSON_CODE });

  await writeJson(join(root, "deps", "value.json"), { ok: true });
  const control = await enabled().evalModule('module.exports = require("./deps/cjs.cjs");\n', {
    filename: join(root, "entry.cjs"),
    async: true,
    forceTranspile: true,
  });
  expect(control).toEqual({ ok: true });
});

test("loads all supported script suffixes", async () => {
  for (const extension of SCRIPT_EXTENSIONS) {
    await writeText(
      join(root, "deps", `dep${extension}`),
      `module.exports = ${JSON.stringify(extension)};\n`,
    );
    const evaluated = await enabled().evalModule(
      `module.exports = require("./deps/dep${extension}");\n`,
      { filename: join(root, "entry.cjs"), async: true, forceTranspile: true },
    );
    expect(evaluated).toBe(extension);
  }
});

test("resolves extensionless specifiers, directory indexes and package exports", async () => {
  await writeText(join(root, "deps", "plain.ts"), 'module.exports = "extensionless";\n');
  await writeText(
    join(root, "deps", "folder", "index.ts"),
    'module.exports = "directory-index";\n',
  );
  await writeJson(join(root, "node_modules", "pkg-exports", "package.json"), {
    name: "pkg-exports",
    version: "1.0.0",
    exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
  });
  await writeText(
    join(root, "node_modules", "pkg-exports", "index.cjs"),
    'module.exports = "package-exports";\n',
  );
  await writeText(
    join(root, "node_modules", "pkg-exports", "index.mjs"),
    'export default "package-exports-esm";\n',
  );

  const evaluated = await enabled().evalModule(
    [
      "module.exports = {",
      '  plain: require("./deps/plain"),',
      '  folder: require("./deps/folder"),',
      '  exports: require("pkg-exports"),',
      "};",
      "",
    ].join("\n"),
    { filename: join(root, "entry.cjs"), async: true, forceTranspile: true },
  );
  expect(evaluated).toEqual({
    plain: "extensionless",
    folder: "directory-index",
    exports: "package-exports",
  });
});

test("passes runtime builtins through", async () => {
  const evaluated = await enabled().evalModule(
    [
      "module.exports = {",
      '  bare: typeof require("fs").readFileSync,',
      '  prefixed: typeof require("node:fs").readFileSync,',
      "};",
      "",
    ].join("\n"),
    { filename: join(root, "entry.cjs"), async: true, forceTranspile: true },
  );
  expect(evaluated).toEqual({ bare: "function", prefixed: "function" });
});

test("keeps virtual host identity ahead of nativeModules", async () => {
  await writeJson(join(root, "node_modules", "@pisces", "core", "package.json"), {
    name: "@pisces/core",
    version: "9.9.9",
    main: "index.cjs",
  });
  await writeText(
    join(root, "node_modules", "@pisces", "core", "index.cjs"),
    "module.exports = { ToolDeniedError: class Vendored {} };\n",
  );
  const host = { ToolDeniedError: class Host {} };
  const evaluated = await enabled({
    virtualModules: { "@pisces/core": host },
    nativeModules: ["@pisces/core"],
  }).evalModule('module.exports = require("@pisces/core");\n', {
    filename: join(root, "entry.cjs"),
    async: true,
    forceTranspile: true,
  });
  expect(evaluated).toBe(host);
});

test("rejects unsupported formats before native fallback", async () => {
  const addon = await buildNativeAddon();
  await writeText(join(root, "deps", "control.js"), 'module.exports = "control";\n');
  await mkdir(join(root, "deps"), { recursive: true });
  await copyFile(addon, join(root, "deps", "sentinel.node"));

  const nativeSentinel = join(root, "native-sentinel");
  const child = await runProcess(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      "const addon = require(process.argv[1]); process.stdout.write(String(addon.sentinel));",
      join(root, "deps", "sentinel.node"),
    ],
    {
      cwd: root,
      env: { PISCES_EXTENSION_NATIVE_SENTINEL: nativeSentinel },
      timeout: 30_000,
    },
  );
  expect(child.code, child.stderr).toBe(0);
  expect(child.stdout).toBe("native");
  expect(await readFile(nativeSentinel, "utf8")).toBe("1");
  await rm(nativeSentinel, { force: true });

  const rejected = [
    { name: "suffixless", path: join(root, "deps", "suffixless") },
    { name: "wasm", path: join(root, "deps", "module.wasm") },
    { name: "node", path: join(root, "deps", "sentinel.node") },
    { name: "text", path: join(root, "deps", "module.txt") },
  ];
  for (const item of rejected) {
    if (item.name !== "node") {
      await writeText(
        item.path,
        [
          'const { writeFileSync } = require("node:fs");',
          `writeFileSync(${JSON.stringify(nativeSentinel)}, "executed");`,
          'module.exports = "should-not-run";',
          "",
        ].join("\n"),
      );
    }
  }

  for (const item of rejected) {
    const specifier = `./deps/${item.path.split("/").pop()}`;
    const syncCode = await rejectionCode(() =>
      enabled().evalModule(`module.exports = require(${JSON.stringify(specifier)});\n`, {
        filename: join(root, "entry.cjs"),
        async: false,
        forceTranspile: true,
      }),
    );
    expect(syncCode, item.name).toBe(FORMAT_CODE);
    const asyncCode = await rejectionCode(() => enabled().import(specifier));
    expect(asyncCode, item.name).toBe(FORMAT_CODE);
    expect(await exists(nativeSentinel)).toBe(false);
  }

  const control = await enabled().evalModule('module.exports = require("./deps/control.js");\n', {
    filename: join(root, "entry.cjs"),
    async: true,
    forceTranspile: true,
  });
  expect(control).toBe("control");

  for (const asyncMode of [false, true]) {
    const code = await rejectionCode(() =>
      enabled().evalModule("module.exports = { x: 1 };\n", {
        filename: join(root, "entry.json"),
        async: asyncMode,
        forceTranspile: true,
      }),
    );
    expect(code).toBe(FORMAT_CODE);
    const scriptControl = await enabled().evalModule("module.exports = { x: 1 };\n", {
      filename: join(root, "entry.js"),
      async: asyncMode,
      forceTranspile: true,
    });
    expect(scriptControl).toEqual({ x: 1 });
  }
});

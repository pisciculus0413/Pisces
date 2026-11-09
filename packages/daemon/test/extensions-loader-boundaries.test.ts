import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as hostCore from "@pisces/core";
import { bootstrapGateway } from "@pisces/daemon";
import { encodeFrame } from "@pisces/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createExtensionLoader, ExtensionLoadError } from "../src/extensions/loader.js";
import type { DiscoveredEntry } from "../src/extensions/types.js";
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

let root = "";
let packageRoot = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-extensions-boundaries-"));
  packageRoot = join(root, "pkg");
  await mkdir(packageRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function entryFor(relative = "entry.ts"): Promise<DiscoveredEntry> {
  const entryPath = join(packageRoot, relative);
  return {
    info: { type: "tool", source: "pkg", name: "pkg#tool" as DiscoveredEntry["info"]["name"] },
    packageRoot,
    entryPath,
    entryDigest: digest(await readFile(entryPath)),
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

async function counter(path: string): Promise<number> {
  try {
    return Number(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return 0;
    throw error;
  }
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
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeout);
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
  const built = await runProcess(process.execPath, args, { cwd: source, timeout: 120_000 });
  if (built.code !== 0) throw new Error(`node-gyp failed: ${built.stderr}`);
  const addon = join(source, "build", "Release", "sentinel.node");
  if (!(await exists(addon))) throw new Error(`node-gyp did not produce ${addon}`);
  return addon;
}

function countPrelude(counterPath: string): string {
  return [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    `const COUNTER = ${JSON.stringify(counterPath)};`,
    'const count = existsSync(COUNTER) ? Number(readFileSync(COUNTER, "utf8")) + 1 : 1;',
    "writeFileSync(COUNTER, String(count));",
    "",
  ].join("\n");
}

async function writeVendoredHosts(): Promise<void> {
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

async function writeAliasTsconfig(): Promise<void> {
  await writeJson(join(packageRoot, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@pisces/core": ["alias/core.ts"],
        "@pisces/protocol": ["alias/protocol.ts"],
        "@pisces/daemon": ["alias/daemon.ts"],
      },
    },
  });
  await writeText(
    join(packageRoot, "alias", "core.ts"),
    "export class ToolDeniedError extends Error {}\n",
  );
  await writeText(
    join(packageRoot, "alias", "protocol.ts"),
    'export const encodeFrame = () => "alias-protocol";\n',
  );
  await writeText(
    join(packageRoot, "alias", "daemon.ts"),
    'export const bootstrapGateway = async () => "alias-daemon";\n',
  );
}

test("keeps all three transitive host exports", async () => {
  await writeVendoredHosts();
  await writeAliasTsconfig();
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

  const module = await createExtensionLoader().load(await entryFor());
  const result = (await (module.default as () => Promise<Record<string, unknown>>)()) as {
    core: unknown;
    protocol: unknown;
    daemon: unknown;
    dynamicProtocol: unknown;
    requiredCore: unknown;
    error: unknown;
  };
  expect(result.core).toBe(hostCore.ToolDeniedError);
  expect(result.protocol).toBe(encodeFrame);
  expect(result.daemon).toBe(bootstrapGateway);
  expect(result.dynamicProtocol).toBe(encodeFrame);
  expect(result.requiredCore).toBe(hostCore.ToolDeniedError);
  expect(result.error).toBeInstanceOf(hostCore.ToolDeniedError);
});

test("rejects host subpaths and inherited keys without mapping", async () => {
  const sentinel = join(root, "subpath-sentinel");
  await writeVendoredHosts();
  await writeText(
    join(packageRoot, "node_modules", "@pisces", "core", "extra.cjs"),
    [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
      "module.exports = { vendored: true };",
      "",
    ].join("\n"),
  );
  await writeText(
    join(packageRoot, "entry.ts"),
    'const extra = require("@pisces/core/extra");\nexport default () => extra;\n',
  );

  let subpath: unknown;
  try {
    await createExtensionLoader().load(await entryFor());
  } catch (error) {
    subpath = error;
  }
  expect(subpath).toBeInstanceOf(ExtensionLoadError);
  expect(await exists(sentinel)).toBe(false);

  for (const key of ["toString", "constructor", "__proto__"]) {
    await writeText(
      join(packageRoot, "entry.ts"),
      `const value = require(${JSON.stringify(key)});\nexport default () => value;\n`,
    );
    let failure: unknown;
    try {
      const module = await createExtensionLoader().load(await entryFor());
      if (typeof module.default === "function") await (module.default as () => unknown)();
    } catch (error) {
      failure = error;
    }
    expect(failure, key).toBeInstanceOf(ExtensionLoadError);
  }
});

test("retains graph and failure cache boundaries", async () => {
  const badCounter = join(root, "bad-count");
  const goodCounter = join(root, "good-count");
  await writeText(join(packageRoot, "bad.ts"), `${countPrelude(badCounter)}export default 42;\n`);
  await writeText(
    join(packageRoot, "good.ts"),
    `${countPrelude(goodCounter)}export default () => "good";\n`,
  );

  const loader = createExtensionLoader();
  const badEntry = await entryFor("bad.ts");
  const first = loader.load(badEntry);
  const repeated = loader.load(badEntry);
  expect(repeated).toBe(first);
  await expect(first).rejects.toThrow(/default/u);
  await expect(repeated).rejects.toThrow(/default/u);
  expect(await counter(badCounter)).toBe(1);

  const good = await loader.load(await entryFor("good.ts"));
  expect((good.default as () => string)()).toBe("good");
  expect(await counter(goodCounter)).toBe(1);
});

test("keeps independent graphs for entries sharing dependencies", async () => {
  await writeText(join(packageRoot, "deps", "shared.ts"), 'export const value = "v1";\n');
  const source = 'import { value } from "./deps/shared.ts";\nexport default () => value;\n';
  await writeText(join(packageRoot, "a.ts"), source);
  await writeText(join(packageRoot, "b.ts"), source);

  const loader = createExtensionLoader();
  const aEntry = await entryFor("a.ts");
  const firstA = await loader.load(aEntry);
  expect((firstA.default as () => string)()).toBe("v1");

  await writeText(join(packageRoot, "deps", "shared.ts"), 'export const value = "v2";\n');
  const cachedA = await loader.load(aEntry);
  expect(cachedA).toBe(firstA);
  expect((cachedA.default as () => string)()).toBe("v1");

  const b = await loader.load(await entryFor("b.ts"));
  expect((b.default as () => string)()).toBe("v2");

  const freshA = await createExtensionLoader().load(aEntry);
  expect((freshA.default as () => string)()).toBe("v2");
});

test("keeps module metadata, TLA and computed relative imports", async () => {
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

  const module = await createExtensionLoader().load(await entryFor());
  const result = (await (module.default as () => Promise<Record<string, unknown>>)()) as {
    filename: string;
    dirname: string;
    metaURL: string;
    tla: number;
    computed: number;
  };
  expect(result.filename).toBe(metaPath);
  expect(result.dirname).toBe(dirname(metaPath));
  expect(result.metaURL).toBe(pathToFileURL(join(packageRoot, "deps", "meta.mjs")).href);
  expect(result.tla).toBe(17);
  expect(result.computed).toBe(19);
});

test("normalizes hostile error metadata", async () => {
  const secret = "hostile-secret-do-not-leak";
  const cases = [
    `const error = new Error("${secret}"); throw error;`,
    `const error = new Error("${secret}"); error.code = "ARBITRARY_CODE"; throw error;`,
    `const error = new Error("${secret}"); Object.defineProperty(error, "code", { get() { throw new Error("getter-${secret}"); } }); throw error;`,
    `const error = new Error("${secret}"); error.data = { secret: "${secret}" }; throw error;`,
  ];
  for (const source of cases) {
    await writeText(join(packageRoot, "entry.ts"), source);
    let failure: unknown;
    try {
      await createExtensionLoader().load(await entryFor());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ExtensionLoadError);
    const error = failure as Error & { cause?: unknown; data?: unknown };
    expect(error.message).toBe("Extension module failed to load");
    expect(error.message).not.toContain(secret);
    expect(error.cause).toBeUndefined();
    expect(error.data).toBeUndefined();
  }

  const counterPath = join(root, "execution-counter");
  await writeText(
    join(packageRoot, "entry.ts"),
    [
      countPrelude(counterPath),
      "export default function run() {",
      `  throw new (require("@pisces/core").ToolDeniedError)("denied");`,
      "}",
      "",
    ].join("\n"),
  );
  const module = await createExtensionLoader().load(await entryFor());
  let thrown: unknown;
  try {
    await (module.default as () => Promise<unknown>)();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(hostCore.ToolDeniedError);
  expect(await counter(counterPath)).toBe(1);
});

test("rejects unsupported formats through the loader", async () => {
  const addon = await buildNativeAddon();
  const sentinel = join(root, "native-sentinel");
  await mkdir(join(packageRoot, "deps"), { recursive: true });
  await copyFile(addon, join(packageRoot, "deps", "sentinel.node"));
  const nativeChild = await runProcess(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      "const addon = require(process.argv[1]); process.stdout.write(String(addon.sentinel));",
      join(packageRoot, "deps", "sentinel.node"),
    ],
    {
      cwd: packageRoot,
      env: { PISCES_EXTENSION_NATIVE_SENTINEL: sentinel },
      timeout: 30_000,
    },
  );
  expect(nativeChild.code, nativeChild.stderr).toBe(0);
  expect(nativeChild.stdout).toBe("native");
  expect(await readFile(sentinel, "utf8")).toBe("1");
  await rm(sentinel, { force: true });

  const rejected = ["suffixless", "module.wasm", "module.txt"];
  for (const name of rejected) {
    await writeText(
      join(packageRoot, "deps", name),
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
        'module.exports = "should-not-run";',
        "",
      ].join("\n"),
    );
  }
  for (const name of [...rejected, "sentinel.node"]) {
    await writeText(
      join(packageRoot, "entry.ts"),
      `const value = require(${JSON.stringify(`./deps/${name}`)});\nexport default () => value;\n`,
    );
    await expect(createExtensionLoader().load(await entryFor())).rejects.toThrow(
      "Unsupported extension module format",
    );
    expect(await exists(sentinel), name).toBe(false);
  }

  await writeText(join(packageRoot, "entry.json"), "module.exports = 1;\n");
  await expect(createExtensionLoader().load(await entryFor("entry.json"))).rejects.toThrow(
    "Unsupported extension module format",
  );

  await writeText(
    join(packageRoot, "entry.ts"),
    [
      'const fs = require("node:fs");',
      'const prefixed = require("node:fs");',
      "export default function run() {",
      "  return { bare: typeof fs.readFileSync, prefixed: typeof prefixed.readFileSync };",
      "}",
      "",
    ].join("\n"),
  );
  const control = await createExtensionLoader().load(await entryFor());
  expect((control.default as () => unknown)()).toEqual({ bare: "function", prefixed: "function" });
});

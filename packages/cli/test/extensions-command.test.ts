import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { CommandIo } from "../src/commands.js";
import { extensionsList } from "../src/extensions.js";
import { runCli } from "../src/main.js";

const INVALID_MESSAGE = "Invalid extension configuration";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Recorder {
  io: CommandIo;
  out: string[];
  err: string[];
}

function recorder(): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

// Top-level side effect proves whether listing imported the entry module.
function toolSource(sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export default async function run() {",
    '  return { content: [{ type: "text", text: "ran" }] };',
    "}",
    "",
  ].join("\n");
}

function wrapperSource(sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export default function createWrapper() {",
    "  return (tool) => tool;",
    "}",
    "",
  ].join("\n");
}

function contextSource(sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export default async function resolve() {",
    "  return [];",
    "}",
    "",
  ].join("\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function makePackage(
  root: string,
  name: string,
  files: Record<string, string>,
  manifest?: unknown,
): Promise<void> {
  const packageJson: Record<string, unknown> = { name };
  if (manifest !== undefined) packageJson.pisces = manifest;
  await writeJson(join(root, "package.json"), packageJson);
  for (const [relative, text] of Object.entries(files)) {
    await writeText(join(root, relative), text);
  }
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

interface Fixture {
  root: string;
  configPath: string;
  configDir: string;
  builtinDir: string;
  workspace: string;
  sentinel: string;
  io: Recorder;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-extensions-cmd-"));
  roots.push(root);
  const configDir = join(root, "config");
  const builtinDir = join(root, "builtin");
  const workspace = join(root, "workspace");
  await mkdir(configDir, { recursive: true });
  await mkdir(builtinDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return {
    root,
    configPath: join(configDir, "config.json"),
    configDir,
    builtinDir,
    workspace,
    sentinel: join(root, "sentinel.txt"),
    io: recorder(),
  };
}

const configExtensions = (fixtureRoot: Fixture, ...parts: string[]): string =>
  join(fixtureRoot.configDir, "extensions", ...parts);

const workspaceExtensions = (fixtureRoot: Fixture, ...parts: string[]): string =>
  join(fixtureRoot.workspace, ".pisces", "extensions", ...parts);

const firstColumn = (lines: readonly string[]): string[] =>
  lines.map((line) => line.split(/ +/)[0] ?? "");

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

test("lists builtin, config and workspace entries as aligned human rows", async () => {
  const fx = await fixture();
  await makePackage(join(fx.builtinDir, "built"), "builtin-pkg", {
    "tools/b.ts": toolSource(fx.sentinel),
  });
  await makePackage(configExtensions(fx, "cfg"), "config-pkg", {
    "tools/c.ts": toolSource(fx.sentinel),
  });
  await makePackage(workspaceExtensions(fx, "ws"), "workspace-pkg", {
    "skills/helper/SKILL.md": "Skill body\n",
  });

  const code = await extensionsList({
    configPath: fx.configPath,
    builtinDir: fx.builtinDir,
    workspace: fx.workspace,
    io: fx.io.io,
  });

  expect(code).toBe(0);
  expect(fx.io.err).toEqual([]);
  expect(fx.io.out.map((line) => line.split(/ +/))).toEqual([
    ["builtin-pkg#b", "tool", "builtin"],
    ["config-pkg#c", "tool", "config"],
    ["workspace-pkg#helper", "skill", "workspace"],
  ]);
  // Columns align: the name and type fields are padded to a common width.
  expect(fx.io.out).toEqual([
    "builtin-pkg#b        tool  builtin",
    "config-pkg#c         tool  config",
    "workspace-pkg#helper skill workspace",
  ]);
  expect(await exists(fx.sentinel)).toBe(false);
});

test("prints the sidecar description in human and JSON output", async () => {
  const fx = await fixture();
  await makePackage(configExtensions(fx, "cfg"), "config-pkg", {
    "tools/c.ts": toolSource(fx.sentinel),
  });
  await writeJson(join(configExtensions(fx, "cfg"), "tools/c.ts.meta.json"), {
    description: "config-tool",
  });

  expect(
    await extensionsList({
      configPath: fx.configPath,
      builtinDir: fx.builtinDir,
      io: fx.io.io,
    }),
  ).toBe(0);
  expect(fx.io.out).toEqual(["config-pkg#c tool config config-tool"]);

  fx.io.out.length = 0;
  expect(
    await extensionsList({
      configPath: fx.configPath,
      builtinDir: fx.builtinDir,
      json: true,
      io: fx.io.io,
    }),
  ).toBe(0);
  expect(JSON.parse(fx.io.out[0] ?? "")).toEqual({
    entries: [{ name: "config-pkg#c", type: "tool", origin: "config", description: "config-tool" }],
  });
});

test("lists tools, wrappers and context entries without executing their code", async () => {
  const fx = await fixture();
  await makePackage(configExtensions(fx, "pkg"), "pkg", {
    "tools/t.ts": toolSource(fx.sentinel),
    "wrappers/w.ts": wrapperSource(fx.sentinel),
    "context/c.ts": contextSource(fx.sentinel),
  });

  const code = await extensionsList({
    configPath: fx.configPath,
    builtinDir: fx.builtinDir,
    io: fx.io.io,
  });

  expect(code).toBe(0);
  expect(fx.io.out.map((line) => line.split(/ +/).slice(0, 2))).toEqual([
    ["pkg#c", "context"],
    ["pkg#t", "tool"],
    ["pkg#w", "wrapper"],
  ]);
  expect(await exists(fx.sentinel)).toBe(false);
});

test("ignores the workspace source and workspace config without --workspace", async () => {
  const fx = await fixture();
  await makePackage(configExtensions(fx, "cfg"), "config-pkg", {
    "tools/c.ts": toolSource(fx.sentinel),
  });
  await makePackage(workspaceExtensions(fx, "ws"), "workspace-pkg", {
    "tools/w.ts": toolSource(fx.sentinel),
  });
  // Malformed workspace config: reading it would fail the command.
  await writeText(join(fx.workspace, ".pisces", "config.json"), "{not json");

  const code = await extensionsList({
    configPath: fx.configPath,
    builtinDir: fx.builtinDir,
    io: fx.io.io,
  });

  expect(code).toBe(0);
  expect(fx.io.err).toEqual([]);
  expect(firstColumn(fx.io.out)).toEqual(["config-pkg#c"]);
  expect(await exists(fx.sentinel)).toBe(false);
});

test("an alternate --config file is read instead of <configDir>/config.json", async () => {
  const fx = await fixture();
  await makePackage(
    configExtensions(fx, "wrapped"),
    "wrapped",
    { "wrappers/w.ts": wrapperSource(fx.sentinel) },
    { wrappers: ["wrappers/w.ts"] },
  );
  const altPath = join(fx.configDir, "alt.json");
  // `config.json` is empty (valid); `alt.json` alone carries the bad key.
  await writeJson(fx.configPath, {});
  await writeJson(altPath, { entryConfig: { "wrapped#missing": {} } });

  expect(
    await extensionsList({ configPath: altPath, builtinDir: fx.builtinDir, io: fx.io.io }),
  ).toBe(2);
  expect(fx.io.out).toEqual([]);
  expect(fx.io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);

  // Reverse: only `config.json` is bad, so reading it would fail the command.
  await writeJson(fx.configPath, { entryConfig: { "wrapped#missing": {} } });
  await writeJson(altPath, {});
  fx.io.out.length = 0;
  fx.io.err.length = 0;

  expect(
    await extensionsList({ configPath: altPath, builtinDir: fx.builtinDir, io: fx.io.io }),
  ).toBe(0);
  expect(fx.io.err).toEqual([]);
  expect(firstColumn(fx.io.out)).toEqual(["wrapped#w"]);

  fx.io.out.length = 0;
  expect(
    await extensionsList({
      configPath: altPath,
      builtinDir: fx.builtinDir,
      json: true,
      io: fx.io.io,
    }),
  ).toBe(0);
  expect(JSON.parse(fx.io.out[0] ?? "")).toEqual({
    entries: [{ name: "wrapped#w", type: "wrapper", origin: "config" }],
  });

  // The workspace layer merges on top of the same exact global file.
  await writeJson(join(fx.workspace, ".pisces", "config.json"), {});
  fx.io.out.length = 0;
  expect(
    await extensionsList({
      configPath: altPath,
      builtinDir: fx.builtinDir,
      workspace: fx.workspace,
      io: fx.io.io,
    }),
  ).toBe(0);
  expect(fx.io.err).toEqual([]);
  expect(await exists(fx.sentinel)).toBe(false);
});

test("prints no extensions and exits 0 when nothing is discovered", async () => {
  const fx = await fixture();
  const code = await extensionsList({
    configPath: fx.configPath,
    builtinDir: fx.builtinDir,
    io: fx.io.io,
  });
  expect(code).toBe(0);
  expect(fx.io.out).toEqual(["no extensions"]);
  expect(fx.io.err).toEqual([]);
});

// ---------------------------------------------------------------------------
// failures and issues
// ---------------------------------------------------------------------------

test("a bad entryConfig exits 2 with a fixed message and no partial list", async () => {
  const fx = await fixture();
  await makePackage(
    configExtensions(fx, "wrapped"),
    "wrapped",
    { "wrappers/w.ts": wrapperSource(fx.sentinel) },
    { wrappers: ["wrappers/w.ts"] },
  );
  await writeJson(fx.configPath, { entryConfig: { "wrapped#missing": {} } });

  const code = await extensionsList({
    configPath: fx.configPath,
    builtinDir: fx.builtinDir,
    io: fx.io.io,
  });

  expect(code).toBe(2);
  expect(fx.io.out).toEqual([]);
  expect(fx.io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);
  expect(await exists(fx.sentinel)).toBe(false);
});

test("prints discovery issues to stderr without changing the exit code", async () => {
  const fx = await fixture();
  await makePackage(configExtensions(fx, "good"), "good-pkg", {
    "tools/g.ts": toolSource(fx.sentinel),
  });
  await writeText(join(configExtensions(fx, "broken"), "package.json"), "{not json");

  const code = await extensionsList({
    configPath: fx.configPath,
    builtinDir: fx.builtinDir,
    io: fx.io.io,
  });

  expect(code).toBe(0);
  expect(fx.io.err).toEqual(["extensions.invalid: broken"]);
  expect(firstColumn(fx.io.out)).toEqual(["good-pkg#g"]);
  expect(await exists(fx.sentinel)).toBe(false);
});

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

test("runCli dispatches extensions list with --config, --workspace and --json", async () => {
  const fx = await fixture();
  await makePackage(configExtensions(fx, "cfg"), "config-pkg", {
    "tools/c.ts": toolSource(fx.sentinel),
  });
  await makePackage(workspaceExtensions(fx, "ws"), "workspace-pkg", {
    "tools/w.ts": toolSource(fx.sentinel),
  });

  // No --builtin-dir flag: the repository built-in package is listed too.
  const code = await runCli(
    ["extensions", "list", "--config", fx.configPath, "--workspace", fx.workspace, "--json"],
    fx.io.io,
  );

  expect(code).toBe(0);
  const payload = JSON.parse(fx.io.out[0] ?? "") as {
    entries: { name: string; type: string; origin: string }[];
  };
  const names = payload.entries.map((entry) => entry.name);
  expect(names).toContain("config-pkg#c");
  expect(names).toContain("workspace-pkg#w");
  expect(payload.entries.find((entry) => entry.name === "config-pkg#c")?.origin).toBe("config");
  expect(payload.entries.find((entry) => entry.name === "workspace-pkg#w")?.origin).toBe(
    "workspace",
  );
  expect(payload.entries.some((entry) => entry.origin === "builtin")).toBe(true);
  expect(await exists(fx.sentinel)).toBe(false);
});

test("runCli rejects malformed extensions commands as usage errors", async () => {
  const io = recorder();
  for (const argv of [
    ["extensions"],
    ["extensions", "nope"],
    ["extensions", "list", "extra"],
    ["extensions", "list", "--nope"],
    ["extensions", "list", "--config"],
  ]) {
    expect(await runCli(argv, io.io), argv.join(" ")).toBe(2);
  }
  expect(io.out).toEqual([]);
  expect(io.err.length).toBe(5);
});

test("extensions --help prints the usage text", async () => {
  const io = recorder();
  expect(await runCli(["extensions", "--help"], io.io)).toBe(0);
  expect(io.out.join("\n")).toContain("extensions");
});

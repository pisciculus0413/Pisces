import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { CommandIo } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import {
  type ConfigCommandDeps,
  configGet,
  configList,
  configSet,
  configUnset,
} from "../src/config-commands.js";
import { runCli, USAGE } from "../src/main.js";

const KEY_ENV = "PISCES_TASK2_CONFIG_KEY";
const SECRET = "sk-task2-secret-value";

const INVALID_MESSAGE = "Invalid configuration";
const UNKNOWN_KEY_MESSAGE = "Unknown configuration key";
const KEY_NOT_FOUND_MESSAGE = "Configuration key not found";
const NO_WORKSPACE_MESSAGE = "No workspace directory";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  delete process.env[KEY_ENV];
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

interface Fixture {
  root: string;
  configPath: string;
  io: Recorder;
  deps: ConfigCommandDeps;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-config-cmd-"));
  roots.push(root);
  return {
    root,
    configPath: join(root, "config.json"),
    io: recorder(),
    deps: { cwd: root },
  };
}

const providers = [
  {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: KEY_ENV,
    models: [
      { id: "m1", contextWindow: 128_000, maxOutput: 16_384, modalities: ["text"] },
      { id: "m2", contextWindow: 8_000, maxOutput: 1_000, modalities: ["text"] },
    ],
  },
];

const fullConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  dataDir: "/tmp/pisces-data",
  providers,
  defaults: { provider: "openai", model: "m1" },
  ...overrides,
});

async function writeConfig(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list treats a missing file as an empty object", async () => {
  const { configPath, io, deps } = await fixture();
  expect(await configList({ configPath, io: io.io }, deps)).toBe(0);
  expect(io.out).toEqual(["{}"]);

  io.out.length = 0;
  expect(await configList({ configPath, io: io.io, json: true }, deps)).toBe(0);
  expect(io.out).toEqual(["{}"]);
});

test("list prints sorted, indented JSON in human mode and raw JSON otherwise", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, { b: 1, a: { z: 1, y: 2 } });

  expect(await configList({ configPath, io: io.io }, deps)).toBe(0);
  expect(io.out).toEqual(['{\n  "a": {\n    "y": 2,\n    "z": 1\n  },\n  "b": 1\n}']);

  io.out.length = 0;
  expect(await configList({ configPath, io: io.io, json: true }, deps)).toBe(0);
  expect(io.out.length).toBe(1);
  expect(JSON.parse(io.out[0] ?? "")).toEqual({ b: 1, a: { z: 1, y: 2 } });
});

test("list never reveals environment credential values", async () => {
  const { configPath, io, deps } = await fixture();
  process.env[KEY_ENV] = SECRET;
  await writeConfig(configPath, fullConfig());
  expect(await configList({ configPath, io: io.io, json: true }, deps)).toBe(0);
  expect(io.out.join("\n")).toContain(KEY_ENV);
  expect(io.out.join("\n")).not.toContain(SECRET);
});

test("list includes the global defaultWorkspace", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig({ defaultWorkspace: "/tmp/pisces-ws" }));

  expect(await configList({ configPath, io: io.io, json: true }, deps)).toBe(0);
  expect(JSON.parse(io.out[0] ?? "")).toMatchObject({ defaultWorkspace: "/tmp/pisces-ws" });
});

test("list of a missing workspace file is an empty object", async () => {
  const { root, io, deps } = await fixture();
  expect(
    await configList(
      { configPath: join(root, "config.json"), scope: "workspace", workspace: root, io: io.io },
      deps,
    ),
  ).toBe(0);
  expect(io.out).toEqual(["{}"]);
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

test("get prints scalars raw and objects as sorted JSON", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());

  expect(await configGet({ configPath, io: io.io, path: "providers.0.apiKeyEnv" }, deps)).toBe(0);
  expect(io.out).toEqual([KEY_ENV]);

  io.out.length = 0;
  expect(await configGet({ configPath, io: io.io, path: "defaults" }, deps)).toBe(0);
  expect(io.out).toEqual(['{\n  "model": "m1",\n  "provider": "openai"\n}']);

  io.out.length = 0;
  expect(await configGet({ configPath, io: io.io, path: "defaults", json: true }, deps)).toBe(0);
  expect(JSON.parse(io.out[0] ?? "")).toEqual({ provider: "openai", model: "m1" });
});

test("get of a missing path exits 1 with config.key_not_found", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());
  expect(await configGet({ configPath, io: io.io, path: "providers.5" }, deps)).toBe(1);
  expect(io.out).toEqual([]);
  expect(io.err).toEqual([`error: config.key_not_found: ${KEY_NOT_FOUND_MESSAGE}`]);
});

// ---------------------------------------------------------------------------
// set / unset
// ---------------------------------------------------------------------------

test("set parses the value as JSON and the result loads through loadConfig", async () => {
  const { configPath, io, deps } = await fixture();
  expect(
    await configSet({ configPath, io: io.io, path: "dataDir", value: '"/tmp/data"' }, deps),
  ).toBe(0);
  expect(
    await configSet(
      { configPath, io: io.io, path: "providers", value: JSON.stringify(providers) },
      deps,
    ),
  ).toBe(0);
  expect(
    await configSet(
      { configPath, io: io.io, path: "defaults", value: '{"provider":"openai","model":"m1"}' },
      deps,
    ),
  ).toBe(0);

  const config = await loadConfig(configPath);
  expect(config.dataDir).toBe("/tmp/data");
  expect(config.providers[0]?.id).toBe("openai");
  expect(config.defaults).toEqual({ provider: "openai", model: "m1" });
});

test("set requires a JSON value and never writes an invalid one", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());
  const before = await readFile(configPath, "utf8");

  expect(
    await configSet({ configPath, io: io.io, path: "dataDir", value: "bare-word" }, deps),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);
  expect(await readFile(configPath, "utf8")).toBe(before);
});

test("set of a malformed providers shape fails and leaves the file unchanged", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());
  const before = await readFile(configPath, "utf8");

  expect(
    await configSet({ configPath, io: io.io, path: "providers", value: '[{"id":"broken"}]' }, deps),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);
  expect(await readFile(configPath, "utf8")).toBe(before);
});

test("set rejects a dangling defaults reference while providers exist", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());
  const before = await readFile(configPath, "utf8");

  expect(
    await configSet({ configPath, io: io.io, path: "defaults.model", value: '"missing"' }, deps),
  ).toBe(2);
  expect(await readFile(configPath, "utf8")).toBe(before);
});

test("set and unset accept the tilde paths that loadConfig expands", async () => {
  const { root, configPath, io, deps } = await fixture();
  const home = join(root, "home");
  vi.stubEnv("HOME", home);
  await writeConfig(configPath, fullConfig({ dataDir: "~/state", templatesDir: "~/templates" }));

  // The loader already accepts the raw draft, so every edit must accept it too.
  const loaded = await loadConfig(configPath);
  expect(loaded.dataDir).toBe(join(home, "state"));
  expect(loaded.templatesDir).toBe(join(home, "templates"));

  expect(
    await configSet(
      { configPath, io: io.io, path: "providers.0.models.0.maxOutput", value: "8192" },
      deps,
    ),
  ).toBe(0);
  expect(io.err).toEqual([]);
  // The written file keeps the raw `~`, exactly as hand-written.
  const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  expect(written.dataDir).toBe("~/state");
  expect(written.templatesDir).toBe("~/templates");

  expect(await configUnset({ configPath, io: io.io, path: "templatesDir" }, deps)).toBe(0);
  const afterUnset = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  expect(afterUnset.templatesDir).toBeUndefined();
  expect(afterUnset.dataDir).toBe("~/state");
});

test("set still rejects a relative dataDir and a tilde path without HOME", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());
  const before = await readFile(configPath, "utf8");

  expect(
    await configSet({ configPath, io: io.io, path: "dataDir", value: '"relative/state"' }, deps),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);
  expect(await readFile(configPath, "utf8")).toBe(before);

  io.err.length = 0;
  vi.stubEnv("HOME", "");
  expect(
    await configSet({ configPath, io: io.io, path: "templatesDir", value: '"~/tpl"' }, deps),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);
  expect(await readFile(configPath, "utf8")).toBe(before);
});

test("unset removes the path, re-validates and rewrites atomically", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());

  expect(await configUnset({ configPath, io: io.io, path: "defaults" }, deps)).toBe(0);
  const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  expect(written.defaults).toBeUndefined();
  expect(written.dataDir).toBe("/tmp/pisces-data");
  expect((await stat(configPath)).mode & 0o777).toBe(0o600);
});

test("unset of a missing path exits 1 with config.key_not_found", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, fullConfig());
  const before = await readFile(configPath, "utf8");
  expect(await configUnset({ configPath, io: io.io, path: "templatesDir" }, deps)).toBe(1);
  expect(io.err).toEqual([`error: config.key_not_found: ${KEY_NOT_FOUND_MESSAGE}`]);
  expect(await readFile(configPath, "utf8")).toBe(before);
});

test("unset that would leave an invalid document fails and leaves the file unchanged", async () => {
  const { configPath, io, deps } = await fixture();
  await writeConfig(configPath, { dataDir: "/tmp/pisces-data", providers });
  const before = await readFile(configPath, "utf8");

  expect(await configUnset({ configPath, io: io.io, path: "providers.0.models.0" }, deps)).toBe(0);
  const afterFirst = await readFile(configPath, "utf8");
  expect(afterFirst).not.toBe(before);

  // Removing the last model leaves an empty list, which the draft validator rejects.
  expect(await configUnset({ configPath, io: io.io, path: "providers.0.models.0" }, deps)).toBe(2);
  expect(io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);
  expect(await readFile(configPath, "utf8")).toBe(afterFirst);
});

// ---------------------------------------------------------------------------
// workspace scope
// ---------------------------------------------------------------------------

test("workspace scope writes <workspace>/.pisces/config.json with private modes", async () => {
  const { root, io, deps } = await fixture();
  const workspace = join(root, "notes");
  await mkdir(workspace);

  expect(
    await configSet(
      {
        configPath: join(root, "config.json"),
        scope: "workspace",
        workspace,
        io: io.io,
        path: "defaults",
        value: '{"provider":"p","model":"m"}',
      },
      deps,
    ),
  ).toBe(0);

  const path = join(workspace, ".pisces", "config.json");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    defaults: { provider: "p", model: "m" },
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(workspace, ".pisces"))).mode & 0o777).toBe(0o700);
});

test("workspace defaults validate against readable global providers", async () => {
  const { root, configPath, io, deps } = await fixture();
  const workspace = join(root, "notes");
  await mkdir(workspace);
  await writeConfig(configPath, fullConfig());

  expect(
    await configSet(
      {
        configPath,
        scope: "workspace",
        workspace,
        io: io.io,
        path: "defaults",
        value: '{"provider":"openai","model":"m2"}',
      },
      deps,
    ),
  ).toBe(0);

  io.err.length = 0;
  expect(
    await configSet(
      {
        configPath,
        scope: "workspace",
        workspace,
        io: io.io,
        path: "defaults",
        value: '{"provider":"openai","model":"missing"}',
      },
      deps,
    ),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.invalid: ${INVALID_MESSAGE}`]);
});

test("workspace scope rejects global-only keys with config.unknown_key", async () => {
  const { root, configPath, io, deps } = await fixture();
  const workspace = join(root, "notes");
  await mkdir(workspace);

  expect(
    await configSet(
      {
        configPath,
        scope: "workspace",
        workspace,
        io: io.io,
        path: "defaultWorkspace",
        value: '"/tmp/x"',
      },
      deps,
    ),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.unknown_key: ${UNKNOWN_KEY_MESSAGE}`]);
});

test("workspace scope without a usable directory exits 2 with config.no_workspace", async () => {
  const { root, configPath, io, deps } = await fixture();

  expect(
    await configList(
      { configPath, scope: "workspace", io: io.io },
      { cwd: join(root, "does-not-exist") },
    ),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.no_workspace: ${NO_WORKSPACE_MESSAGE}`]);

  io.err.length = 0;
  expect(
    await configList(
      { configPath, scope: "workspace", workspace: join(root, "nope"), io: io.io },
      deps,
    ),
  ).toBe(2);
  expect(io.err).toEqual([`error: config.no_workspace: ${NO_WORKSPACE_MESSAGE}`]);
});

test("workspace scope falls back to the current directory", async () => {
  const { root, configPath, io } = await fixture();
  const workspace = join(root, "cwd-ws");
  await mkdir(workspace);
  expect(await configList({ configPath, scope: "workspace", io: io.io }, { cwd: workspace })).toBe(
    0,
  );
  expect(io.out).toEqual(["{}"]);
});

// ---------------------------------------------------------------------------
// main dispatch
// ---------------------------------------------------------------------------

test("runCli dispatches config list/get with --config and --json", async () => {
  const { configPath, io } = await fixture();
  await writeConfig(configPath, fullConfig());

  expect(await runCli(["config", "list", "--json", "--config", configPath], io.io)).toBe(0);
  expect(JSON.parse(io.out[0] ?? "")).toEqual(fullConfig());

  io.out.length = 0;
  expect(await runCli(["config", "get", "defaults.provider", "--config", configPath], io.io)).toBe(
    0,
  );
  expect(io.out).toEqual(["openai"]);
});

test("runCli dispatches config set/unset and writes the file", async () => {
  const { configPath, io } = await fixture();
  await writeConfig(configPath, fullConfig());

  expect(
    await runCli(["config", "set", "templatesDir", '"/tmp/tpl"', "--config", configPath], io.io),
  ).toBe(0);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    templatesDir: "/tmp/tpl",
  });

  expect(await runCli(["config", "unset", "templatesDir", "--config", configPath], io.io)).toBe(0);
  const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  expect(written.templatesDir).toBeUndefined();
});

test("runCli reports config.key_not_found as exit 1", async () => {
  const { configPath, io } = await fixture();
  await writeConfig(configPath, fullConfig());
  expect(await runCli(["config", "get", "nope", "--config", configPath], io.io)).toBe(1);
  expect(io.err).toEqual([`error: config.key_not_found: ${KEY_NOT_FOUND_MESSAGE}`]);
});

test("runCli rejects config usage errors with exit 2", async () => {
  const { root, configPath, io } = await fixture();
  await writeConfig(configPath, fullConfig());

  const usage: string[][] = [
    ["config"],
    ["config", "bogus"],
    ["config", "get"],
    ["config", "set", "dataDir"],
    ["config", "list", "--scope", "sideways", "--config", configPath],
    ["config", "list", "--workspace", root, "--config", configPath],
    ["config", "set", "dataDir", '"/tmp/x"', "--json", "--config", configPath],
  ];
  for (const argv of usage) {
    io.err.length = 0;
    expect(await runCli(argv, io.io)).toBe(2);
    expect(io.err).toEqual([USAGE]);
  }
});

test("runCli accepts --scope workspace with --workspace", async () => {
  const { root, configPath, io } = await fixture();
  const workspace = join(root, "ws");
  await mkdir(workspace);
  expect(
    await runCli(
      [
        "config",
        "set",
        "extensions",
        "[]",
        "--scope",
        "workspace",
        "--workspace",
        workspace,
        "--config",
        configPath,
      ],
      io.io,
    ),
  ).toBe(0);
  expect(await readFile(join(workspace, ".pisces", "config.json"), "utf8")).toContain(
    '"extensions"',
  );
});

test("runCli --help still prints usage for config", async () => {
  const { io } = await fixture();
  expect(await runCli(["config", "--help"], io.io)).toBe(0);
  expect(io.out).toEqual([USAGE]);
});

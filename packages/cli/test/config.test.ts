import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiscesError } from "@pisces/core";
import { afterEach, expect, test, vi } from "vitest";
import { defaultConfigPath, defaultDataDir, loadConfig, parseConfig } from "../src/config.js";

const INVALID = "Invalid configuration";

type Raw = Record<string, unknown>;

const model = (overrides: Raw = {}): Raw => ({
  id: "m",
  contextWindow: 128_000,
  maxOutput: 16_384,
  modalities: ["text"],
  ...overrides,
});

const provider = (overrides: Raw = {}): Raw => ({
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  models: [model()],
  ...overrides,
});

const raw = (overrides: Raw = {}): Raw => ({
  dataDir: "/tmp/pisces",
  providers: [provider()],
  ...overrides,
});

function expectInvalid(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect((error as PiscesError).code).toBe("config.invalid");
    expect((error as PiscesError).message).toBe(INVALID);
    return;
  }
  throw new Error("expected config.invalid");
}

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pisces-cli-config-"));
  dirs.push(dir);
  return dir;
}

test("accepts a valid config and rejects unknown keys and unresolved defaults", () => {
  const valid = parseConfig(raw({ defaults: { provider: "openai", model: "m" } }));
  expect(valid.providers[0]?.id).toBe("openai");
  expect(valid.providers[0]?.models[0]?.modalities).toEqual(["text"]);
  expect(valid.defaults).toEqual({ provider: "openai", model: "m" });
  expectInvalid(() => parseConfig(raw({ extra: true })));
  expectInvalid(() => parseConfig(raw({ defaults: { provider: "openai", model: "missing" } })));
});

test("defaults are optional", () => {
  const valid = parseConfig(raw());
  expect(valid.defaults).toBeUndefined();
});

test("rejects unknown keys at provider and model level", () => {
  expectInvalid(() => parseConfig(raw({ providers: [provider({ extra: true })] })));
  expectInvalid(() =>
    parseConfig(raw({ providers: [provider({ models: [model({ extra: true })] })] })),
  );
});

test("requires provider id, baseUrl and models", () => {
  expectInvalid(() => parseConfig(raw({ providers: [provider({ id: undefined })] })));
  expectInvalid(() => parseConfig(raw({ providers: [provider({ baseUrl: undefined })] })));
  expectInvalid(() => parseConfig(raw({ providers: [provider({ models: undefined })] })));
  expectInvalid(() => parseConfig(raw({ providers: [provider({ models: [] })] })));
});

test("rejects duplicate provider ids and duplicate model ids", () => {
  expectInvalid(() => parseConfig(raw({ providers: [provider(), provider()] })));
  expectInvalid(() => parseConfig(raw({ providers: [provider({ models: [model(), model()] })] })));
});

test("requires every model field", () => {
  expectInvalid(() =>
    parseConfig(raw({ providers: [provider({ models: [model({ contextWindow: undefined })] })] })),
  );
  expectInvalid(() =>
    parseConfig(raw({ providers: [provider({ models: [model({ maxOutput: undefined })] })] })),
  );
  expectInvalid(() =>
    parseConfig(raw({ providers: [provider({ models: [model({ modalities: undefined })] })] })),
  );
  expectInvalid(() =>
    parseConfig(raw({ providers: [provider({ models: [model({ modalities: [] })] })] })),
  );
  expectInvalid(() =>
    parseConfig(raw({ providers: [provider({ models: [model({ modalities: ["video"] })] })] })),
  );
});

test("rejects non-positive, non-integer and non-finite model limits", () => {
  for (const value of [0, -1, 1.5, "128000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    expectInvalid(() =>
      parseConfig(raw({ providers: [provider({ models: [model({ contextWindow: value })] })] })),
    );
    expectInvalid(() =>
      parseConfig(raw({ providers: [provider({ models: [model({ maxOutput: value })] })] })),
    );
  }
});

test("requires a valid environment variable name", () => {
  for (const apiKeyEnv of ["", "1BAD", "BAD-KEY", "WITH SPACE", 42]) {
    expectInvalid(() => parseConfig(raw({ providers: [provider({ apiKeyEnv })] })));
  }
  const valid = parseConfig(raw({ providers: [provider({ apiKeyEnv: "_KEY_2" })] }));
  expect(valid.providers[0]?.apiKeyEnv).toBe("_KEY_2");
});

test("rejects invalid base urls", () => {
  for (const baseUrl of [
    "https://user:secret@example.com/v1",
    "https://user@example.com/v1",
    "https://example.com/v1?x=1",
    "https://example.com/v1#fragment",
    "ftp://example.com/v1",
    "example.com/v1",
    "",
    42,
  ]) {
    expectInvalid(() => parseConfig(raw({ providers: [provider({ baseUrl })] })));
  }
  const valid = parseConfig(
    raw({ providers: [provider({ baseUrl: "http://localhost:8080/v1" })] }),
  );
  expect(valid.providers[0]?.baseUrl).toBe("http://localhost:8080/v1");
});

test("keeps optional headers and rejects malformed ones", () => {
  const valid = parseConfig(raw({ providers: [provider({ headers: { "x-org": "pisces" } })] }));
  expect(valid.providers[0]?.headers).toEqual({ "x-org": "pisces" });
  expect(valid.providers[0]?.headers).not.toBeUndefined();
  expectInvalid(() => parseConfig(raw({ providers: [provider({ headers: { a: 1 } })] })));
  expectInvalid(() => parseConfig(raw({ providers: [provider({ headers: "a: b" })] })));
});

test("rejects header names and values containing control characters", () => {
  const injectionValues = ["a\r\nX-Injected: 1", "a\nb", "a\rb", "a\u0000b", "a\u007fb"];
  for (const value of injectionValues) {
    expectInvalid(() =>
      parseConfig(raw({ providers: [provider({ headers: { "x-org": value } })] })),
    );
  }
  const injectionNames = ["x-org\r\nX-Injected", "x\u0000org", "x\u007forg", "", "   "];
  for (const name of injectionNames) {
    expectInvalid(() =>
      parseConfig(raw({ providers: [provider({ headers: { [name]: "value" } })] })),
    );
  }
  expectInvalid(() =>
    parseConfig(raw({ providers: [provider({ headers: { "x-org": "tab\there" } })] })),
  );
});

test("accepts a simple Authorization header", () => {
  const valid = parseConfig(
    raw({
      providers: [
        provider({ headers: { Authorization: "Bearer sk-test-123", "content-type": "a/b" } }),
      ],
    }),
  );
  expect(valid.providers[0]?.headers).toEqual({
    Authorization: "Bearer sk-test-123",
    "content-type": "a/b",
  });
});

test("requires an absolute dataDir", () => {
  expectInvalid(() => parseConfig(raw({ dataDir: "relative/path" })));
  expectInvalid(() => parseConfig(raw({ dataDir: "~/.local/state/pisces" })));
  expectInvalid(() => parseConfig(raw({ dataDir: undefined })));
});

test("rejects defaults that do not resolve to a declared provider and model", () => {
  expectInvalid(() => parseConfig(raw({ defaults: { provider: "missing", model: "m" } })));
  expectInvalid(() => parseConfig(raw({ defaults: { provider: "openai", model: "missing" } })));
  expectInvalid(() => parseConfig(raw({ defaults: { provider: "openai" } })));
  expectInvalid(() => parseConfig(raw({ defaults: { provider: "openai", model: "m", x: 1 } })));
});

test("rejects malformed top-level shapes", () => {
  for (const value of [null, [], "config", 1]) {
    expectInvalid(() => parseConfig(value));
  }
  expectInvalid(() => parseConfig(raw({ providers: [] })));
  expectInvalid(() => parseConfig(raw({ providers: "openai" })));
});

test("loadConfig reads a valid file", async () => {
  const dir = await tempDir();
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(raw({ defaults: { provider: "openai", model: "m" } })));
  const config = await loadConfig(path);
  expect(config.dataDir).toBe("/tmp/pisces");
  expect(config.defaults).toEqual({ provider: "openai", model: "m" });
});

test("loadConfig maps missing files and malformed json to config.invalid", async () => {
  const dir = await tempDir();
  await expect(loadConfig(join(dir, "missing.json"))).rejects.toMatchObject({
    code: "config.invalid",
    message: INVALID,
  });
  const path = join(dir, "broken.json");
  await writeFile(path, "{not json");
  await expect(loadConfig(path)).rejects.toMatchObject({
    code: "config.invalid",
    message: INVALID,
  });
});

test("loadConfig defaults dataDir from XDG_STATE_HOME", async () => {
  const dir = await tempDir();
  vi.stubEnv("HOME", "/home/tester");
  vi.stubEnv("XDG_STATE_HOME", "/xdg/state");
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ providers: [provider()] }));
  const config = await loadConfig(path);
  expect(config.dataDir).toBe("/xdg/state/pisces");
});

test("loadConfig defaults dataDir from HOME and expands a leading tilde", async () => {
  const dir = await tempDir();
  vi.stubEnv("HOME", "/home/tester");
  vi.stubEnv("XDG_STATE_HOME", "");
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ providers: [provider()] }));
  expect((await loadConfig(path)).dataDir).toBe("/home/tester/.local/state/pisces");

  const tildePath = join(dir, "tilde.json");
  await writeFile(tildePath, JSON.stringify(raw({ dataDir: "~/state/pisces" })));
  expect((await loadConfig(tildePath)).dataDir).toBe("/home/tester/state/pisces");
});

test("loadConfig rejects a leading tilde without HOME", async () => {
  const dir = await tempDir();
  vi.stubEnv("HOME", "");
  vi.stubEnv("XDG_STATE_HOME", "");
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(raw({ dataDir: "~/state/pisces" })));
  await expect(loadConfig(path)).rejects.toMatchObject({ code: "config.invalid" });

  const noDataDir = join(dir, "no-data-dir.json");
  await writeFile(noDataDir, JSON.stringify({ providers: [provider()] }));
  await expect(loadConfig(noDataDir)).rejects.toMatchObject({ code: "config.invalid" });
});

test("defaultDataDir and defaultConfigPath honour XDG variables then HOME", () => {
  expect(defaultDataDir({ XDG_STATE_HOME: "/xdg/state", HOME: "/home/t" })).toBe(
    "/xdg/state/pisces",
  );
  expect(defaultDataDir({ HOME: "/home/t" })).toBe("/home/t/.local/state/pisces");
  expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg/config", HOME: "/home/t" })).toBe(
    "/xdg/config/pisces/config.json",
  );
  expect(defaultConfigPath({ HOME: "/home/t" })).toBe("/home/t/.config/pisces/config.json");
  expectInvalid(() => defaultDataDir({}));
  expectInvalid(() => defaultConfigPath({}));
});

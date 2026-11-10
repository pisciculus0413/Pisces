import { resolve } from "node:path";
import { PiscesError } from "@pisces/core";
import { afterEach, expect, test, vi } from "vitest";
import { buildDaemonOptions, buildProviders } from "../src/assembly.js";
import type { CliConfig, CliProviderConfig } from "../src/config.js";
import { createEnvCredentials } from "../src/credentials.js";

const CONFIG_PATH = "/tmp/pisces-config/config.json";

const OPENAI: CliProviderConfig = {
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  models: [{ id: "gpt", contextWindow: 128_000, maxOutput: 16_384, modalities: ["text"] }],
};

function config(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    dataDir: "/tmp/pisces-config",
    providers: [OPENAI],
    ...overrides,
  };
}

async function expectRefreshRejected(credentials: {
  refresh(ref: string): Promise<unknown>;
}): Promise<void> {
  try {
    await credentials.refresh("openai");
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect((error as PiscesError).code).toBe("provider.credentials_unavailable");
    expect((error as PiscesError).message).toBe("Credentials could not be refreshed");
    return;
  }
  throw new Error("expected provider.credentials_unavailable");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("registers openai-chat providers and reads only the named env var", async () => {
  const options = buildDaemonOptions(
    config(),
    "/tmp/pisces",
    { OPENAI_API_KEY: "sk-test" },
    {
      configPath: CONFIG_PATH,
    },
  );
  const descriptor = options.providers.get("openai");
  expect(descriptor).toMatchObject({
    dialect: "openai-chat",
    auth: { type: "apiKey", credentialRef: "openai" },
  });
  expect(options.providers.list()).toHaveLength(1);
  expect(options.providerHost).toBeDefined();
  const credentials = createEnvCredentials(config(), { OPENAI_API_KEY: "sk-test" });
  expect((await credentials.get("openai"))?.value).toBe("sk-test");
  expect(await credentials.get("other")).toBeUndefined();
});

test("registers the openai-chat dialect so an adapter can be created", () => {
  const providers = buildProviders(config());
  const adapter = providers.createAdapter("openai");
  expect(adapter.dialect).toBe("openai-chat");
  expect(typeof adapter.buildRequest).toBe("function");
});

test("copies provider headers only when present", () => {
  const withHeaders = buildProviders(
    config({
      providers: [{ ...OPENAI, headers: { "x-tenant": "acme" } }],
    }),
  );
  expect(withHeaders.get("openai")?.headers).toEqual({ "x-tenant": "acme" });
  const withoutHeaders = buildProviders(config());
  expect(withoutHeaders.get("openai")).not.toHaveProperty("headers");
});

test("missing or empty env var yields no credential and refresh rejects", async () => {
  const missing = createEnvCredentials(config(), {});
  expect(await missing.get("openai")).toBeUndefined();
  await expectRefreshRejected(missing);

  const empty = createEnvCredentials(config(), { OPENAI_API_KEY: "" });
  expect(await empty.get("openai")).toBeUndefined();
});

test("never reads process.env itself", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-process");
  const credentials = createEnvCredentials(config(), {});
  expect(await credentials.get("openai")).toBeUndefined();
});

test("dataDir override wins and defaults stay out of the options", () => {
  const options = buildDaemonOptions(
    config({ defaults: { provider: "openai", model: "gpt" } }),
    "/tmp/pisces-override",
    { OPENAI_API_KEY: "sk-test" },
    { configPath: CONFIG_PATH },
  );
  expect(options.dataDir).toBe("/tmp/pisces-override");
  // Manual defaults are mutually exclusive with extension mode; the daemon reads
  // the same values from the config file on every `session.create` instead.
  expect(options).not.toHaveProperty("defaults");
});

test("always assembles extensions from the config path, even with defaults", () => {
  const options = buildDaemonOptions(
    config({
      defaultWorkspace: "/tmp/workspace",
      defaults: { provider: "openai", model: "gpt" },
    }),
    "/tmp/pisces",
    {},
    { configPath: CONFIG_PATH },
  );
  expect(options.extensions).toEqual({ configPath: CONFIG_PATH });
});

test("absolutizes a relative config path", () => {
  const relative = "nested/config.json";
  const options = buildDaemonOptions(config(), "/tmp/pisces", {}, { configPath: relative });
  expect(options.extensions?.configPath).toBe(resolve(relative));
  expect(resolve(relative).startsWith("/")).toBe(true);
});

test("forwards templates from the explicit directory", () => {
  const options = buildDaemonOptions(
    config({ templatesDir: "/tmp/config-templates" }),
    "/tmp/pisces",
    {},
    { configPath: CONFIG_PATH, templatesDir: "/tmp/templates" },
  );
  expect(options.templates).toEqual({ configDir: "/tmp/templates" });
});

test("falls back to the configured templates directory", () => {
  const options = buildDaemonOptions(
    config({ templatesDir: "/tmp/templates" }),
    "/tmp/pisces",
    {},
    { configPath: CONFIG_PATH },
  );
  expect(options.templates).toEqual({ configDir: "/tmp/templates" });
});

test("omits templates when neither source defines one", () => {
  const options = buildDaemonOptions(config(), "/tmp/pisces", {}, { configPath: CONFIG_PATH });
  expect(options).not.toHaveProperty("templates");
});

test("returns only StartDaemonOptions keys", () => {
  const options = buildDaemonOptions(
    config({ defaults: { provider: "openai", model: "gpt" } }),
    "/tmp/pisces",
    { OPENAI_API_KEY: "sk-test" },
    { configPath: CONFIG_PATH },
  );
  expect(Object.keys(options).sort()).toEqual([
    "dataDir",
    "extensions",
    "providerHost",
    "providers",
  ]);
});

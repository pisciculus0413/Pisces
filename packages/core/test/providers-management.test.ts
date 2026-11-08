import { expect, test } from "vitest";
import {
  createProviderManagement,
  type LlmAdapter,
  type ModelDescriptor,
  PiscesError,
  type ProviderDescriptor,
} from "../src/index.js";

function model(id = "m"): ModelDescriptor {
  return {
    id,
    contextWindow: 100_000,
    maxOutput: 4_000,
    modalities: ["text"],
    pricing: { input: 1, output: 2, currency: "USD" },
  };
}

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: "p",
    dialect: "d",
    baseUrl: "https://example.test/v1",
    auth: { type: "apiKey", credentialRef: "default" },
    headers: { "x-provider": "value" },
    models: [model()],
    ...overrides,
  };
}

function fakeAdapter(): LlmAdapter {
  return {
    dialect: "d",
    buildRequest: () => ({ path: "/", body: "{}" }),
    parseChunk: () => [],
  };
}

function expectInvalid(run: () => unknown): void {
  try {
    run();
    expect.unreachable("expected provider configuration to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    expect(error).toMatchObject({
      code: "config.invalid",
      message: "Invalid provider configuration",
      cause: undefined,
    });
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture");
  return value;
}

test("rejects duplicate provider ids and duplicate model ids with a safe config error", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor());

  expectInvalid(() => providers.registerProvider(descriptor()));
  expectInvalid(() =>
    createProviderManagement().registerProvider(descriptor({ models: [model("m"), model("m")] })),
  );
});

test("registers a provider with no models", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor({ id: "empty", models: [] }));

  expect(providers.list()).toEqual([expect.objectContaining({ id: "empty", models: [] })]);
  expect(providers.select("empty", "missing")).toBeUndefined();
});

test("allows empty modalities and rejects unknown modalities", () => {
  const providers = createProviderManagement();
  providers.registerProvider(
    descriptor({
      models: [{ ...model(), modalities: [] }],
    }),
  );
  expect(providers.select("p", "m")?.model.modalities).toEqual([]);

  expectInvalid(() =>
    createProviderManagement().registerProvider(
      descriptor({
        models: [
          {
            ...model(),
            modalities: ["video"] as unknown as ModelDescriptor["modalities"],
          },
        ],
      }),
    ),
  );
});

test("rejects invalid provider descriptors with a fixed safe error", () => {
  const invalid: [string, ProviderDescriptor][] = [
    ["empty id", descriptor({ id: "" })],
    ["empty dialect", descriptor({ dialect: " " })],
    ["relative base URL", descriptor({ baseUrl: "/relative" })],
    ["non-HTTP base URL", descriptor({ baseUrl: "ftp://example.test/v1" })],
    ["credential-bearing base URL", descriptor({ baseUrl: "https://user:secret@example.test/v1" })],
    ["base URL query", descriptor({ baseUrl: "https://example.test/v1?token=secret" })],
    ["base URL fragment", descriptor({ baseUrl: "https://example.test/v1#fragment" })],
    ["empty credential reference", descriptor({ auth: { type: "apiKey", credentialRef: "" } })],
    ["header value injection", descriptor({ headers: { "x-safe": "line\nbreak" } })],
    ["header name injection", descriptor({ headers: { "x\nunsafe": "value" } })],
    ["empty model id", descriptor({ models: [model("")] })],
    [
      "zero context window",
      descriptor({
        models: [{ ...model(), contextWindow: 0 }],
      }),
    ],
    [
      "non-finite max output",
      descriptor({
        models: [{ ...model(), maxOutput: Number.NaN }],
      }),
    ],
    [
      "duplicate modality",
      descriptor({
        models: [{ ...model(), modalities: ["text", "text"] }],
      }),
    ],
    [
      "negative price",
      descriptor({
        models: [
          {
            ...model(),
            pricing: { input: -1, output: 2, currency: "USD" },
          },
        ],
      }),
    ],
    [
      "empty currency",
      descriptor({
        models: [
          {
            ...model(),
            pricing: { input: 1, output: 2, currency: "" },
          },
        ],
      }),
    ],
  ];

  for (const [label, value] of invalid)
    try {
      createProviderManagement().registerProvider(value);
      expect.unreachable(`${label} must be rejected`);
    } catch (error) {
      expect(error).toMatchObject({
        code: "config.invalid",
        message: "Invalid provider configuration",
        cause: undefined,
      });
    }

  const secret = "credential-that-must-not-leak";
  try {
    createProviderManagement().registerProvider(
      descriptor({
        id: "",
        auth: { type: "apiKey", credentialRef: secret },
      }),
    );
    expect.unreachable("invalid descriptor must not expose its credential reference");
  } catch (error) {
    expect((error as Error).message).not.toContain(secret);
  }
});

test("selects models deterministically and isolates all descriptor state", () => {
  const providers = createProviderManagement();
  const headers = { "x-provider": "original" };
  const input = descriptor({
    id: "z",
    headers,
    models: [model("y"), model("x")],
  });
  providers.registerProvider(descriptor({ id: "a", models: [model("b"), model("a")] }));
  providers.registerProvider(input);

  headers["x-provider"] = "mutated";
  required(input.models[0]).id = "mutated";

  expect(providers.list().map((item) => item.id)).toEqual(["a", "z"]);
  expect(required(providers.list()[1]).models.map((item) => item.id)).toEqual(["x", "y"]);
  expect(providers.select("z", "x")).toMatchObject({
    provider: { id: "z" },
    model: { id: "x" },
  });
  expect(providers.select("z", "missing")).toBeUndefined();

  const leaked = required(providers.get("z"));
  required(leaked.headers)["x-provider"] = "changed";
  required(leaked.models[0]).id = "changed";

  expect(providers.get("z")).toMatchObject({
    headers: { "x-provider": "original" },
  });
  expect(required(providers.get("z")).models.map((item) => item.id)).toEqual(["x", "y"]);
});

test("creates a fresh adapter for every call without exposing descriptor mutation", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor({ dialect: "d" }));
  const seen: ProviderDescriptor[] = [];
  providers.registerDialect("d", (value) => {
    seen.push(value);
    return fakeAdapter();
  });

  const first = providers.createAdapter("p");
  const second = providers.createAdapter("p");

  expect(first).not.toBe(second);
  expect(seen).toHaveLength(2);
  required(seen[0]).models.length = 0;
  expect(providers.select("p", "m")).toBeDefined();
});

test("validates dialect registration and provider lookup", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor({ dialect: "later" }));

  expectInvalid(() => providers.createAdapter("p"));
  expectInvalid(() => providers.createAdapter("missing"));
  expectInvalid(() => providers.registerDialect("", () => fakeAdapter()));

  providers.registerDialect("later", () => fakeAdapter());
  expect(providers.createAdapter("p")).toMatchObject({ dialect: "d" });
  expectInvalid(() => providers.registerDialect("later", () => fakeAdapter()));
});

test("redacts factory failures and does not retain their cause", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor({ dialect: "d" }));
  const sensitive = new Error("Authorization: Bearer secret-key");
  providers.registerDialect("d", () => {
    throw sensitive;
  });

  try {
    providers.createAdapter("p");
    expect.unreachable("expected adapter creation to fail");
  } catch (error) {
    expect(error).toMatchObject({
      code: "config.invalid",
      message: "Invalid provider configuration",
      cause: undefined,
    });
    expect(JSON.stringify(error)).not.toContain("secret-key");
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ClientError, UNREACHABLE_MESSAGE } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { runCli } from "../src/main.js";
import {
  modelsList,
  type ProvidersClient,
  type ProvidersDeps,
  providerList,
} from "../src/providers.js";

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

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-providers-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      providers: [
        {
          id: "fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: "PISCES_TASK4_PROVIDERS_KEY",
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
  );
  return { root, dataDir, configPath };
}

interface Call {
  method: string;
  params: unknown;
}

interface FakeClient {
  calls: Call[];
  closed: boolean;
  socketPath: string | undefined;
  deps: ProvidersDeps;
}

type Responder = (method: string, params: unknown) => unknown;

function fakeClient(responder: Responder): FakeClient {
  const state: FakeClient = {
    calls: [],
    closed: false,
    socketPath: undefined,
    deps: {
      async connect(socketPath: string): Promise<ProvidersClient> {
        state.socketPath = socketPath;
        return {
          async request(method: string, params?: unknown): Promise<unknown> {
            state.calls.push({ method, params });
            return responder(method, params);
          },
          close(): void {
            state.closed = true;
          },
        };
      },
    },
  };
  return state;
}

function unreachable(error: Error): ProvidersDeps {
  return {
    async connect(): Promise<ProvidersClient> {
      throw error;
    },
  };
}

function failingDeps(counter: { connects: number }): ProvidersDeps {
  return {
    async connect(): Promise<ProvidersClient> {
      counter.connects += 1;
      throw new Error("must not connect");
    },
  };
}

const ALPHA = {
  id: "alpha",
  ready: true,
  models: [
    {
      id: "z",
      contextWindow: 8000,
      maxOutput: 1000,
      modalities: ["text", "image"],
      pricing: { input: 1.5, output: 2.5, currency: "USD" },
    },
    { id: "a", contextWindow: 1000, maxOutput: 100, modalities: ["text"] },
  ],
};

// BETA is unready and still owns a model: ordering and readiness tests must
// show that unready providers are neither dropped nor sorted at the wrong level.
const BETA = {
  id: "beta",
  ready: false,
  models: [{ id: "beta-1", contextWindow: 2000, maxOutput: 200, modalities: ["text"] }],
};

const ALPHA_LINES = [
  "alpha/z  context=8000  maxOutput=1000  modalities=text,image",
  "alpha/a  context=1000  maxOutput=100  modalities=text",
];

const BETA_LINE = "beta/beta-1  context=2000  maxOutput=200  modalities=text";

const ALPHA_MODELS_JSON = [
  {
    provider: "alpha",
    id: "z",
    contextWindow: 8000,
    maxOutput: 1000,
    modalities: ["text", "image"],
    pricing: { input: 1.5, output: 2.5, currency: "USD" },
  },
  { provider: "alpha", id: "a", contextWindow: 1000, maxOutput: 100, modalities: ["text"] },
];

const MODELS_JSON = {
  models: [
    ...ALPHA_MODELS_JSON,
    { provider: "beta", id: "beta-1", contextWindow: 2000, maxOutput: 200, modalities: ["text"] },
  ],
};

test("provider list prints one line per provider in daemon order", async () => {
  // Daemon order is beta first; lexicographic sorting would put alpha first.
  const client = fakeClient(() => ({ providers: [BETA, ALPHA] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await providerList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(0);
  expect(client.calls).toEqual([{ method: "provider.list", params: {} }]);
  expect(rec.out).toEqual(["beta  unready  models=1", "alpha  ready  models=2"]);
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
});

test("provider list --json prints the raw result unchanged", async () => {
  const result = { providers: [BETA, ALPHA] };
  const client = fakeClient(() => result);
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await providerList({ configPath, io: rec.io, json: true }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toEqual([JSON.stringify(result)]);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual(result);
  expect(client.closed).toBe(true);
});

test("models list flattens, sorts providers and preserves model order", async () => {
  // Daemon order is [beta, alpha]; missing `.sort()` would emit beta first.
  // Alpha's models are [z, a]; sorting models would emit alpha/a first.
  const client = fakeClient(() => ({ providers: [BETA, ALPHA] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await modelsList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(0);
  expect(client.calls).toEqual([{ method: "provider.list", params: {} }]);
  expect(rec.out).toEqual([...ALPHA_LINES, BETA_LINE]);
  // Explicit relative positions: providers sorted, models untouched.
  expect(rec.out.indexOf(BETA_LINE)).toBeGreaterThan(rec.out.indexOf(ALPHA_LINES[1] ?? ""));
  expect(rec.out.indexOf(ALPHA_LINES[0] ?? "")).toBeLessThan(rec.out.indexOf(ALPHA_LINES[1] ?? ""));
  expect(rec.out.join("\n")).not.toContain("pricing");
  expect(rec.out.join("\n")).not.toContain("USD");
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
});

test("models list includes the models of unready providers", async () => {
  const client = fakeClient(() => ({ providers: [ALPHA, BETA] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await modelsList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toContain(BETA_LINE);
  expect(rec.out).toHaveLength(3);
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
});

test("models list --json includes pricing and only known fields", async () => {
  const leaked = {
    ...ALPHA,
    baseUrl: "http://127.0.0.1:9/v1",
    models: [{ ...ALPHA.models[0], headers: { authorization: "sk-secret" } }, ALPHA.models[1]],
  };
  const client = fakeClient(() => ({ providers: [leaked, BETA] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await modelsList({ configPath, io: rec.io, json: true }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toHaveLength(1);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual(MODELS_JSON);
  expect(rec.out[0]).not.toContain("sk-secret");
  expect(rec.out[0]).not.toContain("baseUrl");
});

test("models list --provider keeps only that provider", async () => {
  const client = fakeClient(() => ({ providers: [ALPHA, BETA] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await modelsList({ configPath, io: rec.io, provider: "beta" }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toEqual([BETA_LINE]);

  const hit = recorder();
  const codeHit = await modelsList(
    { configPath, io: hit.io, provider: "alpha" },
    fakeClient(() => ({ providers: [ALPHA, BETA] })).deps,
  );
  expect(codeHit).toBe(0);
  expect(hit.out).toEqual(ALPHA_LINES);
});

test("models list --provider with an unknown id exits 1 without stdout", async () => {
  const client = fakeClient(() => ({ providers: [ALPHA, BETA] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await modelsList({ configPath, io: rec.io, provider: "missing" }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: provider.not_found: Unknown provider"]);
  expect(client.closed).toBe(true);
});

test("models list prints no models for an empty provider list", async () => {
  const { configPath } = await fixture();

  const human = recorder();
  const humanCode = await modelsList(
    { configPath, io: human.io },
    fakeClient(() => ({ providers: [] })).deps,
  );
  expect(humanCode).toBe(0);
  expect(human.out).toEqual(["no models"]);
  expect(human.err).toEqual([]);

  const json = recorder();
  const jsonCode = await modelsList(
    { configPath, io: json.io, json: true },
    fakeClient(() => ({ providers: [] })).deps,
  );
  expect(jsonCode).toBe(0);
  expect(JSON.parse(json.out[0] ?? "")).toEqual({ models: [] });
});

test("malformed daemon results are rejected as client.protocol", async () => {
  const model = { id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] };
  const provider = { id: "p", ready: true, models: [model] };
  const cases: [string, unknown][] = [
    ["missing providers", {}],
    ["providers not an array", { providers: {} }],
    ["provider not a record", { providers: [null] }],
    ["empty provider id", { providers: [{ ...provider, id: "" }] }],
    ["non-string provider id", { providers: [{ ...provider, id: 7 }] }],
    ["non-boolean ready", { providers: [{ ...provider, ready: "yes" }] }],
    ["missing ready", { providers: [{ id: "p", models: [model] }] }],
    ["models not an array", { providers: [{ ...provider, models: {} }] }],
    [
      "zero contextWindow",
      { providers: [{ ...provider, models: [{ ...model, contextWindow: 0 }] }] },
    ],
    [
      "negative contextWindow",
      { providers: [{ ...provider, models: [{ ...model, contextWindow: -1 }] }] },
    ],
    [
      "fractional contextWindow",
      { providers: [{ ...provider, models: [{ ...model, contextWindow: 1.5 }] }] },
    ],
    ["zero maxOutput", { providers: [{ ...provider, models: [{ ...model, maxOutput: 0 }] }] }],
    ["negative maxOutput", { providers: [{ ...provider, models: [{ ...model, maxOutput: -1 }] }] }],
    [
      "unknown modality",
      { providers: [{ ...provider, models: [{ ...model, modalities: ["video"] }] }] },
    ],
    [
      "duplicate modality",
      { providers: [{ ...provider, models: [{ ...model, modalities: ["text", "text"] }] }] },
    ],
    [
      "modalities not an array",
      { providers: [{ ...provider, models: [{ ...model, modalities: "text" }] }] },
    ],
    [
      "negative pricing",
      {
        providers: [
          {
            ...provider,
            models: [{ ...model, pricing: { input: -1, output: 2, currency: "USD" } }],
          },
        ],
      },
    ],
    [
      "infinite pricing input",
      {
        providers: [
          {
            ...provider,
            models: [
              {
                ...model,
                pricing: { input: Number.POSITIVE_INFINITY, output: 2, currency: "USD" },
              },
            ],
          },
        ],
      },
    ],
    [
      "NaN pricing output",
      {
        providers: [
          {
            ...provider,
            models: [{ ...model, pricing: { input: 1, output: Number.NaN, currency: "USD" } }],
          },
        ],
      },
    ],
    [
      "empty currency",
      {
        providers: [
          {
            ...provider,
            models: [{ ...model, pricing: { input: 1, output: 2, currency: "" } }],
          },
        ],
      },
    ],
    ["pricing not a record", { providers: [{ ...provider, models: [{ ...model, pricing: 3 }] }] }],
    ["empty model id", { providers: [{ ...provider, models: [{ ...model, id: "" }] }] }],
  ];

  const { configPath } = await fixture();
  for (const [label, result] of cases) {
    for (const command of ["provider", "models"] as const) {
      const client = fakeClient(() => result);
      const rec = recorder();
      const code =
        command === "provider"
          ? await providerList({ configPath, io: rec.io }, client.deps)
          : await modelsList({ configPath, io: rec.io }, client.deps);
      expect(code, `${command}: ${label}`).toBe(1);
      expect(rec.out, `${command}: ${label}`).toEqual([]);
      expect(rec.err, `${command}: ${label}`).toEqual([
        "error: client.protocol: Invalid response from daemon",
      ]);
      expect(client.closed, `${command}: ${label}`).toBe(true);
    }
  }
});

test("models list --json rejects malformed results without stdout", async () => {
  const malformed = {
    providers: [
      {
        id: "p",
        ready: true,
        models: [{ id: "m", contextWindow: 0, maxOutput: 100, modalities: ["text"] }],
      },
    ],
  };
  const client = fakeClient(() => malformed);
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await modelsList({ configPath, io: rec.io, json: true }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: client.protocol: Invalid response from daemon"]);
  expect(client.closed).toBe(true);
});

test("an unreadable config exits 2 before connecting", async () => {
  const { root } = await fixture();
  const counter = { connects: 0 };
  const rec = recorder();

  const code = await providerList(
    { configPath: join(root, "missing.json"), io: rec.io },
    failingDeps(counter),
  );

  expect(code).toBe(2);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: config.invalid: Invalid configuration"]);
  expect(counter.connects).toBe(0);
});

test("an unreachable daemon prints daemon.unreachable with fixed text", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps = unreachable(new ClientError("daemon.unreachable", "connect ECONNREFUSED /raw"));

  const code = await modelsList({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual([`error: daemon.unreachable: ${UNREACHABLE_MESSAGE}`]);
  expect(rec.err.join("\n")).not.toContain("ECONNREFUSED");
});

test("protocol error codes pass through and the client is closed", async () => {
  const client = fakeClient(() => {
    throw new ClientError("protocol.invalid_request", "Invalid request parameters");
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await providerList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: protocol.invalid_request: Invalid request parameters"]);
  expect(client.closed).toBe(true);
});

test("unknown thrown errors are reported as client.protocol", async () => {
  const client = fakeClient(() => {
    throw new Error("boom /raw/path");
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await modelsList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: client.protocol: Invalid response from daemon"]);
  expect(rec.err.join("\n")).not.toContain("boom");
  expect(client.closed).toBe(true);
});

test("--data-dir overrides the configured data directory", async () => {
  const { configPath, root } = await fixture();
  const override = join(root, "override");

  const providerClient = fakeClient(() => ({ providers: [] }));
  const providerRec = recorder();
  expect(
    await providerList({ configPath, dataDir: override, io: providerRec.io }, providerClient.deps),
  ).toBe(0);
  expect(providerClient.socketPath).toBe(join(override, "run", "pisces.sock"));

  const modelsClient = fakeClient(() => ({ providers: [] }));
  const modelsRec = recorder();
  expect(
    await modelsList({ configPath, dataDir: override, io: modelsRec.io }, modelsClient.deps),
  ).toBe(0);
  expect(modelsClient.socketPath).toBe(join(override, "run", "pisces.sock"));
});

test("runCli dispatches provider list and models list", async () => {
  const { configPath } = await fixture();

  const providerClient = fakeClient(() => ({ providers: [ALPHA, BETA] }));
  const providerRec = recorder();
  expect(
    await runCli(
      ["provider", "list", "--config", configPath, "--json"],
      providerRec.io,
      undefined,
      undefined,
      undefined,
      providerClient.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(providerRec.out[0] ?? "")).toEqual({ providers: [ALPHA, BETA] });

  const modelsClient = fakeClient(() => ({ providers: [BETA, ALPHA] }));
  const modelsRec = recorder();
  expect(
    await runCli(
      ["models", "list", "--provider", "alpha", "--json", "--config", configPath],
      modelsRec.io,
      undefined,
      undefined,
      undefined,
      modelsClient.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(modelsRec.out[0] ?? "")).toEqual({ models: ALPHA_MODELS_JSON });

  const humanClient = fakeClient(() => ({ providers: [BETA, ALPHA] }));
  const humanRec = recorder();
  expect(
    await runCli(
      ["models", "list", "--config", configPath],
      humanRec.io,
      undefined,
      undefined,
      undefined,
      humanClient.deps,
    ),
  ).toBe(0);
  expect(humanRec.out).toEqual([...ALPHA_LINES, BETA_LINE]);
});

test("runCli forwards --data-dir for provider and models", async () => {
  const { configPath, root } = await fixture();
  const override = join(root, "dispatch-override");

  const client = fakeClient(() => ({ providers: [] }));
  const rec = recorder();
  expect(
    await runCli(
      ["provider", "list", "--config", configPath, "--data-dir", override],
      rec.io,
      undefined,
      undefined,
      undefined,
      client.deps,
    ),
  ).toBe(0);
  expect(client.socketPath).toBe(join(override, "run", "pisces.sock"));
});

test("runCli honors --help and --version for provider and models", async () => {
  const counter = { connects: 0 };
  const deps = failingDeps(counter);

  for (const command of ["provider", "models"] as const) {
    for (const argv of [
      [command, "--help"],
      [command, "list", "--help"],
      [command, "--version"],
      [command, "list", "--version"],
    ]) {
      const rec = recorder();
      const code = await runCli(argv, rec.io, undefined, undefined, undefined, deps);
      expect(code, argv.join(" ")).toBe(0);
      expect(rec.err, argv.join(" ")).toEqual([]);
      expect(rec.out, argv.join(" ")).toHaveLength(1);
      const output = rec.out.join("\n");
      if (argv.includes("--help")) {
        expect(output, argv.join(" ")).toContain("provider   list providers known to the daemon");
        expect(output, argv.join(" ")).toContain("models     list models of every provider");
      } else {
        expect(output, argv.join(" ")).toMatch(/^pisces \d+\.\d+\.\d+$/);
      }
    }
  }
  expect(counter.connects).toBe(0);
});

test("runCli rejects provider/models usage errors without connecting", async () => {
  const cases = [
    ["provider"],
    ["provider", "wat"],
    ["provider", "list", "--bogus"],
    ["provider", "list", "extra"],
    ["provider", "list", "--provider", "alpha"],
    ["provider", "list", "--data-dir"],
    ["models"],
    ["models", "wat"],
    ["models", "list", "--bogus"],
    ["models", "list", "extra"],
    ["models", "list", "--provider"],
    ["models", "list", "--json", "extra"],
  ];
  const counter = { connects: 0 };

  for (const argv of cases) {
    const rec = recorder();
    const code = await runCli(argv, rec.io, undefined, undefined, undefined, failingDeps(counter));
    expect(code, argv.join(" ")).toBe(2);
    expect(rec.err.join("\n"), argv.join(" ")).toContain("usage:");
    expect(rec.out).toEqual([]);
  }
  expect(counter.connects).toBe(0);
});

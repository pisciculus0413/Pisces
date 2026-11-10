import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ClientError } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { runCli } from "../src/main.js";
import { type SessionsClient, type SessionsDeps, sessionsList } from "../src/sessions.js";

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
  const root = await mkdtemp(join(tmpdir(), "pisces-sessions-"));
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
          apiKeyEnv: "PISCES_TASK4_SESSIONS_KEY",
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
  budgets: (number | undefined)[];
  closed: boolean;
  socketPath: string | undefined;
  deps: SessionsDeps;
}

type Responder = (method: string, params: unknown) => unknown;

function fakeClient(responder: Responder): FakeClient {
  const state: FakeClient = {
    calls: [],
    budgets: [],
    closed: false,
    socketPath: undefined,
    deps: {
      async connect(socketPath: string): Promise<SessionsClient> {
        state.socketPath = socketPath;
        return {
          async request(
            method: string,
            params?: unknown,
            options?: { timeoutMs?: number },
          ): Promise<unknown> {
            state.calls.push({ method, params });
            state.budgets.push(options?.timeoutMs);
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

function unreachable(error: Error): SessionsDeps {
  return {
    async connect(): Promise<SessionsClient> {
      throw error;
    },
  };
}

const OLD = {
  id: "s-old",
  provider: "p",
  model: "m",
  workspace: "/work/old",
  createdAt: "2026-01-02T03:04:05.000Z",
  schemaVersion: 1,
};
const NEW = {
  id: "s-new",
  provider: "p2",
  model: "m2",
  workspace: "/work/new",
  createdAt: "2026-05-06T07:08:09.000Z",
  schemaVersion: 1,
};

test("sessions list sorts newest first and prints one line per session", async () => {
  const client = fakeClient(() => ({ sessions: [OLD, NEW] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionsList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(0);
  expect(client.calls).toEqual([{ method: "session.list", params: {} }]);
  expect(rec.out).toEqual([
    "s-new p2/m2 /work/new 2026-05-06T07:08:09.000Z",
    "s-old p/m /work/old 2026-01-02T03:04:05.000Z",
  ]);
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
});

test("sessions list --json prints the raw result without sorting", async () => {
  const result = { sessions: [OLD, NEW] };
  const client = fakeClient(() => result);
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionsList({ configPath, io: rec.io, json: true }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toHaveLength(1);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual(result);
});

test("sessions list does not read session files", async () => {
  const client = fakeClient(() => ({ sessions: [] }));
  const { configPath, root } = await fixture();
  const dataDir = join(root, "never-created");
  const rec = recorder();

  const code = await sessionsList({ configPath, dataDir, io: rec.io }, client.deps);

  expect(code).toBe(0);
  expect(client.socketPath).toBe(join(dataDir, "run", "pisces.sock"));
  await expect(access(dataDir)).rejects.toThrow();
  expect(client.calls).toEqual([{ method: "session.list", params: {} }]);
});

test("--data-dir overrides the configured data directory", async () => {
  const client = fakeClient(() => ({ sessions: [] }));
  const { configPath, root } = await fixture();
  const override = join(root, "override");
  const rec = recorder();

  const code = await sessionsList({ configPath, dataDir: override, io: rec.io }, client.deps);

  expect(code).toBe(0);
  expect(client.socketPath).toBe(join(override, "run", "pisces.sock"));
});

test("an unreachable daemon prints daemon.unreachable with fixed text", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps = unreachable(new ClientError("daemon.unreachable", "connect ECONNREFUSED /raw"));

  const code = await sessionsList({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
  expect(rec.err.join("\n")).not.toContain("ECONNREFUSED");
});

test("a protocol error is printed with its code and exits 1", async () => {
  const client = fakeClient(() => {
    throw new ClientError("protocol.invalid_request", "Invalid request parameters");
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionsList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: protocol.invalid_request: Invalid request parameters"]);
  expect(client.closed).toBe(true);
});

test("a malformed daemon result is rejected as client.protocol", async () => {
  const client = fakeClient(() => ({ sessions: [{ id: 1 }] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionsList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: client.protocol: Invalid response from daemon"]);
});

test("runCli routes sessions list", async () => {
  const client = fakeClient(() => ({ sessions: [OLD, NEW] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCli(
    ["sessions", "list", "--config", configPath, "--json"],
    rec.io,
    undefined,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual({ sessions: [OLD, NEW] });
});

test("runCli rejects sessions usage errors without connecting", async () => {
  const cases = [
    ["sessions"],
    ["sessions", "wat"],
    ["sessions", "list", "--bogus"],
    ["sessions", "list", "extra"],
    ["sessions", "list", "--data-dir"],
  ];
  let connects = 0;
  const deps: SessionsDeps = {
    async connect(): Promise<SessionsClient> {
      connects += 1;
      throw new Error("must not connect");
    },
  };

  for (const argv of cases) {
    const rec = recorder();
    const code = await runCli(argv, rec.io, undefined, undefined, deps);
    expect(code, argv.join(" ")).toBe(2);
    expect(rec.err.join("\n"), argv.join(" ")).toContain("usage:");
    expect(rec.out).toEqual([]);
  }
  expect(connects).toBe(0);
});

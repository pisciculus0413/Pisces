import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ClientError } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { runCli } from "../src/main.js";
import { sessionCancel } from "../src/session-cancel.js";
import type { SessionsClient, SessionsDeps } from "../src/sessions.js";

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
  const root = await mkdtemp(join(tmpdir(), "pisces-session-cancel-"));
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
          apiKeyEnv: "PISCES_TASK2_CANCEL_KEY",
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
  deps: SessionsDeps;
}

type Responder = (method: string, params: unknown) => unknown;

function fakeClient(responder: Responder): FakeClient {
  const state: FakeClient = {
    calls: [],
    closed: false,
    socketPath: undefined,
    deps: {
      async connect(socketPath: string): Promise<SessionsClient> {
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

function unreachable(error: Error): SessionsDeps {
  return {
    async connect(): Promise<SessionsClient> {
      throw error;
    },
  };
}

const PROTOCOL_ERROR = "error: client.protocol: Invalid response from daemon";
const CANCEL_FAILED = "error: turn.cancel_failed: Cancel request was not accepted";

interface Turn {
  sessionId: string;
  turnId: string;
  startedAt: string;
}

function turn(sessionId: string, turnId: string, extra: Partial<Turn> = {}): Turn {
  return { sessionId, turnId, startedAt: "2026-01-01T00:00:00.000Z", ...extra };
}

test("cancels only the turn whose session id matches", async () => {
  const turns = [turn("other", "t0"), turn("s1", "t1")];
  const client = fakeClient((method) => {
    if (method === "turn.list") return { turns };
    return { cancelled: true };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(0);
  expect(client.calls).toEqual([
    { method: "turn.list", params: {} },
    { method: "turn.cancel", params: { turnId: "t1" } },
  ]);
  expect(rec.out).toEqual(["cancelled t1"]);
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
});

test("a matching turn with extra unknown fields still cancels", async () => {
  const client = fakeClient((method) => {
    if (method === "turn.list") return { turns: [{ ...turn("s1", "t1"), extra: 1 }] };
    return { cancelled: true };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(0);
  expect(client.calls).toEqual([
    { method: "turn.list", params: {} },
    { method: "turn.cancel", params: { turnId: "t1" } },
  ]);
  expect(rec.out).toEqual(["cancelled t1"]);
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
});

test("no matching turn prints no active turn and never cancels", async () => {
  const client = fakeClient(() => ({ turns: [turn("other", "t0")] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toEqual(["no active turn"]);
  expect(rec.err).toEqual([]);
  expect(client.calls).toEqual([{ method: "turn.list", params: {} }]);
  expect(client.closed).toBe(true);
});

test("an empty turn list prints no active turn and exits 0", async () => {
  const client = fakeClient(() => ({ turns: [] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toEqual(["no active turn"]);
  expect(rec.err).toEqual([]);
  expect(client.calls).toEqual([{ method: "turn.list", params: {} }]);
});

test("a rejected cancellation reports turn.cancel_failed and exits 1", async () => {
  const client = fakeClient((method) => {
    if (method === "turn.list") return { turns: [turn("s1", "t1")] };
    return { cancelled: false };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual([CANCEL_FAILED]);
  expect(client.calls).toEqual([
    { method: "turn.list", params: {} },
    { method: "turn.cancel", params: { turnId: "t1" } },
  ]);
  expect(client.closed).toBe(true);
});

test("multiple matching turns are cancelled in daemon order", async () => {
  const turns = [turn("other", "t0"), turn("s1", "t1"), turn("s1", "t2")];
  const client = fakeClient((method) => {
    if (method === "turn.list") return { turns };
    return { cancelled: true };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(0);
  expect(client.calls).toEqual([
    { method: "turn.list", params: {} },
    { method: "turn.cancel", params: { turnId: "t1" } },
    { method: "turn.cancel", params: { turnId: "t2" } },
  ]);
  expect(rec.out).toEqual(["cancelled t1", "cancelled t2"]);
  expect(rec.err).toEqual([]);
});

test("a failure after an earlier success keeps the success and exits 1", async () => {
  const turns = [turn("s1", "t1"), turn("s1", "t2")];
  const client = fakeClient((method, params) => {
    if (method === "turn.list") return { turns };
    const { turnId } = params as { turnId: string };
    return { cancelled: turnId === "t1" };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual(["cancelled t1"]);
  expect(rec.err).toEqual([CANCEL_FAILED]);
  expect(client.calls).toEqual([
    { method: "turn.list", params: {} },
    { method: "turn.cancel", params: { turnId: "t1" } },
    { method: "turn.cancel", params: { turnId: "t2" } },
  ]);
  expect(client.closed).toBe(true);
});

test("a malformed turn list is client.protocol with no output", async () => {
  const cases: unknown[] = [
    {},
    { turns: "nope" },
    { turns: [null] },
    { turns: [{ sessionId: "s1", startedAt: "2026-01-01T00:00:00.000Z" }] },
    { turns: [turn("", "t1")] },
    { turns: [turn("s1", "")] },
    { turns: [{ sessionId: "s1", turnId: "t1" }] },
    { turns: [{ sessionId: 1, turnId: "t1", startedAt: "2026-01-01T00:00:00.000Z" }] },
  ];

  for (const result of cases) {
    const client = fakeClient(() => result);
    const { configPath } = await fixture();
    const rec = recorder();

    const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

    expect(code, JSON.stringify(result)).toBe(1);
    expect(rec.out, JSON.stringify(result)).toEqual([]);
    expect(rec.err, JSON.stringify(result)).toEqual([PROTOCOL_ERROR]);
    expect(client.calls, JSON.stringify(result)).toEqual([{ method: "turn.list", params: {} }]);
    expect(client.closed, JSON.stringify(result)).toBe(true);
  }
});

test("a malformed cancel result is client.protocol with no success output", async () => {
  const cases: unknown[] = [{}, { cancelled: "yes" }, { cancelled: 1 }, null, "cancelled"];

  for (const result of cases) {
    const client = fakeClient((method) => {
      if (method === "turn.list") return { turns: [turn("s1", "t1")] };
      return result;
    });
    const { configPath } = await fixture();
    const rec = recorder();

    const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

    expect(code, JSON.stringify(result)).toBe(1);
    expect(rec.out, JSON.stringify(result)).toEqual([]);
    expect(rec.err, JSON.stringify(result)).toEqual([PROTOCOL_ERROR]);
    expect(client.closed, JSON.stringify(result)).toBe(true);
  }
});

test("a protocol error passes through with its code and message", async () => {
  const client = fakeClient(() => {
    throw new ClientError("turn.active", "A turn is already active");
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: turn.active: A turn is already active"]);
  expect(client.closed).toBe(true);
});

test("an invalid configuration exits 2 without connecting", async () => {
  let connects = 0;
  const deps: SessionsDeps = {
    async connect(): Promise<SessionsClient> {
      connects += 1;
      throw new Error("must not connect");
    },
  };
  const { root } = await fixture();
  const rec = recorder();

  const code = await sessionCancel(
    { configPath: join(root, "missing.json"), io: rec.io, sessionId: "s1" },
    deps,
  );

  expect(code).toBe(2);
  expect(connects).toBe(0);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: config.invalid: Invalid configuration"]);
});

test("an unreachable daemon prints fixed text and exits 1", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps = unreachable(new ClientError("daemon.unreachable", "connect ECONNREFUSED /raw"));

  const code = await sessionCancel({ configPath, io: rec.io, sessionId: "s1" }, deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
  expect(rec.err.join("\n")).not.toContain("ECONNREFUSED");
});

test("runCli routes sessions cancel", async () => {
  const client = fakeClient((method) => {
    if (method === "turn.list") return { turns: [turn("s1", "t1")] };
    return { cancelled: true };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCli(
    ["sessions", "cancel", "s1", "--config", configPath],
    rec.io,
    undefined,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(rec.out).toEqual(["cancelled t1"]);
  expect(rec.err).toEqual([]);
  expect(client.calls).toEqual([
    { method: "turn.list", params: {} },
    { method: "turn.cancel", params: { turnId: "t1" } },
  ]);
});

test("runCli routes sessions cancel with --data-dir", async () => {
  const client = fakeClient(() => ({ turns: [] }));
  const { configPath, root } = await fixture();
  const dataDir = join(root, "cancel-data");
  const rec = recorder();

  const code = await runCli(
    ["sessions", "cancel", "s1", "--data-dir", dataDir, "--config", configPath],
    rec.io,
    undefined,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.socketPath).toBe(join(dataDir, "run", "pisces.sock"));
  expect(rec.out).toEqual(["no active turn"]);
});

test("runCli rejects sessions cancel usage errors without connecting", async () => {
  const cases = [
    ["sessions", "cancel"],
    ["sessions", "cancel", ""],
    ["sessions", "cancel", "s1", "s2"],
    ["sessions", "cancel", "s1", "--json"],
    ["sessions", "cancel", "s1", "--node", "n1"],
    ["sessions", "cancel", "s1", "--bogus"],
    ["sessions", "cancel", "--data-dir", ""],
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
    expect(rec.out, argv.join(" ")).toEqual([]);
  }
  expect(connects).toBe(0);
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ClientError } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { runCli } from "../src/main.js";
import { sessionExport } from "../src/session-export.js";
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
  const root = await mkdtemp(join(tmpdir(), "pisces-session-export-"));
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
          apiKeyEnv: "PISCES_TASK1_EXPORT_KEY",
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

interface Node {
  id: string;
  parentId: string;
  kind: string;
  role: string;
  content: unknown[];
  source: string;
  createdAt: string;
  schemaVersion: number;
  synthetic?: string;
}

function node(id: string, parentId: string, extra: Partial<Node> = {}): Node {
  return {
    id,
    parentId,
    kind: "agent",
    role: "user",
    content: [{ type: "text", text: id }],
    source: "create",
    createdAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    ...extra,
  };
}

test("export prints every page as jsonl and follows nextCursor", async () => {
  const a = node("a", "a");
  const b = node("b", "a", { synthetic: "interrupted" });
  const c = node("c", "b", { kind: "control", role: "assistant" });
  const client = fakeClient((method, params) => {
    expect(method).toBe("session.read");
    const { cursor } = params as { cursor?: string };
    return cursor === undefined ? { records: [a, b], nextCursor: "b" } : { records: [c] };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionExport({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(0);
  expect(client.calls).toEqual([
    { method: "session.read", params: { sessionId: "s1", limit: 262_144 } },
    { method: "session.read", params: { sessionId: "s1", limit: 262_144, cursor: "b" } },
  ]);
  expect(rec.out).toEqual([JSON.stringify(a), JSON.stringify(b), JSON.stringify(c)]);
  expect(rec.out.map((line) => JSON.parse(line))).toEqual([a, b, c]);
  expect(rec.out[1]).toContain('"synthetic":"interrupted"');
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
});

test("--node is forwarded as nodeId on every page", async () => {
  const a = node("a", "a");
  const b = node("b", "a");
  const client = fakeClient((_method, params) => {
    const { cursor } = params as { cursor?: string };
    return cursor === undefined ? { records: [a], nextCursor: "b" } : { records: [b] };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionExport(
    { configPath, io: rec.io, sessionId: "s1", nodeId: "n1" },
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls).toEqual([
    { method: "session.read", params: { sessionId: "s1", nodeId: "n1", limit: 262_144 } },
    {
      method: "session.read",
      params: { sessionId: "s1", nodeId: "n1", limit: 262_144, cursor: "b" },
    },
  ]);
  expect(rec.out).toEqual([JSON.stringify(a), JSON.stringify(b)]);
});

test("every page requests the byte limit while forwarding nodeId and cursor", async () => {
  const pages = [node("a", "a"), node("b", "a"), node("c", "b")];
  const client = fakeClient((_method, params) => {
    const { cursor } = params as { cursor?: string };
    if (cursor === undefined) return { records: [pages[0]], nextCursor: "a" };
    if (cursor === "a") return { records: [pages[1]], nextCursor: "b" };
    return { records: [pages[2]] };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionExport(
    { configPath, io: rec.io, sessionId: "s1", nodeId: "n1" },
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls).toEqual([
    { method: "session.read", params: { sessionId: "s1", nodeId: "n1", limit: 262_144 } },
    {
      method: "session.read",
      params: { sessionId: "s1", nodeId: "n1", limit: 262_144, cursor: "a" },
    },
    {
      method: "session.read",
      params: { sessionId: "s1", nodeId: "n1", limit: 262_144, cursor: "b" },
    },
  ]);
  expect(rec.out).toEqual(pages.map((page) => JSON.stringify(page)));
  expect(client.closed).toBe(true);
});

test("an empty first page prints nothing and exits 0", async () => {
  const client = fakeClient(() => ({ records: [] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionExport({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(0);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual([]);
  expect(client.calls).toHaveLength(1);
  expect(client.closed).toBe(true);
});

test("a malformed first page is client.protocol with no stdout", async () => {
  const good = node("a", "a");
  const pages: unknown[] = [
    {},
    { records: "nope" },
    { records: [good], nextCursor: "" },
    { records: [good], nextCursor: 7 },
    { records: [{ ...good, id: undefined }] },
    { records: [{ ...good, content: "text" }] },
    { records: [{ ...good, schemaVersion: "1" }] },
    { records: [{ ...good, parentId: undefined }] },
  ];

  for (const page of pages) {
    const client = fakeClient(() => page);
    const { configPath } = await fixture();
    const rec = recorder();

    const code = await sessionExport({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

    expect(code, JSON.stringify(page)).toBe(1);
    expect(rec.out, JSON.stringify(page)).toEqual([]);
    expect(rec.err, JSON.stringify(page)).toEqual([PROTOCOL_ERROR]);
    expect(client.closed, JSON.stringify(page)).toBe(true);
  }
});

test("a repeated nextCursor stops with client.protocol", async () => {
  const a = node("a", "a");
  const b = node("b", "a");
  const client = fakeClient((_method, params) => {
    const { cursor } = params as { cursor?: string };
    return cursor === undefined
      ? { records: [a], nextCursor: "b" }
      : { records: [b], nextCursor: "b" };
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionExport({ configPath, io: rec.io, sessionId: "s1" }, client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual([PROTOCOL_ERROR]);
  expect(client.calls).toHaveLength(2);
  expect(client.closed).toBe(true);
});

test("a protocol error passes through with its code and message", async () => {
  const client = fakeClient(() => {
    throw new ClientError("session.node_not_found", "Session node not found");
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await sessionExport(
    { configPath, io: rec.io, sessionId: "s1", nodeId: "n1" },
    client.deps,
  );

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: session.node_not_found: Session node not found"]);
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

  const code = await sessionExport(
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

  const code = await sessionExport({ configPath, io: rec.io, sessionId: "s1" }, deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
  expect(rec.err.join("\n")).not.toContain("ECONNREFUSED");
});

test("runCli routes sessions export", async () => {
  const a = node("a", "a");
  const client = fakeClient(() => ({ records: [a] }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCli(
    ["sessions", "export", "s1", "--config", configPath],
    rec.io,
    undefined,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(rec.out).toEqual([JSON.stringify(a)]);
  expect(client.calls).toEqual([
    { method: "session.read", params: { sessionId: "s1", limit: 262_144 } },
  ]);
});

test("runCli routes sessions export with --node and --data-dir", async () => {
  const a = node("a", "a");
  const client = fakeClient(() => ({ records: [a] }));
  const { configPath, root } = await fixture();
  const dataDir = join(root, "export-data");
  const rec = recorder();

  const code = await runCli(
    ["sessions", "export", "s1", "--node", "n1", "--data-dir", dataDir, "--config", configPath],
    rec.io,
    undefined,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.socketPath).toBe(join(dataDir, "run", "pisces.sock"));
  expect(client.calls).toEqual([
    { method: "session.read", params: { sessionId: "s1", nodeId: "n1", limit: 262_144 } },
  ]);
});

test("runCli rejects empty sessions option values as usage errors", async () => {
  const cases = [
    ["sessions", "export", "s1", "--node", ""],
    ["sessions", "export", "s1", "--config", ""],
    ["sessions", "list", "--data-dir", ""],
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

test("runCli rejects sessions export and cancel usage errors without connecting", async () => {
  const cases = [
    ["sessions", "export"],
    ["sessions", "export", "s1", "s2"],
    ["sessions", "export", "s1", "--json"],
    ["sessions", "export", "s1", "--bogus"],
    ["sessions", "export", "s1", "--node"],
    ["sessions", "export", "--data-dir"],
    ["sessions", "list", "--node", "n1"],
    ["sessions", "cancel"],
    ["sessions", "cancel", "s1", "--json"],
    ["sessions", "cancel", "s1", "--node", "n1"],
    ["sessions", "cancel", "s1", "s2"],
    ["sessions", "bogus"],
    ["sessions"],
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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProtocolEvent } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
import {
  type Client,
  ClientError,
  type CloseListener,
  type EventListener,
  UNREACHABLE_MESSAGE,
} from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { socketPathFor } from "../src/lifecycle.js";
import { runCli } from "../src/main.js";
import { type RunDeps, type RunOptions, runCommand } from "../src/run.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Recorder {
  io: CommandIo;
  out: string[];
  err: string[];
  writes: string[];
}

function recorder(withWrite = true): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const writes: string[] = [];
  const io: CommandIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(withWrite ? { write: (text: string) => writes.push(text) } : {}),
  };
  return { io, out, err, writes };
}

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-run-"));
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
          apiKeyEnv: "PISCES_TASK4_RUN_KEY",
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
  );
  return { root, dataDir, configPath };
}

function runOptions(configPath: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    configPath,
    prompt: "hello",
    newSession: false,
    continueSession: false,
    create: false,
    useDefaultSystemPrompt: false,
    enable: [],
    disable: [],
    print: false,
    json: false,
    ...overrides,
  };
}

interface Call {
  method: string;
  params: unknown;
}

type Responder = (method: string, params: unknown) => unknown;

interface FakeClient {
  calls: Call[];
  log: string[];
  closed: boolean;
  paths: string[];
  deps: RunDeps;
  setResponder(responder: Responder): void;
  emit(event: ProtocolEvent): void;
  interrupt(): void;
  closeWith(code: string, message: string): void;
  listenerCount(): number;
}

function fakeClient(responder: Responder): FakeClient {
  const listeners = new Map<number, EventListener>();
  const closeListeners = new Map<number, CloseListener>();
  const interruptHandlers = new Set<() => void>();
  let nextListener = 0;
  let nextCloseListener = 0;
  let current = responder;

  const notifyClose = (error: ClientError): void => {
    const pending = [...closeListeners.values()];
    closeListeners.clear();
    for (const listener of pending) listener(error);
  };

  const state: FakeClient = {
    calls: [],
    log: [],
    closed: false,
    paths: [],
    deps: {
      async connect(socketPath: string): Promise<Client> {
        state.log.push("connect");
        state.paths.push(socketPath);
        return {
          async request(method: string, params?: unknown): Promise<unknown> {
            state.calls.push({ method, params });
            state.log.push(`request:${method}`);
            return current(method, params);
          },
          onEvent(listener: EventListener): () => void {
            state.log.push("event:register");
            nextListener += 1;
            const token = nextListener;
            listeners.set(token, listener);
            return () => {
              state.log.push("event:unsubscribe");
              listeners.delete(token);
            };
          },
          onClose(listener: CloseListener): () => void {
            state.log.push("close:register");
            nextCloseListener += 1;
            const token = nextCloseListener;
            closeListeners.set(token, listener);
            return () => {
              state.log.push("close:unsubscribe");
              closeListeners.delete(token);
            };
          },
          close(): void {
            state.closed = true;
            state.log.push("close");
            listeners.clear();
            notifyClose(new ClientError("client.closed", "Client is closed"));
          },
        };
      },
      onInterrupt(handler: () => void): () => void {
        state.log.push("interrupt:register");
        interruptHandlers.add(handler);
        return () => {
          state.log.push("interrupt:unregister");
          interruptHandlers.delete(handler);
        };
      },
    },
    setResponder(next) {
      current = next;
    },
    emit(event) {
      for (const listener of [...listeners.values()]) listener(event);
    },
    interrupt() {
      for (const handler of [...interruptHandlers]) handler();
    },
    closeWith(code, message) {
      state.closed = true;
      state.log.push("close");
      listeners.clear();
      notifyClose(new ClientError(code, message));
    },
    listenerCount() {
      return listeners.size;
    },
  };
  return state;
}

function unreachableDeps(counter: { connects: number }): RunDeps {
  return {
    async connect(): Promise<Client> {
      counter.connects += 1;
      throw new Error("must not connect");
    },
    onInterrupt(): () => void {
      return () => {};
    },
  };
}

const META = {
  id: "s1",
  provider: "p",
  model: "m",
  workspace: "/work",
  createdAt: "2026-05-06T07:08:09.000Z",
  schemaVersion: 1,
};

const META_2 = {
  id: "s2",
  provider: "p",
  model: "m",
  workspace: "/work",
  createdAt: "2026-06-07T08:09:10.000Z",
  schemaVersion: 1,
};

const OLD = {
  id: "s-old",
  provider: "p",
  model: "m",
  workspace: "/work",
  createdAt: "2026-01-02T03:04:05.000Z",
  schemaVersion: 1,
};

const TIE_A = {
  id: "s-tie-a",
  provider: "p",
  model: "m",
  workspace: "/work",
  createdAt: "2026-09-09T09:09:09.000Z",
  schemaVersion: 1,
};

const TIE_B = {
  id: "s-tie-b",
  provider: "p",
  model: "m",
  workspace: "/work",
  createdAt: "2026-09-09T09:09:09.000Z",
  schemaVersion: 1,
};

const deltaEvent = (
  delta: string,
  options: { sessionId?: string; turnId?: string; kind?: "text" | "reasoning" } = {},
): ProtocolEvent => ({
  event: "turn.delta",
  data: {
    sessionId: options.sessionId ?? "s1",
    turnId: options.turnId ?? "t1",
    step: 1,
    kind: options.kind ?? "text",
    delta,
  },
});

const endedEvent = (
  reason: "completed" | "cancelled" | "failed",
  options: {
    sessionId?: string;
    turnId?: string;
    error?: { code: string; message: string };
  } = {},
): ProtocolEvent => ({
  event: "turn.ended",
  data: {
    sessionId: options.sessionId ?? "s1",
    turnId: options.turnId ?? "t1",
    reason,
    endedAt: "2026-11-09T00:00:00.000Z",
    ...(options.error === undefined ? {} : { error: options.error }),
  },
});

/** Emits the events in a microtask, before `turn.start` resolves to the command. */
function startAndEmit(client: FakeClient, events: ProtocolEvent[]): unknown {
  queueMicrotask(() => {
    for (const event of events) client.emit(event);
  });
  return { turnId: "t1", mode: "new" };
}

/** The default session.create/subscribe/queue.enqueue/turn.start flow. */
function completedResponder(client: FakeClient, events: ProtocolEvent[]): Responder {
  return (method) => {
    switch (method) {
      case "session.create":
        return META;
      case "session.subscribe":
        return { sessionId: "s1" };
      case "queue.enqueue":
        return { ids: ["q1"] };
      case "turn.start":
        return startAndEmit(client, events);
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };
}

test("creates a session with only the provided options, streams deltas and exits 0", async () => {
  const client = fakeClient(() => undefined);
  client.setResponder(
    completedResponder(client, [deltaEvent("Hel"), deltaEvent("lo"), endedEvent("completed")]),
  );
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, {
      io: rec.io,
      model: "m",
      provider: "p",
      systemPrompt: "sys",
    }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls).toEqual([
    {
      method: "session.create",
      params: { provider: "p", model: "m", systemPrompt: ["sys"] },
    },
    { method: "session.subscribe", params: { sessionId: "s1" } },
    {
      method: "queue.enqueue",
      params: {
        sessionId: "s1",
        entries: [
          {
            kind: "agent",
            role: "user",
            source: "run",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      },
    },
    { method: "turn.start", params: { sessionId: "s1" } },
  ]);
  expect(rec.writes).toEqual(["Hel", "lo", "\n"]);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual([]);
  expect(client.closed).toBe(true);
  expect(client.listenerCount()).toBe(0);
  expect(client.calls.some((call) => call.method === "session.configure")).toBe(false);
  expect(client.calls.some((call) => call.method === "entries.snapshot")).toBe(false);

  const eventAt = client.log.indexOf("event:register");
  const subscribeAt = client.log.indexOf("request:session.subscribe");
  const enqueueAt = client.log.indexOf("request:queue.enqueue");
  const startAt = client.log.indexOf("request:turn.start");
  const interruptAt = client.log.indexOf("interrupt:register");
  expect(eventAt).toBeGreaterThanOrEqual(0);
  expect(eventAt).toBeLessThan(subscribeAt);
  expect(subscribeAt).toBeLessThan(enqueueAt);
  expect(enqueueAt).toBeLessThan(startAt);
  expect(interruptAt).toBeLessThan(startAt);
  expect(client.log).toContain("interrupt:unregister");
  expect(client.log.indexOf("event:unsubscribe")).toBeGreaterThan(startAt);
});

test("a new session omits create fields that were not provided", async () => {
  const client = fakeClient(() => undefined);
  client.setResponder(completedResponder(client, [endedEvent("completed")]));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io }), client.deps);

  expect(code).toBe(0);
  expect(client.calls[0]).toEqual({ method: "session.create", params: {} });
  expect(client.calls.some((call) => call.method === "session.configure")).toBe(false);
});

test("--print emits only the final text", async () => {
  const client = fakeClient(() => undefined);
  client.setResponder(
    completedResponder(client, [deltaEvent("Hel"), deltaEvent("lo"), endedEvent("completed")]),
  );
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, print: true }), client.deps);

  expect(code).toBe(0);
  expect(rec.writes).toEqual([]);
  expect(rec.out).toEqual(["Hello"]);
  expect(rec.err).toEqual([]);
});

test("--json emits one object with session and turn ids", async () => {
  const client = fakeClient(() => undefined);
  client.setResponder(
    completedResponder(client, [deltaEvent("Hel"), deltaEvent("lo"), endedEvent("completed")]),
  );
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, json: true }), client.deps);

  expect(code).toBe(0);
  expect(rec.out).toHaveLength(1);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual({
    sessionId: "s1",
    turnId: "t1",
    reason: "completed",
    text: "Hello",
  });
  expect(rec.writes).toEqual([]);
  expect(rec.err).toEqual([]);
});

test("a failed turn prints a fixed error and exits 1", async () => {
  const client = fakeClient(() => undefined);
  const error = { code: "turn.empty", message: "Context has no visible messages" };
  client.setResponder(
    completedResponder(client, [deltaEvent("partial"), endedEvent("failed", { error })]),
  );
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io }), client.deps);

  expect(code).toBe(1);
  expect(rec.writes).toEqual(["partial", "\n"]);
  expect(rec.err).toEqual(["error: turn.empty: Context has no visible messages"]);
});

test("a failed turn with --json includes the error and writes no stderr", async () => {
  const client = fakeClient(() => undefined);
  const error = { code: "turn.empty", message: "Context has no visible messages" };
  client.setResponder(completedResponder(client, [endedEvent("failed", { error })]));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, json: true }), client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual([]);
  expect(rec.out).toHaveLength(1);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual({
    sessionId: "s1",
    turnId: "t1",
    reason: "failed",
    text: "",
    error,
  });
});

test("--continue chooses the newest session by createdAt", async () => {
  const client = fakeClient((method) => {
    if (method === "session.list") return { sessions: [OLD, META, META_2] };
    if (method === "session.subscribe") return { sessionId: "s2" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start")
      return startAndEmit(client, [endedEvent("completed", { sessionId: "s2" })]);
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, continueSession: true, print: true }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls[0]).toEqual({ method: "session.list", params: {} });
  expect(client.calls[1]).toEqual({ method: "session.subscribe", params: { sessionId: "s2" } });
  expect(client.calls.some((call) => call.method === "session.create")).toBe(false);
});

test("--continue keeps daemon order when createdAt ties", async () => {
  const client = fakeClient((method) => {
    if (method === "session.list") return { sessions: [TIE_A, TIE_B] };
    if (method === "session.subscribe") return { sessionId: "s-tie-a" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start")
      return startAndEmit(client, [endedEvent("completed", { sessionId: "s-tie-a" })]);
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, continueSession: true, print: true }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls[1]).toEqual({
    method: "session.subscribe",
    params: { sessionId: "s-tie-a" },
  });
});

test("--continue with no sessions reports session.not_found and exits 1", async () => {
  const client = fakeClient((method) => {
    if (method === "session.list") return { sessions: [] };
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, continueSession: true }),
    client.deps,
  );

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: session.not_found: Session does not exist"]);
  expect(client.calls).toEqual([{ method: "session.list", params: {} }]);
  expect(client.closed).toBe(true);
});

test("--session reads the existing session and never creates one", async () => {
  const client = fakeClient((method) => {
    if (method === "session.read")
      return { meta: META, seq: 0, records: [], queue: [], selection: [] };
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") return startAndEmit(client, [endedEvent("completed")]);
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, sessionId: "s1", print: true }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls[0]).toEqual({ method: "session.read", params: { sessionId: "s1" } });
  expect(client.calls.some((call) => call.method === "session.create")).toBe(false);
});

test("--session --create creates a new session when the requested one is missing", async () => {
  const client = fakeClient((method) => {
    if (method === "session.read")
      throw new ClientError("session.not_found", "Session does not exist");
    if (method === "session.create") return META_2;
    if (method === "session.subscribe") return { sessionId: "s2" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start")
      return startAndEmit(client, [endedEvent("completed", { sessionId: "s2" })]);
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, {
      io: rec.io,
      sessionId: "missing",
      create: true,
      model: "m",
      provider: "p",
      print: true,
    }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls[1]).toEqual({
    method: "session.create",
    params: { provider: "p", model: "m" },
  });
  expect(client.calls[2]).toEqual({ method: "session.subscribe", params: { sessionId: "s2" } });
});

test("--session without --create propagates session.not_found", async () => {
  const client = fakeClient((method) => {
    if (method === "session.read")
      throw new ClientError("session.not_found", "Session does not exist");
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, sessionId: "missing" }),
    client.deps,
  );

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: session.not_found: Session does not exist"]);
  expect(client.calls.some((call) => call.method === "session.create")).toBe(false);
  expect(client.closed).toBe(true);
});

test("an existing session is configured with exactly the provided fields", async () => {
  const client = fakeClient((method) => {
    if (method === "session.read")
      return { meta: META, seq: 0, records: [], queue: [], selection: [] };
    if (method === "session.configure") return META;
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") return startAndEmit(client, [endedEvent("completed")]);
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, {
      io: rec.io,
      sessionId: "s1",
      model: "m2",
      provider: "p2",
      systemPrompt: "be brief",
      print: true,
    }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls[1]).toEqual({
    method: "session.configure",
    params: { sessionId: "s1", model: "m2", provider: "p2", systemPrompt: "be brief" },
  });
  expect(client.calls.some((call) => call.method === "session.create")).toBe(false);
});

test("--use-default-system-prompt on an existing session fails before queue writes", async () => {
  const client = fakeClient((method) => {
    if (method === "session.read")
      return { meta: META, seq: 0, records: [], queue: [], selection: [] };
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, {
      io: rec.io,
      sessionId: "s1",
      useDefaultSystemPrompt: true,
    }),
    client.deps,
  );

  expect(code).toBe(1);
  expect(rec.err).toEqual([
    "error: run.default_system_prompt_unsupported: Default system prompt applies only to new sessions",
  ]);
  expect(client.calls).toEqual([{ method: "session.read", params: { sessionId: "s1" } }]);
  expect(client.closed).toBe(true);
});

test("--use-default-system-prompt is accepted for a new session", async () => {
  const client = fakeClient((method) => {
    if (method === "session.create") return META;
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") return startAndEmit(client, [endedEvent("completed")]);
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, useDefaultSystemPrompt: true, print: true }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls[0]).toEqual({ method: "session.create", params: {} });
});

test("--enable/--disable sends one toggle declaration in the same batch as the prompt", async () => {
  const client = fakeClient((method, params) => {
    if (method === "session.create") return META;
    if (method === "session.read")
      return { meta: META, seq: 0, records: [], queue: [], selection: ["a#x", "b#y"] };
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1", "q2"] };
    if (method === "turn.start") return startAndEmit(client, [endedEvent("completed")]);
    throw new Error(`unexpected method ${method} ${JSON.stringify(params)}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, {
      io: rec.io,
      enable: ["c#z", "a#x"],
      disable: ["b#y"],
      print: true,
    }),
    client.deps,
  );

  expect(code).toBe(0);
  const enqueue = client.calls.find((call) => call.method === "queue.enqueue");
  expect(enqueue?.params).toEqual({
    sessionId: "s1",
    entries: [
      {
        kind: "control",
        role: "declaration",
        source: "run",
        content: [{ type: "text", text: JSON.stringify({ toggle: ["c#z", "b#y"] }) }],
      },
      {
        kind: "agent",
        role: "user",
        source: "run",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  });
});

test("no toggle declaration is sent when the selection would not change", async () => {
  const client = fakeClient((method) => {
    if (method === "session.create") return META;
    if (method === "session.read")
      return { meta: META, seq: 0, records: [], queue: [], selection: ["a#x"] };
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") return startAndEmit(client, [endedEvent("completed")]);
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, {
      io: rec.io,
      enable: ["a#x"],
      disable: ["b#y"],
      print: true,
    }),
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls.some((call) => call.method === "entries.snapshot")).toBe(false);
  const enqueue = client.calls.find((call) => call.method === "queue.enqueue");
  expect(enqueue?.params).toEqual({
    sessionId: "s1",
    entries: [
      {
        kind: "agent",
        role: "user",
        source: "run",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  });
});

const PROMPT_ENTRY = {
  kind: "agent",
  role: "user",
  source: "run",
  content: [{ type: "text", text: "hello" }],
};

const controlEntry = (toggle: string[]): unknown => ({
  kind: "control",
  role: "declaration",
  source: "run",
  content: [{ type: "text", text: JSON.stringify({ toggle }) }],
});

/** One unconfirmed declaration as the daemon's context snapshot reports it. */
const pendingDeclaration = (toggle: string[]): unknown => ({
  id: "q-pending",
  kind: "control",
  role: "declaration",
  source: "config",
  content: [{ type: "text", text: JSON.stringify({ toggle }) }],
  createdAt: "2026-11-01T00:00:00.000Z",
});

/** The same declaration once the daemon has folded it into the committed selection. */
const confirmedDeclaration = (toggle: string[]): unknown => ({
  ...(pendingDeclaration(toggle) as Record<string, unknown>),
  confirmedAt: "2026-11-02T00:00:00.000Z",
});

async function toggleEntries(
  selection: string[],
  queue: unknown[],
  enable: string[],
  disable: string[],
): Promise<{ entries: unknown[]; client: FakeClient; code: number }> {
  const client = fakeClient((method) => {
    switch (method) {
      case "session.create":
        return META;
      case "session.read":
        return { meta: META, seq: 0, records: [], queue, selection };
      case "session.subscribe":
        return { sessionId: "s1" };
      case "queue.enqueue":
        return { ids: ["q1", "q2"] };
      case "turn.start":
        return startAndEmit(client, [endedEvent("completed")]);
      default:
        throw new Error(`unexpected method ${method}`);
    }
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, enable, disable, print: true }),
    client.deps,
  );
  const enqueue = client.calls.find((call) => call.method === "queue.enqueue");
  if (enqueue === undefined) throw new Error("queue.enqueue was not sent");
  return { entries: (enqueue.params as { entries: unknown[] }).entries, client, code };
}

test("a pending declaration is replayed before diffing the requested toggles", async () => {
  const queue = [pendingDeclaration(["a#x"])];

  const enablingPending = await toggleEntries([], queue, ["a#x"], []);
  expect(enablingPending.code).toBe(0);
  expect(enablingPending.entries).toEqual([PROMPT_ENTRY]);
  // One unqualified read supplies both the selection and the queue.
  expect(enablingPending.client.calls.filter((call) => call.method === "session.read")).toEqual([
    { method: "session.read", params: { sessionId: "s1" } },
  ]);
  const methods = enablingPending.client.calls.map((call) => call.method);
  expect(methods).not.toContain("entries.snapshot");
  expect(methods.indexOf("session.read")).toBeLessThan(methods.indexOf("session.subscribe"));

  expect((await toggleEntries([], queue, [], ["a#x"])).entries).toEqual([
    controlEntry(["a#x"]),
    PROMPT_ENTRY,
  ]);
  expect((await toggleEntries([], queue, ["b#y"], [])).entries).toEqual([
    controlEntry(["b#y"]),
    PROMPT_ENTRY,
  ]);
});

test("a pending declaration that disables a committed selection is replayed", async () => {
  const queue = [pendingDeclaration(["a#x"])];

  expect((await toggleEntries(["a#x"], queue, ["a#x"], [])).entries).toEqual([
    controlEntry(["a#x"]),
    PROMPT_ENTRY,
  ]);
  expect((await toggleEntries(["a#x"], queue, [], ["a#x"])).entries).toEqual([PROMPT_ENTRY]);
});

test("every pending declaration is replayed against the committed selection", async () => {
  const queue = [pendingDeclaration(["a#x"]), pendingDeclaration(["a#x"])];

  // Committed a#x, then two flips: off, back on. Applying only the last
  // declaration, or diffing against the raw committed selection, ends off and
  // would send a redundant enable here.
  expect((await toggleEntries(["a#x"], queue, ["a#x"], [])).entries).toEqual([PROMPT_ENTRY]);
  expect((await toggleEntries(["a#x"], queue, [], ["a#x"])).entries).toEqual([
    controlEntry(["a#x"]),
    PROMPT_ENTRY,
  ]);

  // A confirmed declaration is part of the committed selection, never replayed.
  expect(
    (await toggleEntries(["a#x"], [confirmedDeclaration(["a#x"])], ["a#x"], [])).entries,
  ).toEqual([PROMPT_ENTRY]);
  expect(
    (await toggleEntries(["a#x"], [confirmedDeclaration(["b#y"])], [], ["b#y"])).entries,
  ).toEqual([PROMPT_ENTRY]);
});

test("duplicate extension names are a usage error before connecting", async () => {
  const { configPath } = await fixture();
  const counter = { connects: 0 };

  const within = await runCommand(
    runOptions(configPath, { enable: ["a#x", "a#x"] }),
    unreachableDeps(counter),
  );
  const across = await runCommand(
    runOptions(configPath, { enable: ["a#x"], disable: ["a#x"] }),
    unreachableDeps(counter),
  );

  expect(within).toBe(2);
  expect(across).toBe(2);
  expect(counter.connects).toBe(0);
});

test("unrelated events are ignored and only the first matching ended turn completes", async () => {
  const client = fakeClient(() => undefined);
  client.setResponder(
    completedResponder(client, [
      deltaEvent("other-session", { sessionId: "s9" }),
      deltaEvent("other-turn", { turnId: "t9" }),
      deltaEvent("reasoning", { kind: "reasoning" }),
      deltaEvent("real"),
      endedEvent("completed", { sessionId: "s9" }),
      endedEvent("completed", { turnId: "t9" }),
      endedEvent("completed"),
      endedEvent("cancelled"),
    ]),
  );
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, json: true }), client.deps);

  expect(code).toBe(0);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual({
    sessionId: "s1",
    turnId: "t1",
    reason: "completed",
    text: "real",
  });
});

test("an interrupt cancels once, waits for the ended turn and exits 130", async () => {
  let cancellations = 0;
  const client = fakeClient((method) => {
    if (method === "session.create") return META;
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") {
      setTimeout(() => {
        client.interrupt();
        client.interrupt();
      }, 0);
      return { turnId: "t1", mode: "new" };
    }
    if (method === "turn.cancel") {
      cancellations += 1;
      queueMicrotask(() => client.emit(endedEvent("cancelled")));
      return { cancelled: true };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, print: true }), client.deps);

  expect(code).toBe(130);
  expect(cancellations).toBe(1);
  expect(client.calls.filter((call) => call.method === "turn.cancel")).toEqual([
    { method: "turn.cancel", params: { turnId: "t1" } },
  ]);
  expect(client.calls.some((call) => call.method === "turn.start")).toBe(true);
  expect(client.closed).toBe(true);
  expect(rec.err).toEqual([]);
});

test("an interrupt before the turn id is known cancels once after turn.start responds", async () => {
  const client = fakeClient((method) => {
    if (method === "session.create") return META;
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") {
      // The signal arrives while the start request is still in flight.
      client.interrupt();
      return { turnId: "t1", mode: "new" };
    }
    if (method === "turn.cancel") {
      queueMicrotask(() => client.emit(endedEvent("cancelled")));
      return { cancelled: true };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, print: true }), client.deps);

  expect(code).toBe(130);
  expect(client.calls.filter((call) => call.method === "turn.cancel")).toEqual([
    { method: "turn.cancel", params: { turnId: "t1" } },
  ]);
  expect(client.log.indexOf("request:turn.cancel")).toBeGreaterThan(
    client.log.indexOf("request:turn.start"),
  );
});

test("a config failure exits 2 without connecting", async () => {
  const { root } = await fixture();
  const counter = { connects: 0 };
  const rec = recorder();

  const code = await runCommand(
    runOptions(join(root, "missing.json"), { io: rec.io }),
    unreachableDeps(counter),
  );

  expect(code).toBe(2);
  expect(rec.err).toEqual(["error: config.invalid: Invalid configuration"]);
  expect(counter.connects).toBe(0);
});

test("a connect failure prints daemon.unreachable without raw details", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps: RunDeps = {
    async connect(): Promise<Client> {
      throw new Error("connect ECONNREFUSED /secret");
    },
    onInterrupt(): () => void {
      return () => {};
    },
  };

  const code = await runCommand(runOptions(configPath, { io: rec.io }), deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual([`error: daemon.unreachable: ${UNREACHABLE_MESSAGE}`]);
  expect(rec.err.join("\n")).not.toContain("ECONNREFUSED");
});

test("a protocol error passes through its safe code and message", async () => {
  const client = fakeClient(() => {
    throw new ClientError("protocol.invalid_request", "Invalid request parameters");
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io }), client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: protocol.invalid_request: Invalid request parameters"]);
  expect(client.closed).toBe(true);
  // Every registration is removed on the error path, not only on success.
  expect(client.log).toContain("event:unsubscribe");
  expect(client.log).toContain("close:unsubscribe");
  expect(client.log).toContain("interrupt:unregister");
  expect(client.listenerCount()).toBe(0);
});

test("a malformed session result is rejected as client.protocol", async () => {
  const client = fakeClient(() => ({ id: 1 }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io }), client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: client.protocol: Invalid response from daemon"]);
});

test("a malformed session read on the toggle path is rejected as client.protocol", async () => {
  const client = fakeClient((method) => {
    if (method === "session.create") return META;
    if (method === "session.read") return { meta: META, seq: 0, records: [] };
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(
    runOptions(configPath, { io: rec.io, enable: ["a#x"], print: true }),
    client.deps,
  );

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: client.protocol: Invalid response from daemon"]);
});

test("a daemon close mid-turn exits 1 with client.closed instead of hanging", async () => {
  const client = fakeClient((method) => {
    if (method === "session.create") return META;
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") {
      setTimeout(() => {
        client.closeWith("client.closed", "Client is closed");
        // Any later event must not settle the wait after the connection died.
        client.emit(endedEvent("completed"));
      }, 0);
      return { turnId: "t1", mode: "new" };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, print: true }), client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: client.closed: Client is closed"]);
  expect(rec.out).toEqual([]);
  expect(rec.writes).toEqual([]);
  expect(client.log).toContain("event:unsubscribe");
  expect(client.log).toContain("close:unsubscribe");
  expect(client.log).toContain("interrupt:unregister");
});

test("a malformed frame mid-turn exits 1 with client.protocol", async () => {
  const client = fakeClient((method) => {
    if (method === "session.create") return META;
    if (method === "session.subscribe") return { sessionId: "s1" };
    if (method === "queue.enqueue") return { ids: ["q1"] };
    if (method === "turn.start") {
      setTimeout(() => client.closeWith("client.protocol", "Invalid response from daemon"), 0);
      return { turnId: "t1", mode: "new" };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCommand(runOptions(configPath, { io: rec.io, json: true }), client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: client.protocol: Invalid response from daemon"]);
  expect(rec.out).toEqual([]);
  // A protocol failure goes through the same cleanup as a socket close.
  expect(client.log).toContain("event:unsubscribe");
  expect(client.log).toContain("close:unsubscribe");
  expect(client.log).toContain("interrupt:unregister");
  expect(client.listenerCount()).toBe(0);
});

test("default output falls back to io.out when io.write is absent", async () => {
  const client = fakeClient(() => undefined);
  client.setResponder(
    completedResponder(client, [deltaEvent("a"), deltaEvent("b"), endedEvent("completed")]),
  );
  const { configPath } = await fixture();
  const rec = recorder(false);

  const code = await runCommand(runOptions(configPath, { io: rec.io }), client.deps);

  expect(code).toBe(0);
  expect(rec.out).toEqual(["a", "b", ""]);
});

test("runCli accepts a prompt before flags and dispatches run", async () => {
  const client = fakeClient(() => undefined);
  client.setResponder(completedResponder(client, [endedEvent("completed")]));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCli(
    ["run", "hello", "--print", "--config", configPath],
    rec.io,
    undefined,
    undefined,
    undefined,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.calls[0]?.method).toBe("session.create");
});

test("runCli rejects run usage errors without connecting", async () => {
  const cases = [
    ["run"],
    ["run", ""],
    ["run", "hello", "--bogus"],
    ["run", "hello", "extra"],
    ["run", "hello", "--new", "--continue"],
    ["run", "hello", "--new", "--session", "s1"],
    ["run", "hello", "--continue", "--session", "s1"],
    ["run", "hello", "--create"],
    ["run", "hello", "--print", "--json"],
    ["run", "hello", "--system-prompt", "x", "--use-default-system-prompt"],
    ["run", "hello", "--model"],
    ["run", "hello", "--model", ""],
    ["run", "hello", "--enable", "a#x", "--disable", "a#x"],
    ["run", "hello", "--session", "bad id"],
    ["run", "hello", "--session", "bad/id"],
    ["run", "hello", "--enable", "nopackage#"],
    ["run", "hello", "--enable", "#noname"],
    ["run", "hello", "--disable", "a#b#c"],
    ["run", "hello", "--enable", "a b#x"],
    ["run", "hello", "--disable", "a#b c"],
  ];
  const counter = { connects: 0 };
  const deps = unreachableDeps(counter);

  for (const argv of cases) {
    const rec = recorder();
    const code = await runCli(argv, rec.io, undefined, undefined, undefined, undefined, deps);
    expect(code, argv.join(" ")).toBe(2);
    expect(rec.err.join("\n"), argv.join(" ")).toContain("usage:");
    expect(rec.out).toEqual([]);
  }
  expect(counter.connects).toBe(0);
});

test("run accumulates --enable/--disable and keeps the last value of each value flag", async () => {
  const client = fakeClient((method) => {
    switch (method) {
      case "session.read":
        return { meta: META, seq: 0, records: [], queue: [], selection: [] };
      case "session.configure":
        return META;
      case "session.subscribe":
        return { sessionId: "s1" };
      case "queue.enqueue":
        return { ids: ["q1", "q2"] };
      case "turn.start":
        return startAndEmit(client, [endedEvent("completed")]);
      default:
        throw new Error(`unexpected method ${method}`);
    }
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCli(
    [
      "run",
      "--enable",
      "a#x",
      "--disable",
      "b#y",
      "--enable",
      "c#z",
      "--session",
      "s1",
      "--session",
      "s2",
      "--model",
      "m1",
      "--model",
      "m2",
      "--data-dir",
      "/first",
      "--data-dir",
      "/second",
      "--system-prompt",
      "one",
      "--system-prompt",
      "two",
      "hello",
      "--print",
      "--config",
      configPath,
    ],
    rec.io,
    undefined,
    undefined,
    undefined,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.paths).toEqual([socketPathFor("/second")]);
  expect(client.calls.slice(0, 2)).toEqual([
    { method: "session.read", params: { sessionId: "s2" } },
    { method: "session.configure", params: { sessionId: "s1", model: "m2", systemPrompt: "two" } },
  ]);
  expect(client.calls.filter((call) => call.method === "session.read")).toEqual([
    { method: "session.read", params: { sessionId: "s2" } },
    { method: "session.read", params: { sessionId: "s1" } },
  ]);
  const enqueue = client.calls.find((call) => call.method === "queue.enqueue");
  expect(enqueue?.params).toEqual({
    sessionId: "s1",
    entries: [controlEntry(["a#x", "c#z"]), PROMPT_ENTRY],
  });
});

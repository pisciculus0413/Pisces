import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProviderManagement,
  type ExecuteProvider,
  type LlmAdapter,
  type ProviderManagement,
  type SessionNode,
} from "@pisces/core";
import {
  type DaemonHost,
  type ProviderHost,
  type SessionListResult,
  type SessionReadResult,
  startDaemon,
  type TurnListResult,
} from "@pisces/daemon";
import { afterEach, expect, test, vi } from "vitest";
import { type Client, connectClient } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { readPidRecord } from "../src/lifecycle.js";
import { type RunDeps, type RunOptions, runCommand } from "../src/run.js";

/**
 * Real-socket and built-CLI acceptance for non-interactive `pisces run`.
 *
 * A genuine in-process daemon (native transport, real Unix socket, real
 * `SessionStore`) serves host defaults for workspace/provider/model and three
 * providers: `ok` streams two text deltas that concatenate to "world" (so
 * `--print` can be shown to write only the concatenated final text, never the
 * deltas or the "hello" prompt), `blocked` keeps the turn
 * open until the turn is cancelled, and `fail` throws while parsing the provider
 * response. The CLI function runs with production dependencies against that
 * socket, so session creation, queued prompt, event subscription, `--print`/`--json`
 * output, `--continue`, failure, interruption and the toggle rejection are all
 * proven end to end. One built-CLI subprocess test covers `--print` against a
 * daemon held by this process (no network).
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const BUILT = existsSync(MAIN);
const KEY_ENV = "PISCES_TEST_KEY";
const KEY_VALUE = "sk-test-not-real";
const FIRST_DELTA = "wor";
const SECOND_DELTA = "ld";
/** Concatenated deltas; deliberately different from the prompt "hello". */
const FINAL_TEXT = `${FIRST_DELTA}${SECOND_DELTA}`;
const SOCKET_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 5_000;

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
  workspace: string;
}

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const clients: Client[] = [];
const children = new Set<ChildProcess>();
const observedPids = new Set<number>();

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  children.clear();

  for (const root of roots.splice(0)) {
    const record = await readPidRecord(join(root, "data"));
    if (record !== undefined) observedPids.add(record.pid);
    await rm(root, { recursive: true, force: true });
  }
  for (const pid of observedPids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ESRCH: already gone.
    }
  }
  observedPids.clear();
});

const adapter: LlmAdapter = {
  dialect: "test",
  buildRequest(request) {
    return { path: "/v1/chat/completions", body: JSON.stringify(request) };
  },
  parseChunk() {
    // Two content deltas make the accumulated final text distinguishable from
    // the streamed increments (and from the prompt echo).
    return [
      { type: "content", delta: FIRST_DELTA },
      { type: "content", delta: SECOND_DELTA },
      { type: "stop", reason: "stop" },
    ];
  },
};

/** Parsing throws, so the turn ends `failed` with a redacted protocol code. */
const failingAdapter: LlmAdapter = {
  dialect: "fail",
  buildRequest(request) {
    return { path: "/v1/chat/completions", body: JSON.stringify(request) };
  },
  parseChunk() {
    throw new Error(`token=${KEY_VALUE}`);
  },
};

/** Keeps the turn running until the daemon aborts the provider signal. */
const blockedExecute: ExecuteProvider = async function* (_request, signal) {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
};

function testProviders(): ProviderManagement {
  const providers = createProviderManagement();
  for (const [id, dialect] of [
    ["ok", "test"],
    ["blocked", "test"],
    ["fail", "fail"],
  ] as const) {
    providers.registerProvider({
      id,
      dialect,
      baseUrl: "https://provider.test/v1",
      auth: { type: "apiKey", credentialRef: "test" },
      models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
    });
  }
  providers.registerDialect("test", () => adapter);
  providers.registerDialect("fail", () => failingAdapter);
  return providers;
}

function testProviderHost(): ProviderHost {
  return {
    execute(providerId) {
      if (providerId === "blocked") return blockedExecute;
      return () =>
        (async function* () {
          yield "frame";
        })();
    },
    async ready() {
      return true;
    },
  };
}

async function makeFixture(): Promise<Fixture> {
  // `realpath` keeps the Unix socket path short and free of symlinked parents.
  const root = await realpath(await mkdtemp(join(tmpdir(), "pisces-run-e2e-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      providers: [
        {
          id: "cli-unused",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: KEY_ENV,
          models: [{ id: "unused", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
    "utf8",
  );
  return { root, dataDir, configPath, workspace };
}

async function startAcceptanceDaemon(fixture: Fixture): Promise<DaemonHost> {
  const host = await startDaemon({
    dataDir: fixture.dataDir,
    providers: testProviders(),
    providerHost: testProviderHost(),
    // `run` supplies no selector, workspace, provider or model, so the session
    // meta must come from these daemon defaults.
    defaults: { workspace: fixture.workspace, provider: "ok", model: "m" },
  });
  hosts.push(host);
  return host;
}

async function openClient(socketPath: string): Promise<Client> {
  const client = await connectClient(socketPath);
  clients.push(client);
  return client;
}

async function request<T>(
  client: Client,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return (await client.request(method, params)) as T;
}

const sessionList = (client: Client): Promise<SessionListResult> =>
  request<SessionListResult>(client, "session.list", {});

const turnList = (client: Client): Promise<TurnListResult> =>
  request<TurnListResult>(client, "turn.list", {});

async function readRecords(client: Client, sessionId: string): Promise<SessionNode[]> {
  return (await request<SessionReadResult>(client, "session.read", { sessionId })).records;
}

async function waitForNoTurns(client: Client): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await turnList(client)).turns).toEqual([]);
    },
    { timeout: WAIT_TIMEOUT_MS, interval: 10 },
  );
}

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

function runOptions(fixture: Fixture, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    configPath: fixture.configPath,
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

interface InterruptSeam {
  deps: RunDeps;
  handlers: (() => void)[];
  unregistered: () => number;
}

/** Production connection with a captured SIGINT seam. */
function interruptDeps(): InterruptSeam {
  const handlers: (() => void)[] = [];
  let unregistered = 0;
  const deps: RunDeps = {
    connect: (socketPath, timeoutMs) => connectClient(socketPath, timeoutMs),
    onInterrupt(handler) {
      handlers.push(handler);
      return () => {
        unregistered += 1;
        const index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      };
    },
  };
  return { deps, handlers, unregistered: () => unregistered };
}

test("run --print completes a real turn and persists the session with daemon defaults", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);

  const printed = recorder();
  expect(await runCommand(runOptions(fixture, { io: printed.io, print: true }))).toBe(0);
  expect(printed.err).toEqual([]);
  // The provider streams "wor" and "ld"; `--print` writes only the joined
  // final text once. A delta-per-line implementation would print two lines, and
  // a prompt echo would print "hello": both fail here.
  expect(printed.out).toEqual([FINAL_TEXT]);

  const client = await openClient(host.socketPath);
  const sessions = (await sessionList(client)).sessions;
  expect(sessions).toHaveLength(1);
  const meta = sessions[0];
  if (meta === undefined) throw new Error("missing persisted session");
  expect(meta.provider).toBe("ok");
  expect(meta.model).toBe("m");
  expect(meta.workspace).toBe(fixture.workspace);

  const records = await readRecords(client, meta.id);
  expect(records.map((node) => node.role)).toEqual(["user", "assistant"]);
  expect(records[0]?.content).toEqual([{ type: "text", text: "hello" }]);
  expect(records[1]?.content).toEqual([{ type: "text", text: FINAL_TEXT }]);
});

test("run --json emits exactly one completed object", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);

  const json = recorder();
  expect(await runCommand(runOptions(fixture, { io: json.io, json: true }))).toBe(0);
  expect(json.err).toEqual([]);
  // One line, no streamed deltas and no wrapper.
  expect(json.out).toHaveLength(1);
  const line = json.out[0] ?? "";
  expect(line).not.toContain("\n");
  const parsed = JSON.parse(line) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual(["reason", "sessionId", "text", "turnId"]);
  expect(parsed).toMatchObject({ reason: "completed", text: FINAL_TEXT });
  // The JSON text is the provider's answer, not an echo of the prompt.
  expect(parsed.text).not.toBe("hello");
  expect(typeof parsed.sessionId).toBe("string");
  expect(typeof parsed.turnId).toBe("string");

  const client = await openClient(host.socketPath);
  const sessions = (await sessionList(client)).sessions;
  expect(sessions.map((session) => session.id)).toEqual([parsed.sessionId]);
});

test("run --continue picks the persisted session", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);

  const first = recorder();
  expect(await runCommand(runOptions(fixture, { io: first.io, print: true }))).toBe(0);
  expect(first.out).toEqual([FINAL_TEXT]);

  const client = await openClient(host.socketPath);
  const sessions = (await sessionList(client)).sessions;
  expect(sessions).toHaveLength(1);
  const firstId = sessions[0]?.id;
  if (firstId === undefined) throw new Error("missing persisted session");

  const continued = recorder();
  expect(
    await runCommand(runOptions(fixture, { io: continued.io, json: true, continueSession: true })),
  ).toBe(0);
  expect(continued.err).toEqual([]);
  expect(continued.out).toHaveLength(1);
  const parsed = JSON.parse(continued.out[0] ?? "") as Record<string, unknown>;
  expect(parsed).toMatchObject({ sessionId: firstId, reason: "completed", text: FINAL_TEXT });
  expect(parsed.text).not.toBe("hello");
  // `--continue` reuses the session instead of creating another one.
  expect((await sessionList(client)).sessions.map((session) => session.id)).toEqual([firstId]);
  // The second turn was really appended to that session.
  const records = await readRecords(client, firstId);
  expect(records.map((node) => node.role)).toEqual(["user", "assistant", "user", "assistant"]);
  // Each appended pair keeps the prompt and the provider answer distinct.
  expect(records.map((node) => node.content)).toEqual([
    [{ type: "text", text: "hello" }],
    [{ type: "text", text: FINAL_TEXT }],
    [{ type: "text", text: "hello" }],
    [{ type: "text", text: FINAL_TEXT }],
  ]);
});

test("a failed turn exits 1 with a JSON error and no success text", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  await startAcceptanceDaemon(fixture);

  const json = recorder();
  expect(
    await runCommand(
      runOptions(fixture, { io: json.io, json: true, provider: "fail", model: "m" }),
    ),
  ).toBe(1);
  // Failed turns under `--json` report the error in the object, not on stderr.
  expect(json.err).toEqual([]);
  expect(json.out).toHaveLength(1);
  const parsed = JSON.parse(json.out[0] ?? "") as {
    reason: string;
    text: string;
    error?: { code: string; message: string };
  };
  expect(parsed.reason).toBe("failed");
  expect(parsed.text).toBe("");
  // The daemon projects every failed turn except `turn.empty` onto its fixed
  // `internal.error` pair, so the CLI can only forward that safe code. The
  // allowlisted `turn.empty` mapping is pinned by `run-command.test.ts`.
  expect(parsed.error).toEqual({ code: "internal.error", message: "Turn failed" });

  const printed = recorder();
  expect(
    await runCommand(runOptions(fixture, { io: printed.io, print: true, provider: "fail" })),
  ).toBe(1);
  expect(printed.out.join("")).toBe("");
  expect(printed.err).toEqual(["error: internal.error: Turn failed"]);
});

test("an injected interrupt cancels the live turn and exits 130", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  const client = await openClient(host.socketPath);
  const { deps, handlers, unregistered } = interruptDeps();
  const interrupted = recorder();

  const pending = runCommand(
    runOptions(fixture, { io: interrupted.io, print: true, provider: "blocked" }),
    deps,
  );
  await vi.waitFor(() => expect(handlers).toHaveLength(1), {
    timeout: WAIT_TIMEOUT_MS,
    interval: 10,
  });
  // Only interrupt once the daemon really lists the turn, as a terminal Ctrl-C would.
  await vi.waitFor(
    async () => {
      expect((await turnList(client)).turns).toHaveLength(1);
    },
    { timeout: WAIT_TIMEOUT_MS, interval: 10 },
  );
  const handler = handlers[0];
  if (handler === undefined) throw new Error("missing interrupt handler");
  handler();

  expect(await pending).toBe(130);
  expect(interrupted.err).toEqual([]);
  // Cancelled: no success text, one trailing newline at most.
  expect(interrupted.out.join("")).toBe("");
  expect(unregistered()).toBe(1);
  await waitForNoTurns(client);
});

test("run reports daemon.unreachable after the daemon stops", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  await host.stop();
  const index = hosts.indexOf(host);
  if (index !== -1) hosts.splice(index, 1);

  const unreachable = recorder();
  expect(await runCommand(runOptions(fixture, { io: unreachable.io, print: true }))).toBe(1);
  expect(unreachable.out).toEqual([]);
  expect(unreachable.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
});

test("a toggle against a no-extension daemon fails safely with queue.invalid_control", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);

  const toggled = recorder();
  expect(
    await runCommand(runOptions(fixture, { io: toggled.io, print: true, enable: ["pkg#tool"] })),
  ).toBe(1);
  expect(toggled.out).toEqual([]);
  expect(toggled.err).toEqual(["error: queue.invalid_control: Invalid queue entry"]);

  // The rejection happened at queue time: no turn ran and no session was persisted.
  const client = await openClient(host.socketPath);
  await waitForNoTurns(client);
  expect((await sessionList(client)).sessions).toEqual([]);
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { ...process.env, [KEY_ENV]: KEY_VALUE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      reject(new Error(`pisces ${args.join(" ")} did not exit\n${stdout}${stderr}`));
    }, CLI_TIMEOUT_MS - 5_000);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const command = (fixture: Fixture, args: string[]): string[] => [
  ...args,
  "--config",
  fixture.configPath,
  "--data-dir",
  fixture.dataDir,
];

test.skipIf(!BUILT)(
  "the built CLI runs a turn with --print",
  { timeout: CLI_TIMEOUT_MS },
  async () => {
    const fixture = await makeFixture();
    const host = await startAcceptanceDaemon(fixture);

    const result = await run(command(fixture, ["run", "hello", "--print"]));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${FINAL_TEXT}\n`);

    const client = await openClient(host.socketPath);
    const sessions = (await sessionList(client)).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "ok",
      model: "m",
      workspace: fixture.workspace,
    });
    const records = await readRecords(client, sessions[0]?.id ?? "");
    expect(records.map((node) => node.role)).toEqual(["user", "assistant"]);
  },
);

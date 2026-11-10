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
  type SessionMeta,
  type SessionNode,
} from "@pisces/core";
import {
  type DaemonHost,
  type ProviderHost,
  type SessionReadResult,
  startDaemon,
  type TurnListResult,
  type TurnStartResult,
} from "@pisces/daemon";
import { afterEach, expect, test, vi } from "vitest";
import { type Client, connectClient } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { readPidRecord } from "../src/lifecycle.js";
import { sessionCancel } from "../src/session-cancel.js";
import { sessionExport } from "../src/session-export.js";

/**
 * Real-socket and built-CLI acceptance for `sessions export` and `sessions cancel`.
 *
 * A genuine in-process daemon (native transport, real Unix socket, real
 * `SessionStore`) commits nodes for a normal provider and holds a turn open on a
 * blocked provider. The CLI functions run with production dependencies against
 * that socket, so the JSONL export and the turn cancellation are proven end to
 * end rather than against a fake client. One built-CLI subprocess test covers
 * full-tree export and idle cancel (no `--node`, no live cancel) against a
 * daemon held by this process.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const BUILT = existsSync(MAIN);
const KEY_ENV = "PISCES_TEST_KEY";
const KEY_VALUE = "sk-test-not-real";
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
    return [
      { type: "content", delta: "ok" },
      { type: "stop", reason: "stop" },
    ];
  },
};

/** `ok` commits one assistant node; `blocked` keeps the turn running until aborted. */
const blockedExecute: ExecuteProvider = async function* (_request, signal) {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
};

function testProviders(): ProviderManagement {
  const providers = createProviderManagement();
  for (const id of ["ok", "blocked"]) {
    providers.registerProvider({
      id,
      dialect: "test",
      baseUrl: "https://provider.test/v1",
      auth: { type: "apiKey", credentialRef: "test" },
      models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
    });
  }
  providers.registerDialect("test", () => adapter);
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "pisces-sessions-e2e-")));
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

const turnList = (client: Client): Promise<TurnListResult> =>
  request<TurnListResult>(client, "turn.list", {});

const readTree = async (client: Client, sessionId: string): Promise<SessionNode[]> =>
  (await request<SessionReadResult>(client, "session.read", { sessionId })).records;

const queueUserEntry = (sessionId: string): Record<string, unknown> => ({
  sessionId,
  entries: [
    {
      kind: "agent",
      role: "user",
      source: "test",
      content: [{ type: "text", text: "hello" }],
    },
  ],
});

/** Creates a session on the `ok` provider and waits for its turn to finish and commit. */
async function committedSession(
  fixture: Fixture,
  client: Client,
): Promise<{ sessionId: string; records: SessionNode[] }> {
  const created = await request<SessionMeta>(client, "session.create", {
    workspace: fixture.workspace,
    provider: "ok",
    model: "m",
  });
  await request(client, "queue.enqueue", queueUserEntry(created.id));
  await request(client, "turn.start", { sessionId: created.id });

  let records: SessionNode[] = [];
  await vi.waitFor(
    async () => {
      expect((await turnList(client)).turns).toEqual([]);
      records = await readTree(client, created.id);
      expect(records.length).toBeGreaterThan(0);
    },
    { timeout: WAIT_TIMEOUT_MS, interval: 20 },
  );
  return { sessionId: created.id, records };
}

/** Creates a session on the `blocked` provider and waits until its turn is listed. */
async function blockedSession(
  fixture: Fixture,
  client: Client,
): Promise<{ sessionId: string; turnId: string }> {
  const created = await request<SessionMeta>(client, "session.create", {
    workspace: fixture.workspace,
    provider: "blocked",
    model: "m",
  });
  await request(client, "queue.enqueue", queueUserEntry(created.id));
  const started = await request<TurnStartResult>(client, "turn.start", { sessionId: created.id });
  await vi.waitFor(
    async () => {
      expect((await turnList(client)).turns).toContainEqual({
        sessionId: created.id,
        turnId: started.turnId,
        startedAt: expect.any(String),
      });
    },
    { timeout: WAIT_TIMEOUT_MS, interval: 10 },
  );
  return { sessionId: created.id, turnId: started.turnId };
}

async function waitForNoTurn(client: Client, sessionId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const turns = await turnList(client);
      expect(turns.turns.filter((turn) => turn.sessionId === sessionId)).toEqual([]);
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

const jsonl = (lines: readonly string[]): SessionNode[] =>
  lines.map((line) => JSON.parse(line) as SessionNode);

test("sessions export streams the forked tree and one node branch", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  const client = await openClient(host.socketPath);
  const base = await committedSession(fixture, client);
  const sessionId = base.sessionId;
  const rootId = base.records[0]?.id;
  if (rootId === undefined) throw new Error("missing root node");

  // Fork: start a second turn from the root with a fresh queued entry. The session
  // now holds two real branches, so the tree and the selected branch differ.
  await request(client, "queue.enqueue", queueUserEntry(sessionId));
  await request(client, "turn.start", { sessionId, nodeId: rootId });
  let tree: SessionNode[] = [];
  await vi.waitFor(
    async () => {
      expect((await turnList(client)).turns).toEqual([]);
      tree = await readTree(client, sessionId);
      expect(tree).toHaveLength(base.records.length + 2);
    },
    { timeout: WAIT_TIMEOUT_MS, interval: 20 },
  );
  const treeIds = tree.map((node) => node.id);

  const exported = recorder();
  expect(await sessionExport({ configPath: fixture.configPath, io: exported.io, sessionId })).toBe(
    0,
  );
  expect(exported.err).toEqual([]);
  // One JSON object per line, no wrapper: the line count is the record count.
  expect(exported.out).toHaveLength(tree.length);
  const lines = jsonl(exported.out);
  expect(lines.map((node) => node.id)).toEqual(treeIds);
  // Every line is exactly the record the daemon returned.
  expect(lines).toEqual(tree);

  const leaf = tree.at(-1);
  if (leaf === undefined) throw new Error("missing last exported node");
  const leafId = leaf.id;
  const branchWire = (
    await request<SessionReadResult>(client, "session.read", { sessionId, nodeId: leafId })
  ).records;
  const branchIds = branchWire.map((node) => node.id);
  // The fork makes the tree wider than the selected branch.
  expect(branchIds.length).toBeLessThan(treeIds.length);
  expect(branchIds).not.toEqual(treeIds);

  // The branch is exactly the leaf and its ancestors, from root through the leaf.
  const byId = new Map(tree.map((node) => [node.id, node]));
  const ancestors: string[] = [];
  let current: SessionNode | undefined = byId.get(leafId);
  while (current !== undefined) {
    ancestors.push(current.id);
    current = current.id === current.parentId ? undefined : byId.get(current.parentId);
  }
  ancestors.reverse();
  expect(branchIds).toEqual(ancestors);
  expect(branchIds).toContain(rootId);

  const branch = recorder();
  expect(
    await sessionExport({
      configPath: fixture.configPath,
      io: branch.io,
      sessionId,
      nodeId: leafId,
    }),
  ).toBe(0);
  expect(branch.err).toEqual([]);
  const branchLines = jsonl(branch.out);
  expect(branchLines).toEqual(branchWire);
  expect(branchLines.map((node) => node.id)).toEqual(branchIds);

  // Export is read-only: neither export changed the stored tree.
  const reread = await readTree(client, sessionId);
  expect(reread.map((node) => node.id)).toEqual(treeIds);

  await host.stop();
  hosts.splice(hosts.indexOf(host), 1);

  const unreachable = recorder();
  expect(
    await sessionExport({ configPath: fixture.configPath, io: unreachable.io, sessionId }),
  ).toBe(1);
  expect(unreachable.out).toEqual([]);
  expect(unreachable.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
});

test("sessions cancel ends the active turn of one session", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const host = await startAcceptanceDaemon(fixture);
  const client = await openClient(host.socketPath);
  const { sessionId, turnId } = await blockedSession(fixture, client);

  const cancelled = recorder();
  expect(await sessionCancel({ configPath: fixture.configPath, io: cancelled.io, sessionId })).toBe(
    0,
  );
  expect(cancelled.err).toEqual([]);
  expect(cancelled.out).toEqual([`cancelled ${turnId}`]);
  await waitForNoTurn(client, sessionId);

  // Idempotent: the turn is gone, so a second cancel is success with no work.
  const again = recorder();
  expect(await sessionCancel({ configPath: fixture.configPath, io: again.io, sessionId })).toBe(0);
  expect(again.err).toEqual([]);
  expect(again.out).toEqual(["no active turn"]);

  await host.stop();
  hosts.splice(hosts.indexOf(host), 1);

  const unreachable = recorder();
  expect(
    await sessionCancel({ configPath: fixture.configPath, io: unreachable.io, sessionId }),
  ).toBe(1);
  expect(unreachable.out).toEqual([]);
  expect(unreachable.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
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
  "the built CLI exports a real session and reports an idle cancel",
  { timeout: CLI_TIMEOUT_MS },
  async () => {
    const fixture = await makeFixture();
    const host = await startAcceptanceDaemon(fixture);
    const client = await openClient(host.socketPath);
    const { sessionId, records: tree } = await committedSession(fixture, client);

    const exported = await run(command(fixture, ["sessions", "export", sessionId]));
    expect(exported.stderr).toBe("");
    expect(exported.code).toBe(0);
    expect(jsonl(exported.stdout.trim().split("\n"))).toEqual(tree);

    // No turn was started on this session, so cancelling it is idempotent success.
    const idle = await run(command(fixture, ["sessions", "cancel", sessionId]));
    expect(idle.stderr).toBe("");
    expect(idle.code).toBe(0);
    expect(idle.stdout).toBe("no active turn\n");
  },
);

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ClientError, UNREACHABLE_MESSAGE } from "../src/client.js";
import {
  type ClientCommandsClient,
  type ClientCommandsDeps,
  clientList,
  clientStart,
} from "../src/client-commands.js";
import type { CommandIo } from "../src/commands.js";
import { runCli } from "../src/main.js";

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
  const root = await mkdtemp(join(tmpdir(), "pisces-clients-cli-"));
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
          apiKeyEnv: "PISCES_CLIENTS_TEST_KEY",
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
  );
  return { root, dataDir, configPath };
}

const REGISTRATION = { id: "repl", source: "@demo/x", entry: "/tmp/demo/client.mjs" };

type Responder = (method: string, params: unknown) => unknown;

interface FakeClient {
  calls: { method: string; params: unknown }[];
  closed: boolean;
  socketPath: string | undefined;
  deps: ClientCommandsDeps;
}

function fakeClient(responder: Responder): FakeClient {
  const state: FakeClient = {
    calls: [],
    closed: false,
    socketPath: undefined,
    deps: {
      async connect(socketPath: string): Promise<ClientCommandsClient> {
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

const clientsResult = { clients: [REGISTRATION] };

test("client list prints id and source", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const client = fakeClient(() => clientsResult);

  expect(await clientList({ configPath, io: rec.io }, client.deps)).toBe(0);

  expect(rec.out).toEqual(["repl  @demo/x"]);
  expect(rec.err).toEqual([]);
  expect(client.calls).toEqual([{ method: "client.list", params: {} }]);
  expect(client.closed).toBe(true);
});

test("client list keeps an empty registry silent", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  expect(
    await clientList({ configPath, io: rec.io }, fakeClient(() => ({ clients: [] })).deps),
  ).toBe(0);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual([]);
});

test("client list --json echoes the response", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  expect(
    await clientList({ configPath, io: rec.io, json: true }, fakeClient(() => clientsResult).deps),
  ).toBe(0);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual(clientsResult);
});

test("client list rejects a malformed response", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  for (const responder of [
    () => ({ clients: [{ id: "repl", entry: "/tmp/x.mjs" }] }),
    () => ({ clients: [{ id: "", source: "@demo/x", entry: "/tmp/x.mjs" }] }),
    () => ({ clients: "nope" }),
    () => ({}),
  ]) {
    expect(await clientList({ configPath, io: rec.io }, fakeClient(responder).deps)).toBe(1);
  }
  expect(
    rec.err.every((line) => line === "error: client.protocol: Invalid response from daemon"),
  ).toBe(true);
});

test("client list validates before echoing json", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  for (const responder of [
    () => ({ clients: [{ id: "repl" }] }),
    () => ({ clients: "nope" }),
    () => ({}),
  ]) {
    expect(
      await clientList({ configPath, io: rec.io, json: true }, fakeClient(responder).deps),
    ).toBe(1);
  }
  expect(rec.out).toEqual([]);
});

test("client list --json drops unexpected fields", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  expect(
    await clientList(
      { configPath, io: rec.io, json: true },
      fakeClient(() => ({ clients: [{ ...REGISTRATION, extra: "x" }], ignored: true })).deps,
    ),
  ).toBe(0);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual({ clients: [REGISTRATION] });
});

test("client start prints the pid", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const client = fakeClient(() => ({ pid: 4242 }));

  expect(await clientStart({ configPath, io: rec.io, id: "repl" }, client.deps)).toBe(0);

  expect(rec.out).toEqual(["started repl (pid 4242)"]);
  expect(client.calls).toEqual([{ method: "client.start", params: { id: "repl" } }]);
});

test("client start --json prints the pid object", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  expect(
    await clientStart(
      { configPath, io: rec.io, id: "repl", json: true },
      fakeClient(() => ({ pid: 4242 })).deps,
    ),
  ).toBe(0);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual({ pid: 4242 });
});

test("client start rejects a malformed pid", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  for (const responder of [() => ({ pid: 0 }), () => ({ pid: 1.5 }), () => ({ pid: "42" })]) {
    expect(
      await clientStart({ configPath, io: rec.io, id: "repl" }, fakeClient(responder).deps),
    ).toBe(1);
  }
});

test("client start maps protocol errors to exit 1", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps = fakeClient(() => {
    throw new ClientError("client.not_found", "Client is not registered");
  }).deps;

  expect(await clientStart({ configPath, io: rec.io, id: "missing" }, deps)).toBe(1);
  expect(rec.err).toEqual(["error: client.not_found: Client is not registered"]);
});

test("client commands report an unreachable daemon", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps: ClientCommandsDeps = {
    async connect() {
      throw new Error("ECONNREFUSED");
    },
  };

  expect(await clientList({ configPath, io: rec.io }, deps)).toBe(1);
  expect(rec.err).toEqual([`error: daemon.unreachable: ${UNREACHABLE_MESSAGE}`]);
});

test("client commands reject an invalid configuration with exit 2", async () => {
  const root = await mkdtemp(join(tmpdir(), "pisces-clients-cli-bad-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  await writeFile(configPath, "{");
  const rec = recorder();

  expect(await clientList({ configPath, io: rec.io }, fakeClient(() => clientsResult).deps)).toBe(
    2,
  );
  expect(rec.err).toEqual(["error: config.invalid: Invalid configuration"]);
});

test("runCli dispatches client list and client start", async () => {
  const { configPath } = await fixture();

  const listRec = recorder();
  const listClient = fakeClient(() => clientsResult);
  expect(
    await runCli(
      ["client", "list", "--config", configPath, "--json"],
      listRec.io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      listClient.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(listRec.out[0] ?? "")).toEqual(clientsResult);

  const startRec = recorder();
  const startClient = fakeClient(() => ({ pid: 4242 }));
  expect(
    await runCli(
      ["client", "start", "repl", "--config", configPath],
      startRec.io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      startClient.deps,
    ),
  ).toBe(0);
  expect(startRec.out).toEqual(["started repl (pid 4242)"]);
});

test("client usage errors exit 2", async () => {
  const { configPath } = await fixture();
  const rec = recorder();

  for (const argv of [
    ["client"],
    ["client", "bogus"],
    ["client", "start"],
    ["client", "start", "a", "b"],
    ["client", "list", "extra"],
  ]) {
    expect(
      await runCli(
        [...argv, "--config", configPath],
        rec.io,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        fakeClient(() => clientsResult).deps,
      ),
    ).toBe(2);
  }
});

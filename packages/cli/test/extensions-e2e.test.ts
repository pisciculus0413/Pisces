import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ContentBlock,
  createProviderManagement,
  type EntryName,
  type JsonValue,
  type LlmAdapter,
  type LlmRequest,
  type ProviderManagement,
} from "@pisces/core";
import {
  type DaemonHost,
  type ProviderHost,
  type SessionListResult,
  type SessionReadResult,
  startDaemon,
} from "@pisces/daemon";
import { afterEach, expect, test } from "vitest";
import { buildDaemonOptions } from "../src/assembly.js";
import { type Client, connectClient } from "../src/client.js";
import type { CommandIo } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { type RunOptions, runCommand } from "../src/run.js";

/**
 * Real-socket acceptance for the CLI extension assembly.
 *
 * The daemon is always started from exactly the options `pisces start` builds
 * (`buildDaemonOptions` + `startDaemon`), so the config file path, create-time
 * extension read and workspace extension scan are the production code paths.
 * The CLI runs with production dependencies against that socket.
 *
 * Non-shell variants keep the real provider host and point `baseUrl` at a
 * localhost OpenAI-compatible SSE server. The built-in shell variants replace
 * only the provider seam with an in-memory `test` dialect: the encoded
 * `@pisces/builtin-shell#shell` wire name is 74 characters, above the 64-char
 * limit of the real openai-chat adapter (see the task report), so the adapter
 * wire format is deliberately out of scope for these shell assertions. The
 * extension config assembly and the shell execution itself stay real.
 */

const KEY_ENV = "PISCES_EXTENSIONS_E2E_KEY";
const KEY_VALUE = "sk-test-not-real";
const SHELL = "@pisces/builtin-shell#shell" as EntryName;
const SHELL_OUTPUT = "tool-ok";
const ALT_TOOL = "altpkg#hello" as EntryName;
const ALT_OUTPUT = "alt-tool-output";
const WORKSPACE_TOOL = "wsdemo#hello" as EntryName;
const WORKSPACE_OUTPUT = "workspace-tool-output";
const SOCKET_TIMEOUT_MS = 30_000;

interface Fixture {
  root: string;
  dataDir: string;
  workspace: string;
  configPath: string;
}

interface SseRequest {
  model: string;
  messages: { role: string; content: string | null }[];
  tools?: { type: string; function: { name: string; description: string } }[];
}

interface SseServer {
  baseUrl: string;
  requests: SseRequest[];
  close(): Promise<void>;
}

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const clients: Client[] = [];
const servers: SseServer[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const server of servers.splice(0).reverse()) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

/**
 * Serves one OpenAI-compatible streaming turn: when the request declares a
 * tool and the latest message is not its result, answer with that tool call;
 * afterwards (or without tools) answer with the final text.
 */
async function startSseServer(options: {
  final: string;
  toolArguments: Record<string, unknown>;
}): Promise<SseServer> {
  const requests: SseRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SseRequest;
      requests.push(parsed);
      const tool = parsed.tools?.[0];
      const awaitingResult = parsed.messages.at(-1)?.role === "tool";
      const frames: string[] = [];
      if (tool !== undefined && !awaitingResult) {
        frames.push(
          frame({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: {
                        name: tool.function.name,
                        arguments: JSON.stringify(options.toolArguments),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        );
      } else {
        frames.push(
          frame({
            choices: [{ index: 0, delta: { content: options.final }, finish_reason: null }],
          }),
          frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        );
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`${frames.join("")}data: [DONE]\n\n`);
    });
    request.on("error", () => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  const handle: SseServer = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  servers.push(handle);
  return handle;
}

const configValue = (
  dataDir: string,
  workspace: string,
  baseUrl: string,
  extensions?: readonly string[],
): unknown => ({
  dataDir,
  providers: [
    {
      id: "stub",
      baseUrl,
      apiKeyEnv: KEY_ENV,
      models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
    },
  ],
  defaults: { provider: "stub", model: "m" },
  defaultWorkspace: workspace,
  ...(extensions === undefined ? {} : { extensions }),
});

async function makeFixture(prefix = "pisces-ext-e2e-"): Promise<Fixture> {
  // `realpath` keeps the Unix socket path short and free of symlinked parents.
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  const dataDir = join(root, "data");
  const workspace = join(root, "ws");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace);
  return { root, dataDir, workspace, configPath: join(root, "config.json") };
}

async function writeConfig(
  configPath: string,
  dataDir: string,
  workspace: string,
  baseUrl: string,
  extensions?: readonly string[],
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(configValue(dataDir, workspace, baseUrl, extensions)),
    "utf8",
  );
}

async function daemonOptionsFor(fixture: Fixture) {
  const config = await loadConfig(fixture.configPath);
  return buildDaemonOptions(
    config,
    fixture.dataDir,
    { [KEY_ENV]: KEY_VALUE },
    { configPath: fixture.configPath },
  );
}

async function startAcceptanceDaemon(fixture: Fixture): Promise<DaemonHost> {
  // Exactly what `pisces start` passes, including the real provider host.
  const host = await startDaemon(await daemonOptionsFor(fixture));
  hosts.push(host);
  return host;
}

/**
 * Calls the shell when the request declares it and the latest message is not
 * a result, then finishes with text; records every request for assertions.
 */
function shellAdapter(captured: LlmRequest[], toolArguments: JsonValue, final: string): LlmAdapter {
  let pendingToolCall = false;
  return {
    dialect: "test",
    buildRequest(request) {
      captured.push(request);
      const declaresShell = (request.tools ?? []).some((tool) => tool.name === SHELL);
      pendingToolCall = declaresShell && request.messages.at(-1)?.role !== "tool";
      return { path: "/v1/chat/completions", body: JSON.stringify({ model: request.model }) };
    },
    parseChunk() {
      const call = pendingToolCall;
      pendingToolCall = false;
      if (call) {
        return [
          {
            type: "toolCall" as const,
            call: { id: "call_1", name: SHELL, arguments: toolArguments },
          },
          { type: "stop" as const, reason: "toolCall" as const },
        ];
      }
      return [
        { type: "content" as const, delta: final },
        { type: "stop" as const, reason: "stop" as const },
      ];
    },
  };
}

function shellProviders(adapter: LlmAdapter): ProviderManagement {
  const providers = createProviderManagement();
  providers.registerProvider({
    id: "stub",
    dialect: "test",
    baseUrl: "https://provider.test/v1",
    auth: { type: "apiKey", credentialRef: "stub" },
    models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
  });
  providers.registerDialect("test", () => adapter);
  return providers;
}

const immediateFrames: ProviderHost = {
  execute() {
    return async function* () {
      yield "frame";
    };
  },
  async ready() {
    return true;
  },
};

/** Same assembly as `pisces start`, with only the provider seam replaced. */
async function startShellDaemon(
  fixture: Fixture,
  captured: LlmRequest[],
  toolArguments: JsonValue,
  final: string,
): Promise<DaemonHost> {
  const options = await daemonOptionsFor(fixture);
  const host = await startDaemon({
    ...options,
    providers: shellProviders(shellAdapter(captured, toolArguments, final)),
    providerHost: immediateFrames,
  });
  hosts.push(host);
  return host;
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
    prompt: "run the tool",
    newSession: false,
    continueSession: false,
    create: false,
    useDefaultSystemPrompt: false,
    enable: [],
    disable: [],
    print: true,
    json: false,
    ...overrides,
  };
}

type ToolResultBlock = Extract<ContentBlock, { type: "toolResult" }>;

const toolResults = (read: SessionReadResult): ToolResultBlock[] =>
  read.records.flatMap((record) =>
    record.content.filter((block): block is ToolResultBlock => block.type === "toolResult"),
  );

const toolResultText = (block: ToolResultBlock): string =>
  block.content.map((inner) => (inner.type === "text" ? inner.text : "")).join("\n");

const toolCallNames = (read: SessionReadResult): string[] =>
  read.records.flatMap((record) =>
    record.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : [])),
  );

const requestText = (request: LlmRequest | undefined): string => JSON.stringify(request?.messages);

interface ObservedSession {
  sessions: SessionListResult["sessions"];
  read: SessionReadResult;
}

/** Reads the only persisted session over a fresh real-socket connection. */
async function observedSession(host: DaemonHost): Promise<ObservedSession> {
  const client = await connectClient(host.socketPath);
  clients.push(client);
  const sessions = (await client.request("session.list", {})) as unknown as SessionListResult;
  expect(sessions.sessions).toHaveLength(1);
  const id = sessions.sessions[0]?.id;
  if (id === undefined) throw new Error("missing persisted session");
  const read = (await client.request("session.read", { sessionId: id })) as unknown as
    | SessionReadResult
    | undefined;
  if (read === undefined) throw new Error("missing session read");
  return { sessions: sessions.sessions, read };
}

async function makePackage(root: string, name: string, output: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(join(dir, "tools"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }), "utf8");
  await writeFile(
    join(dir, "tools", "hello.ts"),
    [
      "export default async function hello() {",
      `  return { content: [{ type: "text", text: ${JSON.stringify(output)} }] };`,
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "tools", "hello.ts.meta.json"),
    JSON.stringify({
      description: `${name} hello tool`,
      parameters: { type: "object", properties: {} },
    }),
    "utf8",
  );
}

test("a configured shell extension starts from buildDaemonOptions and run executes it", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  await writeConfig(
    fixture.configPath,
    fixture.dataDir,
    fixture.workspace,
    "http://127.0.0.1:9/v1",
    [SHELL],
  );

  const options = await daemonOptionsFor(fixture);
  // The CLI always injects the exact config file; the daemon reads extensions from it.
  expect(options.extensions).toEqual({ configPath: fixture.configPath });

  const captured: LlmRequest[] = [];
  const host = await startShellDaemon(
    fixture,
    captured,
    { command: `printf ${SHELL_OUTPUT}` },
    "shell-final",
  );
  const rec = recorder();
  expect(await runCommand(runOptions(fixture, { io: rec.io }))).toBe(0);
  expect(rec.err).toEqual([]);
  expect(rec.out).toEqual(["shell-final"]);

  // The provider loop saw the shell declaration, then the real command output.
  expect(captured).toHaveLength(2);
  expect(captured[0]?.tools?.map((tool) => tool.name)).toEqual([SHELL]);
  expect(requestText(captured[1])).toContain(SHELL_OUTPUT);

  const { sessions, read } = await observedSession(host);
  expect(sessions[0]?.workspace).toBe(fixture.workspace);
  expect(toolCallNames(read)).toEqual([SHELL]);
  const results = toolResults(read);
  expect(results).toHaveLength(1);
  expect(results[0]?.isError).toBeUndefined();
  const text = toolResultText(results[0] as ToolResultBlock);
  expect(text).toContain("exit code: 0");
  expect(text).toContain(SHELL_OUTPUT);
});

test("run --enable selects the shell when the config declares no extensions", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  await writeConfig(
    fixture.configPath,
    fixture.dataDir,
    fixture.workspace,
    "http://127.0.0.1:9/v1",
  );

  const captured: LlmRequest[] = [];
  const host = await startShellDaemon(
    fixture,
    captured,
    { command: `printf ${SHELL_OUTPUT}` },
    "enabled-final",
  );
  const rec = recorder();
  expect(await runCommand(runOptions(fixture, { io: rec.io, enable: [SHELL] }))).toBe(0);
  expect(rec.err).toEqual([]);
  expect(rec.out).toEqual(["enabled-final"]);

  expect(captured).toHaveLength(2);
  expect(captured[0]?.tools?.map((tool) => tool.name)).toEqual([SHELL]);
  expect(requestText(captured[1])).toContain(SHELL_OUTPUT);

  const { read } = await observedSession(host);
  expect(toolCallNames(read)).toEqual([SHELL]);
  expect(read.selection).toEqual([SHELL]);
  const text = toolResultText(toolResults(read)[0] as ToolResultBlock);
  expect(text).toContain("exit code: 0");
  expect(text).toContain(SHELL_OUTPUT);
});

test("--config reads the given file and its own extension directory", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const server = await startSseServer({ final: "alt-final", toolArguments: {} });
  const altPath = join(fixture.root, "alt", "alt.json");
  await makePackage(join(fixture.root, "alt", "extensions"), "altpkg", ALT_OUTPUT);
  await writeConfig(altPath, fixture.dataDir, fixture.workspace, server.baseUrl, [ALT_TOOL]);
  // Sibling decoy: without defaults or extensions, reading it would fail the session.
  await writeFile(join(dirname(altPath), "config.json"), JSON.stringify({ broken: true }), "utf8");
  fixture.configPath = altPath;

  const options = await daemonOptionsFor(fixture);
  expect(options.extensions).toEqual({ configPath: altPath });

  const host = await startAcceptanceDaemon(fixture);
  const rec = recorder();
  expect(await runCommand(runOptions(fixture, { io: rec.io }))).toBe(0);
  expect(rec.err).toEqual([]);
  expect(rec.out).toEqual(["alt-final"]);

  // The real provider saw the declared tool and then the executed result.
  expect(server.requests).toHaveLength(2);
  expect(JSON.stringify(server.requests[1]?.messages)).toContain(ALT_OUTPUT);
  const { read } = await observedSession(host);
  expect(toolCallNames(read)).toEqual([ALT_TOOL]);
  expect(toolResultText(toolResults(read)[0] as ToolResultBlock)).toBe(ALT_OUTPUT);
});

test("discovers and executes a tool from the workspace .pisces/extensions", {
  timeout: SOCKET_TIMEOUT_MS,
}, async () => {
  const fixture = await makeFixture();
  const server = await startSseServer({ final: "workspace-final", toolArguments: {} });
  await makePackage(join(fixture.workspace, ".pisces", "extensions"), "wsdemo", WORKSPACE_OUTPUT);
  await writeConfig(fixture.configPath, fixture.dataDir, fixture.workspace, server.baseUrl, [
    WORKSPACE_TOOL,
  ]);

  const host = await startAcceptanceDaemon(fixture);
  const rec = recorder();
  expect(await runCommand(runOptions(fixture, { io: rec.io }))).toBe(0);
  expect(rec.err).toEqual([]);
  expect(rec.out).toEqual(["workspace-final"]);

  expect(server.requests).toHaveLength(2);
  expect(JSON.stringify(server.requests[1]?.messages)).toContain(WORKSPACE_OUTPUT);
  const { read } = await observedSession(host);
  expect(toolCallNames(read)).toEqual([WORKSPACE_TOOL]);
  expect(toolResultText(toolResults(read)[0] as ToolResultBlock)).toBe(WORKSPACE_OUTPUT);
});

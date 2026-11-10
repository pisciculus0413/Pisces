import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderManagement,
  type LlmAdapter,
  type ProviderManagement,
  type SessionId,
  type TemplateInfo,
  type TemplatePreview,
} from "@pisces/core";
import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
import type {
  GatewayResponse,
  SessionReadResult,
  TemplateApplyResult,
  TemplateListResult,
} from "../src/gateway/protocol.js";
import { type DaemonHost, type StartDaemonOptions, startDaemon } from "../src/host/daemon-host.js";
import type { ProviderHost } from "../src/provider/provider-host.js";

/**
 * Real-socket acceptance for `templates`.
 *
 * A genuine daemon (built native transport, real Unix socket, real
 * `TemplateStore`, real `WorkspaceAccess`, real `ExecHost`) mounts a temporary
 * templates directory and workspace. Nothing under test is faked: the init
 * script is an executable file in the temp root and the daemon spawns it.
 */

const SCRIPT_TIMEOUT_MS = 5_000;

interface Fixture {
  root: string;
  dataDir: string;
  workspace: string;
  templatesDir: string;
  script: string;
  marker: string;
  broken: string;
  brokenMarker: string;
  brokenLater: string;
}

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pisces-templates-socket-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  const templatesDir = join(root, "templates");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(workspace);
  await mkdir(templatesDir, { recursive: true });
  const script = join(root, "init.sh");
  const marker = join(root, "init-ran.txt");
  const broken = join(root, "fail.sh");
  const brokenMarker = join(root, "broken-ran.txt");
  const brokenLater = join(root, "broken-after.txt");
  // $1 = marker path: the daemon passes the template `args` unchanged.
  await writeScript(script, 'printf "ran\\n" > "$1"');
  await writeScript(broken, `printf "ran\\n" > "$1"\nexit 4\nprintf "after\\n" > "$2"`);
  return {
    root,
    dataDir,
    workspace,
    templatesDir,
    script,
    marker,
    broken,
    brokenMarker,
    brokenLater,
  };
}

async function writeScript(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o700);
}

function notesTemplate(options: {
  script?: string;
  marker?: string;
  promptFile?: boolean;
}): Record<string, unknown> {
  return {
    id: "notes",
    name: "Notes project",
    description: "Markdown notes",
    directories: ["docs", "docs/archive"],
    files: [
      { path: "README.md", content: "# Notes\n" },
      { path: "docs/.gitkeep", content: "" },
    ],
    ...(options.script === undefined
      ? {}
      : {
          initScript: {
            command: options.script,
            args: [options.marker as string],
            timeoutMs: SCRIPT_TIMEOUT_MS,
          },
        }),
    config: {
      provider: "p",
      model: "m",
      ...(options.promptFile === true ? { systemPromptFile: "README.md" } : {}),
    },
  };
}

async function writeTemplate(
  fixture: Fixture,
  id: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(fixture.templatesDir, `${id}.json`), JSON.stringify(value), "utf8");
}

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

function testProviders(): ProviderManagement {
  const providers = createProviderManagement();
  providers.registerProvider({
    id: "p",
    dialect: "test",
    baseUrl: "https://provider.test/v1",
    auth: { type: "apiKey", credentialRef: "test" },
    models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
  });
  providers.registerDialect("test", () => adapter);
  return providers;
}

function readyProviderHost(): ProviderHost {
  return {
    execute() {
      return async function* () {
        yield "frame";
      };
    },
    async ready() {
      return true;
    },
  };
}

function daemonOptions(fixture: Fixture, templates: boolean): StartDaemonOptions {
  return {
    dataDir: fixture.dataDir,
    providers: testProviders(),
    providerHost: readyProviderHost(),
    ...(templates ? { templates: { configDir: fixture.templatesDir } } : {}),
  };
}

type WireResponse = GatewayResponse;

let requestSeq = 0;

class Client {
  private buffer = "";
  private readonly waiters = new Map<string, (response: WireResponse) => void>();
  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => {});
  }

  static connect(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const fail = (): void => reject(socket.errored ?? new Error("connection failed"));
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        const client = new Client(socket);
        clients.push(client);
        resolve(client);
      });
      socket.once("error", fail);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as WireResponse;
      const waiter = this.waiters.get(parsed.id);
      if (waiter === undefined) continue;
      this.waiters.delete(parsed.id);
      waiter(parsed);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<WireResponse> {
    const id = `req-${++requestSeq}`;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, resolve);
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error === null || error === undefined) return;
        this.waiters.delete(id);
        reject(error);
      });
    });
  }

  hello(): Promise<WireResponse> {
    return this.request("protocol.hello", { versions: [PROTOCOL_VERSION] });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function ok(
  client: Client,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await client.request(method, params);
  if (response.error) throw new Error(`${method}: ${response.error.code}`);
  return response.result;
}

async function openDaemon(
  fixture: Fixture,
  templates = true,
): Promise<{ host: DaemonHost; client: Client }> {
  const host = await startDaemon(daemonOptions(fixture, templates));
  hosts.push(host);
  const client = await Client.connect(host.socketPath);
  const hello = await client.hello();
  expect(hello.result).toMatchObject({ compatible: true });
  return { host, client };
}

async function errorOf(
  client: Client,
  method: string,
  params: Record<string, unknown> = {},
): Promise<string> {
  const response = await client.request(method, params);
  expect(response.result).toBeUndefined();
  expect(response.error).toBeDefined();
  return (response.error as { code: string }).code;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const listOf = async (path: string): Promise<string[]> => {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
};

const readSession = async (client: Client, sessionId: string): Promise<SessionReadResult> =>
  (await ok(client, "session.read", { sessionId })) as SessionReadResult;

async function projectRecords(dataDir: string): Promise<Record<string, unknown>[]> {
  try {
    return JSON.parse(await readFile(join(dataDir, "projects.json"), "utf8")) as Record<
      string,
      unknown
    >[];
  } catch {
    return [];
  }
}

test("lists and previews a template without touching the workspace", async () => {
  const fixture = await makeFixture();
  await writeTemplate(
    fixture,
    "notes",
    notesTemplate({ script: fixture.script, marker: fixture.marker, promptFile: true }),
  );
  const { client } = await openDaemon(fixture);

  const listed = (await ok(client, "template.list")) as TemplateListResult;
  expect(listed.templates).toEqual([
    { id: "notes", name: "Notes project", description: "Markdown notes" } satisfies TemplateInfo,
  ]);

  const preview = (await ok(client, "template.preview", {
    templateId: "notes",
    workspace: fixture.workspace,
  })) as TemplatePreview;
  expect(preview.directories).toEqual(["docs", "docs/archive"]);
  expect(preview.files.map((file) => file.path)).toEqual(["README.md", "docs/.gitkeep"]);
  expect(preview.files[0]?.content).toBe("# Notes\n");
  expect(preview.conflicts).toEqual([]);
  expect(preview.initScript).toEqual({
    command: fixture.script,
    args: [fixture.marker],
    timeoutMs: SCRIPT_TIMEOUT_MS,
  });

  // No side effects: no file, no directory, no project record, no script run.
  expect(await listOf(fixture.workspace)).toEqual([]);
  expect(await projectRecords(fixture.dataDir)).toEqual([]);
  expect(await exists(fixture.marker)).toBe(false);
});

test("refuses apply without confirmation before writing anything", async () => {
  const fixture = await makeFixture();
  await writeTemplate(
    fixture,
    "notes",
    notesTemplate({ script: fixture.script, marker: fixture.marker, promptFile: true }),
  );
  const { client } = await openDaemon(fixture);

  expect(
    await errorOf(client, "template.apply", {
      templateId: "notes",
      workspace: fixture.workspace,
    }),
  ).toBe("protocol.invalid_request");
  expect(
    await errorOf(client, "template.apply", {
      templateId: "notes",
      workspace: fixture.workspace,
      confirmed: false,
    }),
  ).toBe("protocol.invalid_request");

  expect(await listOf(fixture.workspace)).toEqual([]);
  expect(await projectRecords(fixture.dataDir)).toEqual([]);
  expect(await exists(fixture.marker)).toBe(false);
});

test("reports a workspace conflict and leaves the existing file alone", async () => {
  const fixture = await makeFixture();
  await writeTemplate(
    fixture,
    "notes",
    notesTemplate({ script: fixture.script, marker: fixture.marker, promptFile: true }),
  );
  await writeFile(join(fixture.workspace, "README.md"), "user content\n", "utf8");
  const { client } = await openDaemon(fixture);

  const preview = (await ok(client, "template.preview", {
    templateId: "notes",
    workspace: fixture.workspace,
  })) as TemplatePreview;
  expect(preview.conflicts).toEqual(["README.md"]);

  expect(
    await errorOf(client, "template.apply", {
      templateId: "notes",
      workspace: fixture.workspace,
      confirmed: true,
    }),
  ).toBe("template.workspace_conflict");

  expect(await readFile(join(fixture.workspace, "README.md"), "utf8")).toBe("user content\n");
  expect(await listOf(fixture.workspace)).toEqual(["README.md"]);
  expect(await projectRecords(fixture.dataDir)).toEqual([]);
  expect(await exists(fixture.marker)).toBe(false);
});

test("applies for real: files, init script, one project record, queued template prompt", async () => {
  const fixture = await makeFixture();
  await writeTemplate(
    fixture,
    "notes",
    notesTemplate({ script: fixture.script, marker: fixture.marker, promptFile: true }),
  );
  const { client } = await openDaemon(fixture);

  const applied = (await ok(client, "template.apply", {
    templateId: "notes",
    workspace: fixture.workspace,
    confirmed: true,
  })) as TemplateApplyResult;
  expect(applied.projectId).toEqual(expect.any(String));
  expect(applied.sessionId).toEqual(expect.any(String));

  expect(await readFile(join(fixture.workspace, "README.md"), "utf8")).toBe("# Notes\n");
  expect(await readFile(join(fixture.workspace, "docs/.gitkeep"), "utf8")).toBe("");
  expect(await exists(join(fixture.workspace, "docs/archive"))).toBe(true);
  // The real script ran with argv and cwd inside the workspace.
  expect(await readFile(fixture.marker, "utf8")).toBe("ran\n");

  const records = await projectRecords(fixture.dataDir);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    id: applied.projectId,
    templateId: "notes",
    workspace: fixture.workspace,
  });
  expect(records[0]?.createdAt).toEqual(expect.any(String));

  const session = await readSession(client, applied.sessionId);
  expect(session.meta).toMatchObject({
    id: applied.sessionId,
    provider: "p",
    model: "m",
    workspace: fixture.workspace,
  });
  expect(session.records).toEqual([]);
  expect(session.queue).toHaveLength(1);
  expect(session.queue[0]).toMatchObject({ role: "system", source: "template" });
  expect(session.queue[0]?.content).toEqual([{ type: "text", text: "# Notes\n" }]);

  // A temporary session exists only in memory until the first `turn.start`.
  expect(await listOf(join(fixture.dataDir, "sessions"))).toEqual([]);
  expect(await exists(join(fixture.dataDir, "sessions", applied.sessionId))).toBe(false);
});

test("a failing init script keeps files but records no project and no session", async () => {
  const fixture = await makeFixture();
  await writeTemplate(fixture, "broken", {
    id: "broken",
    name: "Broken project",
    files: [{ path: "started.txt", content: "written\n" }],
    initScript: {
      command: fixture.broken,
      args: [fixture.brokenMarker, fixture.brokenLater],
      timeoutMs: SCRIPT_TIMEOUT_MS,
    },
    config: { provider: "p", model: "m" },
  });
  const { client } = await openDaemon(fixture);

  expect(
    await errorOf(client, "template.apply", {
      templateId: "broken",
      workspace: fixture.workspace,
      confirmed: true,
    }),
  ).toBe("template.init_failed");

  // The script demonstrably ran and stopped at the failing exit code.
  expect(await readFile(fixture.brokenMarker, "utf8")).toBe("ran\n");
  expect(await exists(fixture.brokenLater)).toBe(false);
  // Files written before the script stay (documented contract: no rollback).
  expect(await readFile(join(fixture.workspace, "started.txt"), "utf8")).toBe("written\n");
  expect(await projectRecords(fixture.dataDir)).toEqual([]);
  expect(await listOf(join(fixture.dataDir, "sessions"))).toEqual([]);
});

test("apply rejects a missing workspace before writing; preview stays read-only", async () => {
  const fixture = await makeFixture();
  await writeTemplate(fixture, "notes", notesTemplate({ promptFile: false }));
  const { client } = await openDaemon(fixture);
  const missing = join(fixture.root, "missing-workspace");

  // Preview only resolves paths: it never requires or creates the root.
  const preview = (await ok(client, "template.preview", {
    templateId: "notes",
    workspace: missing,
  })) as TemplatePreview;
  expect(preview.directories).toEqual(["docs", "docs/archive"]);
  expect(preview.conflicts).toEqual([]);
  expect(await exists(missing)).toBe(false);

  expect(
    await errorOf(client, "template.apply", {
      templateId: "notes",
      workspace: missing,
      confirmed: true,
    }),
  ).toBe("session.invalid_workspace");
  expect(await exists(missing)).toBe(false);
  expect(await projectRecords(fixture.dataDir)).toEqual([]);
});

test("unknown templates are not found, for preview and apply", async () => {
  const fixture = await makeFixture();
  const { client } = await openDaemon(fixture);

  expect(
    await errorOf(client, "template.preview", {
      templateId: "absent",
      workspace: fixture.workspace,
    }),
  ).toBe("template.not_found");
  expect(
    await errorOf(client, "template.apply", {
      templateId: "absent",
      workspace: fixture.workspace,
      confirmed: true,
    }),
  ).toBe("template.not_found");
  expect(await listOf(fixture.workspace)).toEqual([]);
  expect(await projectRecords(fixture.dataDir)).toEqual([]);
});

test("session.create with a templateId uses template provider and model only", async () => {
  const fixture = await makeFixture();
  await writeTemplate(fixture, "notes", notesTemplate({ promptFile: false }));
  const { client } = await openDaemon(fixture);

  const created = (await ok(client, "session.create", {
    templateId: "notes",
    workspace: fixture.workspace,
  })) as { id: SessionId; provider: string; model: string };

  expect(created.provider).toBe("p");
  expect(created.model).toBe("m");
  // Creating a session from a template never materialises the template.
  expect(await listOf(fixture.workspace)).toEqual([]);
  expect(await projectRecords(fixture.dataDir)).toEqual([]);
  expect(await exists(join(fixture.workspace, "docs"))).toBe(false);

  const session = await readSession(client, created.id);
  expect(session.meta.provider).toBe("p");
  expect(session.meta.model).toBe("m");
});

test("a daemon without templates keeps the pre-template answers", async () => {
  const fixture = await makeFixture();
  await writeTemplate(fixture, "notes", notesTemplate({ promptFile: false }));
  const { client } = await openDaemon(fixture, false);

  // Negative control: the same request against an unwired daemon fails, so the
  // acceptance above cannot pass on a daemon that silently ignores templates.
  expect(await errorOf(client, "template.list")).toBe("protocol.unknown_method");
  expect(
    await errorOf(client, "template.preview", {
      templateId: "notes",
      workspace: fixture.workspace,
    }),
  ).toBe("protocol.unknown_method");
  expect(
    await errorOf(client, "template.apply", {
      templateId: "notes",
      workspace: fixture.workspace,
      confirmed: true,
    }),
  ).toBe("protocol.unknown_method");
  expect(
    await errorOf(client, "session.create", { templateId: "notes", workspace: fixture.workspace }),
  ).toBe("protocol.invalid_request");
  expect(await listOf(fixture.workspace)).toEqual([]);
});

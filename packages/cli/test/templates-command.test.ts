import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TemplatePreview } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import { buildDaemonOptions } from "../src/assembly.js";
import { ClientError } from "../src/client.js";
import { type CommandDeps, type CommandIo, startCommand } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { runCli } from "../src/main.js";
import {
  APPLY_REQUEST_TIMEOUT_MS,
  type TemplatesClient,
  type TemplatesDeps,
  templatesApply,
  templatesList,
  templatesPreview,
} from "../src/templates.js";

const KEY_ENV = "PISCES_TASK4_TEMPLATES_KEY";
const CHILD_PID = 5151;

const roots: string[] = [];

afterEach(async () => {
  delete process.env[KEY_ENV];
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

async function fixture(extra: Record<string, unknown> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-templates-"));
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
          apiKeyEnv: KEY_ENV,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
      ...extra,
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
  deps: TemplatesDeps;
}

type Responder = (method: string, params: unknown) => unknown;

function fakeClient(responder: Responder): FakeClient {
  const state: FakeClient = {
    calls: [],
    budgets: [],
    closed: false,
    socketPath: undefined,
    deps: {
      async connect(socketPath: string): Promise<TemplatesClient> {
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

function unreachable(error: Error): TemplatesDeps {
  return {
    async connect(): Promise<TemplatesClient> {
      throw error;
    },
  };
}

const LIST_RESULT = {
  templates: [{ id: "notes", name: "Notes project", description: "Markdown notes" }],
};

const PREVIEW_RESULT: TemplatePreview = {
  directories: ["docs", "docs/archive"],
  files: [
    { path: "README.md", content: "# Notes\n" },
    { path: "docs/.gitkeep", content: "" },
  ],
  conflicts: ["README.md"],
  initScript: { command: "/usr/bin/git", args: ["init"], timeoutMs: 60_000 },
};

test("templates list prints ids and names, or the raw result with --json", async () => {
  const client = fakeClient(() => LIST_RESULT);
  const { configPath } = await fixture();
  const rec = recorder();
  const human = await templatesList({ configPath, io: rec.io }, client.deps);
  expect(human).toBe(0);
  expect(client.calls).toEqual([{ method: "template.list", params: {} }]);
  const humanText = rec.out.join("\n");
  expect(humanText).toContain("notes");
  expect(humanText).toContain("Notes project");
  expect(rec.err).toEqual([]);

  const jsonClient = fakeClient(() => LIST_RESULT);
  const jsonRec = recorder();
  const json = await templatesList({ configPath, io: jsonRec.io, json: true }, jsonClient.deps);
  expect(json).toBe(0);
  expect(jsonRec.out).toHaveLength(1);
  expect(JSON.parse(jsonRec.out[0] ?? "")).toEqual(LIST_RESULT);
});

test("templates preview shows directories, files, conflicts and the script", async () => {
  const client = fakeClient(() => PREVIEW_RESULT);
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await templatesPreview(
    {
      configPath,
      io: rec.io,
      templateId: "notes",
      workspace: "/tmp/work",
    },
    client.deps,
  );

  expect(code).toBe(0);
  const [call] = client.calls;
  expect(call?.method).toBe("template.preview");
  expect(call?.params).toEqual({ templateId: "notes", workspace: "/tmp/work" });
  const text = rec.out.join("\n");
  for (const directory of PREVIEW_RESULT.directories) expect(text).toContain(directory);
  for (const file of PREVIEW_RESULT.files) expect(text).toContain(file.path);
  for (const conflict of PREVIEW_RESULT.conflicts) expect(text).toContain(conflict);
  expect(text).toContain("/usr/bin/git init");
  expect(text).toContain("60000");
  expect(text).not.toContain("# Notes");
});

test("templates preview --json prints the raw result", async () => {
  const client = fakeClient(() => PREVIEW_RESULT);
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await templatesPreview(
    {
      configPath,
      io: rec.io,
      json: true,
      templateId: "notes",
      workspace: "/tmp/work",
    },
    client.deps,
  );

  expect(code).toBe(0);
  expect(rec.out).toHaveLength(1);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual(PREVIEW_RESULT);
});

test("templates apply without --confirm exits 2 and sends nothing", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  let connects = 0;
  const deps: TemplatesDeps = {
    async connect(): Promise<TemplatesClient> {
      connects += 1;
      throw new Error("must not connect");
    },
  };

  const code = await templatesApply(
    {
      configPath,
      io: rec.io,
      confirm: false,
      templateId: "notes",
      workspace: "/tmp/work",
    },
    deps,
  );

  expect(code).toBe(2);
  expect(connects).toBe(0);
  expect(rec.out).toEqual([]);
  expect(rec.err.join("\n")).toContain("usage:");
});

test("templates apply sends confirmed true and prints the project and session", async () => {
  const client = fakeClient(() => ({ projectId: "p1", sessionId: "s1" }));
  const { configPath, dataDir } = await fixture();
  const rec = recorder();

  const code = await templatesApply(
    {
      configPath,
      io: rec.io,
      confirm: true,
      overwrite: true,
      templateId: "notes",
      workspace: "/tmp/work",
    },
    client.deps,
  );

  expect(code).toBe(0);
  expect(client.socketPath).toBe(join(dataDir, "run", "pisces.sock"));
  expect(client.calls[0]?.method).toBe("template.apply");
  expect(client.calls[0]?.params).toEqual({
    templateId: "notes",
    workspace: "/tmp/work",
    confirmed: true,
    overwrite: true,
  });
  expect(rec.out).toEqual(["project p1 session s1"]);
  expect(client.closed).toBe(true);
});

test("templates apply omits overwrite unless asked and always closes the client", async () => {
  const client = fakeClient(() => ({ projectId: "p1", sessionId: "s1" }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await templatesApply(
    {
      configPath,
      io: rec.io,
      confirm: true,
      templateId: "notes",
      workspace: "/tmp/work",
    },
    client.deps,
  );

  expect(code).toBe(0);
  const params = client.calls[0]?.params as Record<string, unknown>;
  expect(params).toEqual({ templateId: "notes", workspace: "/tmp/work", confirmed: true });
  expect("overwrite" in params).toBe(false);
  expect(client.closed).toBe(true);
});

test("only apply spends the 660 s request budget", async () => {
  const { configPath } = await fixture();

  const applyClient = fakeClient(() => ({ projectId: "p1", sessionId: "s1" }));
  const applyCode = await templatesApply(
    {
      configPath,
      io: recorder().io,
      confirm: true,
      templateId: "notes",
      workspace: "/tmp/work",
    },
    applyClient.deps,
  );
  expect(applyCode).toBe(0);
  expect(APPLY_REQUEST_TIMEOUT_MS).toBe(660_000);
  expect(applyClient.budgets).toEqual([660_000]);

  const listClient = fakeClient(() => LIST_RESULT);
  await templatesList({ configPath, io: recorder().io }, listClient.deps);
  expect(listClient.budgets).toEqual([undefined]);

  const previewClient = fakeClient(() => PREVIEW_RESULT);
  await templatesPreview(
    { configPath, io: recorder().io, templateId: "notes", workspace: "/tmp/work" },
    previewClient.deps,
  );
  expect(previewClient.budgets).toEqual([undefined]);
});

test("a protocol error is printed unchanged and exits 1", async () => {
  const client = fakeClient(() => {
    throw new ClientError("template.not_found", "Template not found");
  });
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await templatesList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: template.not_found: Template not found"]);
  expect(client.closed).toBe(true);
});

test("an unreachable daemon prints daemon.unreachable with fixed text", async () => {
  const { configPath } = await fixture();
  const rec = recorder();
  const deps = unreachable(new ClientError("daemon.unreachable", "connect ECONNREFUSED /raw"));

  const code = await templatesList({ configPath, io: rec.io }, deps);

  expect(code).toBe(1);
  expect(rec.out).toEqual([]);
  expect(rec.err).toEqual(["error: daemon.unreachable: Daemon is not reachable"]);
  expect(rec.err.join("\n")).not.toContain("ECONNREFUSED");
});

test("an invalid config prints config.invalid and exits 2", async () => {
  const rec = recorder();
  const code = await templatesList(
    { configPath: "/nonexistent/config.json", io: rec.io },
    unreachable(new Error("must not connect")),
  );
  expect(code).toBe(2);
  expect(rec.err).toEqual(["error: config.invalid: Invalid configuration"]);
});

test("a malformed daemon result is rejected as client.protocol", async () => {
  const client = fakeClient(() => ({ templates: "nope" }));
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await templatesList({ configPath, io: rec.io }, client.deps);

  expect(code).toBe(1);
  expect(rec.err).toEqual(["error: client.protocol: Invalid response from daemon"]);
});

test("runCli routes templates subcommands", async () => {
  const client = fakeClient(() => LIST_RESULT);
  const { configPath } = await fixture();
  const rec = recorder();

  const code = await runCli(
    ["templates", "list", "--config", configPath, "--json"],
    rec.io,
    undefined,
    client.deps,
  );

  expect(code).toBe(0);
  expect(JSON.parse(rec.out[0] ?? "")).toEqual(LIST_RESULT);
});

test("runCli rejects templates usage errors and a missing --confirm with exit 2", async () => {
  const cases = [
    ["templates"],
    ["templates", "wat"],
    ["templates", "list", "--workspace", "/tmp"],
    ["templates", "preview"],
    ["templates", "preview", "notes"],
    ["templates", "apply", "notes", "--workspace", "/tmp"],
    ["templates", "list", "notes"],
    ["templates", "apply", "notes", "--workspace", "/tmp", "--overwrite"],
    ["templates", "list", "--bogus"],
  ];
  let connects = 0;
  const deps: TemplatesDeps = {
    async connect(): Promise<TemplatesClient> {
      connects += 1;
      throw new Error("must not connect");
    },
  };

  for (const argv of cases) {
    const rec = recorder();
    const code = await runCli(argv, rec.io, undefined, deps);
    expect(code, argv.join(" ")).toBe(2);
    expect(rec.err.join("\n"), argv.join(" ")).toContain("usage:");
    expect(rec.out).toEqual([]);
  }
  expect(connects).toBe(0);
});

test("start forwards templatesDir as the third child argument", async () => {
  const { dataDir, configPath } = await fixture({ templatesDir: "/tmp/templates" });
  const spawns: string[][] = [];
  let probes = 0;
  const deps: CommandDeps = {
    spawnChild: (_entry, args) => {
      spawns.push(args);
      return { pid: CHILD_PID, exitCode: null, kill: () => {}, unref: () => {} };
    },
    probe: async () => {
      probes += 1;
      return probes > 1;
    },
    isAlive: () => true,
    waitForExit: async () => true,
    sleep: async () => {},
    clock: () => 0,
    now: () => "2026-11-09T00:00:00.000Z",
    signal: () => {},
    listSessions: async () => [],
  };
  const rec = recorder();
  process.env[KEY_ENV] = "sk-task4-secret";

  const code = await startCommand({ configPath, io: rec.io }, deps);

  expect(code).toBe(0);
  expect(spawns[0]).toEqual([configPath, dataDir, "/tmp/templates"]);
  expect(rec.out.join("\n")).toContain("running");
});

test("the child builds templates options from the forwarded directory", async () => {
  const { configPath, dataDir } = await fixture({ templatesDir: "/tmp/templates" });
  const config = await loadConfig(configPath);

  const options = buildDaemonOptions(config, dataDir, { [KEY_ENV]: "sk-test" }, { configPath });

  expect(options.templates).toEqual({ configDir: "/tmp/templates" });
});

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Exec,
  type ExecOptions,
  type ExecResult,
  PiscesError,
  type ProjectRef,
  type WorkspaceAccess,
} from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { appendProject, readProjects } from "../src/templates/projects.js";
import { createTemplateStore, type TemplateStoreOptions } from "../src/templates/store.js";
import { createWorkspaceAccess } from "../src/workspace/access.js";

interface Run {
  command: string;
  args: string[];
  options?: ExecOptions;
}

type Handler = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

let root = "";
let configDir = "";
let dataDir = "";
let workspace = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-templates-store-"));
  configDir = join(root, "config", "templates");
  dataDir = join(root, "data");
  workspace = join(root, "workspace");
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeExec(handler?: Handler): { exec: Exec; runs: Run[] } {
  const runs: Run[] = [];
  const exec: Exec = {
    async run(command, args, options) {
      runs.push(options === undefined ? { command, args } : { command, args, options });
      const patch = handler ? await handler(command, args, options) : {};
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        ...patch,
      };
    },
  };
  return { exec, runs };
}

function makeStore(overrides: Partial<TemplateStoreOptions> = {}) {
  const fake = fakeExec();
  const store = createTemplateStore({
    configDir,
    dataDir,
    workspaceAccess: createWorkspaceAccess,
    exec: fake.exec,
    ...overrides,
  });
  return { store, runs: fake.runs };
}

function loggedAccess(log: string[]): (root: string) => WorkspaceAccess {
  return (root) => {
    const access = createWorkspaceAccess(root);
    return {
      resolve: (path) => access.resolve(path),
      exists: (path) => access.exists(path),
      readFile: (path) => access.readFile(path),
      async ensureDirectory(path) {
        log.push(`dir:${path}`);
        await access.ensureDirectory(path);
      },
      async writeFile(path, content) {
        log.push(`file:${path}`);
        await access.writeFile(path, content);
      },
    };
  };
}

function notesTemplate(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "notes",
    name: "Notes project",
    description: "Notes",
    directories: ["docs", "docs/archive"],
    files: [
      { path: "README.md", content: "# Notes\n" },
      { path: "docs/.gitkeep", content: "" },
    ],
    ...patch,
  };
}

async function writeTemplate(id: string, value: unknown): Promise<void> {
  await writeFile(join(configDir, `${id}.json`), JSON.stringify(value), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rejection(promise: Promise<unknown>): Promise<PiscesError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    return error as PiscesError;
  }
  throw new Error("expected the call to fail");
}

function reference(id: string): ProjectRef {
  return {
    id,
    templateId: "notes",
    workspace,
    createdAt: "2026-11-09T10:00:00.000Z",
  };
}

test("preview lists directories, files and conflicts without writing", async () => {
  await writeTemplate(
    "notes",
    notesTemplate({ initScript: { command: "/usr/bin/true", args: [], timeoutMs: 1500 } }),
  );
  await mkdir(join(workspace, "docs"));
  await writeFile(join(workspace, "docs", ".gitkeep"), "old");
  const { store, runs } = makeStore();
  const preview = await store.preview("notes", workspace);
  expect(preview).toEqual({
    directories: ["docs", "docs/archive"],
    files: [
      { path: "README.md", content: "# Notes\n" },
      { path: "docs/.gitkeep", content: "" },
    ],
    conflicts: ["docs/.gitkeep"],
    initScript: { command: "/usr/bin/true", args: [], timeoutMs: 1500 },
  });
  expect(await exists(join(workspace, "README.md"))).toBe(false);
  expect(await exists(join(workspace, "docs", "archive"))).toBe(false);
  expect(runs).toEqual([]);
  expect(await exists(join(dataDir, "projects.json"))).toBe(false);
});

test("reports invalid for a template rejected at load", async () => {
  await writeTemplate("notes", notesTemplate({ files: [{ path: "../escape.txt", content: "x" }] }));
  const { store } = makeStore();
  const error = await rejection(store.preview("notes", workspace));
  expect(error.code).toBe("template.invalid");
  expect(error.message).toBe("Invalid template");
  expect(await exists(join(root, "escape.txt"))).toBe(false);
});

test("reports not_found for an unknown template id", async () => {
  await writeTemplate("notes", notesTemplate());
  const { store } = makeStore();
  const error = await rejection(store.preview("unknown", workspace));
  expect(error.code).toBe("template.not_found");
});

test("exposes loader issues sorted by id without paths or contents", async () => {
  await writeTemplate("notes", notesTemplate());
  await writeFile(join(configDir, "broken.json"), "{ secret-content", "utf8");
  await writeTemplate("oversized", {
    id: "oversized",
    name: "Oversized",
    description: "x".repeat(1_100_000),
  });
  const { store } = makeStore();
  expect(await store.issues()).toEqual([
    { id: "broken", code: "template.invalid" },
    { id: "oversized", code: "template.invalid" },
  ]);
});

test("preview reports one conflicting file and leaves its mtime alone", async () => {
  await writeTemplate("notes", notesTemplate());
  const target = join(workspace, "README.md");
  await writeFile(target, "# existing\n", "utf8");
  const before = (await stat(target)).mtimeMs;
  const { store } = makeStore();
  const preview = await store.preview("notes", workspace);
  expect(preview.conflicts).toEqual(["README.md"]);
  expect((await stat(target)).mtimeMs).toBe(before);
  expect(await readFile(target, "utf8")).toBe("# existing\n");
});

test("resolve returns defaults and reads the prompt without writing", async () => {
  await writeTemplate(
    "notes",
    notesTemplate({
      config: {
        provider: "openai",
        model: "gpt-4o-mini",
        extensions: ["pkg#entry"],
        systemPromptFile: "README.md",
      },
    }),
  );
  await writeFile(join(workspace, "README.md"), "# Existing prompt\n", "utf8");
  const { store } = makeStore();
  const plan = await store.resolve("notes", workspace);
  expect(plan.preview).toEqual({
    directories: ["docs", "docs/archive"],
    files: [
      { path: "README.md", content: "# Notes\n" },
      { path: "docs/.gitkeep", content: "" },
    ],
    conflicts: ["README.md"],
  });
  expect(plan.defaults).toEqual({
    provider: "openai",
    model: "gpt-4o-mini",
    extensions: ["pkg#entry"],
    systemPrompt: "# Existing prompt\n",
  });
  expect(await exists(join(workspace, "docs"))).toBe(false);
  expect(await exists(join(dataDir, "projects.json"))).toBe(false);
});

test("resolve reports an unknown template", async () => {
  const { store } = makeStore();
  const error = await rejection(store.resolve("notes", workspace));
  expect(error.code).toBe("template.not_found");
});

test("resolve reports a missing prompt file as invalid", async () => {
  await writeTemplate("notes", notesTemplate({ config: { systemPromptFile: "README.md" } }));
  const { store } = makeStore();
  const error = await rejection(store.resolve("notes", workspace));
  expect(error.code).toBe("template.invalid");
  expect(await exists(join(workspace, "README.md"))).toBe(false);
});

test("inspect never reads the prompt file and writes nothing", async () => {
  // The prompt file is one the template is about to create, so a preflight apply must not
  // depend on it existing yet.
  await writeTemplate(
    "notes",
    notesTemplate({
      config: {
        provider: "openai",
        model: "gpt-4o-mini",
        systemPromptFile: "README.md",
      },
    }),
  );
  const { store, runs } = makeStore();
  const plan = await store.inspect("notes", workspace);
  expect(plan.preview).toEqual({
    directories: ["docs", "docs/archive"],
    files: [
      { path: "README.md", content: "# Notes\n" },
      { path: "docs/.gitkeep", content: "" },
    ],
    conflicts: [],
  });
  expect(plan.defaults).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  expect(await exists(join(workspace, "README.md"))).toBe(false);
  expect(await exists(join(workspace, "docs"))).toBe(false);
  expect(runs).toEqual([]);
  expect(await exists(join(dataDir, "projects.json"))).toBe(false);
});

test("inspect reports an unknown template", async () => {
  const { store } = makeStore();
  const error = await rejection(store.inspect("notes", workspace));
  expect(error.code).toBe("template.not_found");
});

test("apply writes directories then files and appends one project record", async () => {
  await writeTemplate("notes", notesTemplate());
  const log: string[] = [];
  const { store } = makeStore({
    workspaceAccess: loggedAccess(log),
    now: () => "2026-11-09T10:00:00.000Z",
    newProjectId: () => "project-1",
  });
  const resolution = await store.apply("notes", workspace, { confirmed: true });
  expect(log).toEqual(["dir:docs", "dir:docs/archive", "file:README.md", "file:docs/.gitkeep"]);
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("# Notes\n");
  expect(resolution.projectId).toBe("project-1");
  expect(resolution.preview.conflicts).toEqual([]);
  expect(resolution.defaults).toEqual({});
  const records = await readProjects(dataDir);
  expect(records).toEqual([
    {
      id: "project-1",
      templateId: "notes",
      workspace,
      createdAt: "2026-11-09T10:00:00.000Z",
    },
  ]);
  expect(records.map((record) => new Date(record.createdAt).toISOString())).toEqual([
    "2026-11-09T10:00:00.000Z",
  ]);
  expect(await exists(join(dataDir, "sessions"))).toBe(false);
});

test("apply refuses conflicts without overwrite and writes nothing", async () => {
  await writeTemplate(
    "notes",
    notesTemplate({ initScript: { command: "/usr/bin/true", args: ["init"], timeoutMs: 500 } }),
  );
  await writeFile(join(workspace, "README.md"), "# existing\n", "utf8");
  const { store, runs } = makeStore();
  const error = await rejection(store.apply("notes", workspace, { confirmed: true }));
  expect(error.code).toBe("template.workspace_conflict");
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("# existing\n");
  expect(await exists(join(workspace, "docs"))).toBe(false);
  expect(runs).toEqual([]);
  expect(await exists(join(dataDir, "projects.json"))).toBe(false);
});

test("apply refuses a missing workspace without creating it", async () => {
  await writeTemplate("notes", notesTemplate());
  const missing = join(root, "missing");
  const { store, runs } = makeStore();
  const error = await rejection(store.apply("notes", missing, { confirmed: true }));
  expect(error.code).toBe("session.invalid_workspace");
  expect(await exists(missing)).toBe(false);
  expect(runs).toEqual([]);
  expect(await exists(join(dataDir, "projects.json"))).toBe(false);
});

test("apply with overwrite replaces the conflicting file", async () => {
  await writeTemplate("notes", notesTemplate());
  await writeFile(join(workspace, "README.md"), "# existing\n", "utf8");
  const { store } = makeStore();
  const resolution = await store.apply("notes", workspace, { confirmed: true, overwrite: true });
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("# Notes\n");
  expect(resolution.preview.conflicts).toEqual(["README.md"]);
  expect(await readProjects(dataDir)).toHaveLength(1);
});

test("apply runs the init script with the template arguments, cwd and timeout", async () => {
  await writeTemplate(
    "notes",
    notesTemplate({
      initScript: { command: "/usr/bin/git", args: ["init", "--quiet"], timeoutMs: 1234 },
    }),
  );
  const { store, runs } = makeStore();
  await store.apply("notes", workspace, { confirmed: true });
  const cwd = createWorkspaceAccess(workspace).resolve(".");
  expect(runs).toEqual([
    { command: "/usr/bin/git", args: ["init", "--quiet"], options: { cwd, timeoutMs: 1234 } },
  ]);
});

test("apply keeps files and skips the project record when the script fails", async () => {
  const cases: { name: string; result: Partial<ExecResult> | Error }[] = [
    { name: "exit", result: { exitCode: 1 } },
    { name: "timeout", result: { timedOut: true } },
    { name: "throw", result: new Error("spawn failed") },
  ];
  for (const entry of cases) {
    const target = join(root, `ws-${entry.name}`);
    await mkdir(target);
    await writeTemplate(
      "notes",
      notesTemplate({ initScript: { command: "/usr/bin/true", args: [], timeoutMs: 500 } }),
    );
    const fake = fakeExec(() => {
      if (entry.result instanceof Error) throw entry.result;
      return entry.result;
    });
    const store = createTemplateStore({
      configDir,
      dataDir,
      workspaceAccess: createWorkspaceAccess,
      exec: fake.exec,
      newProjectId: () => `project-${entry.name}`,
    });
    const error = await rejection(store.apply("notes", target, { confirmed: true }));
    expect(error.code).toBe("template.init_failed");
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("# Notes\n");
    expect(await readProjects(dataDir)).toEqual([]);
  }
});

test("apply reads the prompt after writing the template files", async () => {
  await writeTemplate(
    "notes",
    notesTemplate({
      directories: [],
      files: [{ path: "PROMPT.md", content: "# Prompt\n" }],
      config: { systemPromptFile: "PROMPT.md" },
    }),
  );
  const { store } = makeStore();
  const resolution = await store.apply("notes", workspace, { confirmed: true });
  expect(await readFile(join(workspace, "PROMPT.md"), "utf8")).toBe("# Prompt\n");
  expect(resolution.defaults).toEqual({ systemPrompt: "# Prompt\n" });
});

test("maps a workspace path escape to template.invalid without leaking the path", async () => {
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(workspace, "link"));
  await writeTemplate(
    "notes",
    notesTemplate({ directories: [], files: [{ path: "link/secret.txt", content: "x" }] }),
  );
  const { store } = makeStore();
  const error = await rejection(store.preview("notes", workspace));
  expect(error.code).toBe("template.invalid");
  expect(error.message).toBe("Invalid template");
  expect(error.message).not.toContain(outside);
  expect(await exists(join(outside, "secret.txt"))).toBe(false);
});

test("lists valid templates sorted by id", async () => {
  await writeTemplate("zeta", { id: "zeta", name: "Zeta" });
  await writeTemplate("notes", notesTemplate());
  await writeFile(join(configDir, "broken.json"), "{", "utf8");
  const { store } = makeStore();
  expect(await store.list()).toEqual([
    { id: "notes", name: "Notes project", description: "Notes" },
    { id: "zeta", name: "Zeta" },
  ]);
});

test("appendProject keeps concurrent appends and writes mode 0600 without temp files", async () => {
  await Promise.all([
    appendProject(dataDir, reference("a")),
    appendProject(dataDir, reference("b")),
  ]);
  const records = await readProjects(dataDir);
  expect(records.map((record) => record.id).sort()).toEqual(["a", "b"]);
  const info = await stat(join(dataDir, "projects.json"));
  expect(info.mode & 0o777).toBe(0o600);
  expect((await readdir(dataDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("readProjects returns no records for a missing file", async () => {
  await expect(readProjects(dataDir)).resolves.toEqual([]);
});

test("rejects corrupt project records without rewriting them", async () => {
  const file = join(dataDir, "projects.json");
  const payloads = ["{", "{}", JSON.stringify([{ id: 1 }])];
  for (const payload of payloads) {
    await writeFile(file, payload, "utf8");
    await expect(appendProject(dataDir, reference("a"))).rejects.toMatchObject({
      code: "storage.corrupt",
    });
    expect(await readFile(file, "utf8")).toBe(payload);
  }
});

test("appendProject rejects a symlinked records file", async () => {
  const target = join(root, "elsewhere.json");
  await writeFile(target, "[]", "utf8");
  await symlink(target, join(dataDir, "projects.json"));
  await expect(appendProject(dataDir, reference("a"))).rejects.toMatchObject({
    code: "storage.io",
  });
  expect(await readFile(target, "utf8")).toBe("[]");
});

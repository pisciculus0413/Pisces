import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { readPidRecord } from "../src/lifecycle.js";

/**
 * Real-process acceptance for `pisces templates`: the built CLI talks to a
 * daemon it started itself, over the real Unix socket, and the daemon reads the
 * template directory that `config.json` points at through the child argv.
 *
 * The provider `baseUrl` points at a closed port; no network is needed because
 * none of these commands starts a turn.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const BUILT = existsSync(MAIN);
const KEY_ENV = "PISCES_TEST_KEY";
const KEY_VALUE = "sk-test-not-real";
const TEST_TIMEOUT_MS = 60_000;
const CLI_WAIT_MS = TEST_TIMEOUT_MS - 5_000;

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
  templatesDir: string;
  workspace: string;
  secondWorkspace: string;
}

const roots: string[] = [];
const children = new Set<ChildProcess>();
const observedPids = new Set<number>();

afterEach(async () => {
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

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pisces-templates-e2e-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const templatesDir = join(root, "templates");
  const workspace = join(root, "workspace");
  const secondWorkspace = join(root, "workspace-2");
  const configPath = join(root, "config.json");
  await mkdir(templatesDir, { recursive: true });
  await mkdir(workspace);
  await mkdir(secondWorkspace);
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      templatesDir,
      providers: [
        {
          id: "fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: KEY_ENV,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
  );
  await writeFile(
    join(templatesDir, "notes.json"),
    JSON.stringify({
      id: "notes",
      name: "Notes project",
      description: "Markdown notes",
      directories: ["docs"],
      files: [
        { path: "README.md", content: "# Notes\n" },
        { path: "docs/.gitkeep", content: "" },
      ],
      config: { provider: "fake", model: "m" },
    }),
    "utf8",
  );
  return { root, dataDir, configPath, templatesDir, workspace, secondWorkspace };
}

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
    }, CLI_WAIT_MS);
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

const listOf = async (path: string): Promise<string[]> => {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
};

async function projectCount(dataDir: string): Promise<number> {
  try {
    return (JSON.parse(await readFile(join(dataDir, "projects.json"), "utf8")) as unknown[]).length;
  } catch {
    return 0;
  }
}

test.skipIf(!BUILT)(
  "the built CLI lists, previews and applies a template over a real daemon",
  async () => {
    const fixture = await makeFixture();

    const started = await run(command(fixture, ["start"]));
    expect(started.stderr).toBe("");
    expect(started.code).toBe(0);
    const record = await readPidRecord(fixture.dataDir);
    expect(record).toBeDefined();
    observedPids.add(record?.pid ?? 0);

    const listed = await run(command(fixture, ["templates", "list"]));
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("notes  Notes project - Markdown notes");

    const previewed = await run(
      command(fixture, ["templates", "preview", "notes", "--workspace", fixture.workspace]),
    );
    expect(previewed.code).toBe(0);
    expect(previewed.stdout).toContain("directories:");
    expect(previewed.stdout).toContain("  docs");
    expect(previewed.stdout).toContain("  README.md");
    expect(previewed.stdout).toContain("conflicts:");
    // Preview is read-only: nothing exists in the workspace yet.
    expect(await listOf(fixture.workspace)).toEqual([]);

    // Without `--confirm` the CLI refuses before opening a socket.
    const refused = await run(
      command(fixture, ["templates", "apply", "notes", "--workspace", fixture.workspace]),
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("usage: pisces");
    expect(await listOf(fixture.workspace)).toEqual([]);
    expect(await projectCount(fixture.dataDir)).toBe(0);

    const applied = await run(
      command(fixture, [
        "templates",
        "apply",
        "notes",
        "--workspace",
        fixture.workspace,
        "--confirm",
      ]),
    );
    expect(applied.stderr).toBe("");
    expect(applied.code).toBe(0);
    expect(applied.stdout.trim()).toMatch(/^project \S+ session \S+$/);
    expect(await readFile(join(fixture.workspace, "README.md"), "utf8")).toBe("# Notes\n");
    expect(await listOf(join(fixture.workspace, "docs"))).toEqual([".gitkeep"]);
    expect(await projectCount(fixture.dataDir)).toBe(1);

    const stopped = await run(command(fixture, ["stop"]));
    expect(stopped.code).toBe(0);

    // Once the daemon is gone the same command fails closed and writes nothing.
    const unreachable = await run(
      command(fixture, [
        "templates",
        "apply",
        "notes",
        "--workspace",
        fixture.secondWorkspace,
        "--confirm",
      ]),
    );
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain("daemon.unreachable");
    expect(await listOf(fixture.secondWorkspace)).toEqual([]);
    expect(await projectCount(fixture.dataDir)).toBe(1);
  },
  TEST_TIMEOUT_MS,
);

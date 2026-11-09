import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Exec,
  ExecResult,
  JsonValue,
  SessionId,
  ToolInvocationContext,
  ToolResult,
  WorkspaceAccess,
} from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import run from "../../../extensions/builtin/shell/tools/shell.js";
import { createExecHost } from "../src/exec/exec-host.js";
import { createWorkspaceAccess } from "../src/workspace/access.js";

const INVALID = "Invalid shell arguments";
const UNAVAILABLE = "Execution host is unavailable";
const DENIED = "Working directory is outside the workspace";

let root = "";
let files: WorkspaceAccess;
let exec: Exec;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pisces-shell-tool-")));
  files = createWorkspaceAccess(root);
  exec = createExecHost();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(
  capabilities: { files?: WorkspaceAccess; exec?: Exec } = {},
): ToolInvocationContext {
  return {
    sessionId: "shell-session" as SessionId,
    workspace: root,
    signal: new AbortController().signal,
    ...capabilities,
  };
}

function invoke(args: JsonValue): Promise<ToolResult> {
  return run(args, context({ files, exec }));
}

function text(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

const fakeExec = (result: ExecResult): Exec => ({
  run: (): Promise<ExecResult> => Promise.resolve(result),
});

test("rejects invalid arguments with a fixed message that does not echo them", async () => {
  const malicious = "sh -c 'touch /tmp/never'";
  const cases: JsonValue[] = [
    {},
    { command: "" },
    { command: 42 },
    { command: null },
    { command: malicious, cwd: 7 },
    { command: malicious, timeoutMs: "50" },
    { command: malicious, timeoutMs: 0 },
    { command: malicious, timeoutMs: 600_001 },
    { command: malicious, timeoutMs: 1.5 },
    { command: "a".repeat(65_537) },
  ];

  for (const args of cases) {
    const result = await invoke(args);

    expect(result.isError).toBe(true);
    expect(result.code).toBe("tool.failed");
    expect(text(result)).toBe(INVALID);
  }
});

test("runs a command in the workspace and reports the exit code", async () => {
  const result = await invoke({ command: "printf hello" });

  expect(result.isError).toBeFalsy();
  expect(result.code).toBeUndefined();
  expect(text(result)).toContain("exit code: 0");
  expect(text(result)).toContain("hello");
});

test("reports a non-zero exit code as an error", async () => {
  const result = await invoke({ command: "printf bad >&2; exit 4" });

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("exit code: 4");
  expect(text(result)).toContain("bad");
});

test("runs in a workspace-relative cwd", async () => {
  await mkdir(join(root, "sub"));

  const result = await invoke({ command: "pwd", cwd: "sub" });

  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain(join(root, "sub"));
});

test("denies a cwd that leaves the workspace without echoing it", async () => {
  for (const cwd of ["../outside", "/tmp", "sub/../../outside"]) {
    const result = await invoke({ command: "pwd", cwd });

    expect(result.isError).toBe(true);
    expect(result.code).toBe("tool.denied");
    expect(text(result)).toBe(DENIED);
  }
});

test("fails safely when a capability is missing", async () => {
  const withoutFiles = context({ exec });
  const withoutExec = context({ files });

  for (const invocation of [withoutFiles, withoutExec]) {
    const result = await run({ command: "printf hi" }, invocation);

    expect(result.isError).toBe(true);
    expect(result.code).toBe("tool.failed");
    expect(text(result)).toBe(UNAVAILABLE);
  }
});

test("marks a truncated stream", async () => {
  const result = await run(
    { command: "printf out" },
    context({
      files,
      exec: fakeExec({
        exitCode: 0,
        stdout: "out",
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
      }),
    }),
  );

  expect(result.isError).toBeFalsy();
  expect(text(result)).toContain("[truncated]");
});

test("marks a timed-out command as an error", async () => {
  const result = await invoke({ command: "sleep 5", timeoutMs: 50 });

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("[timed out]");
});

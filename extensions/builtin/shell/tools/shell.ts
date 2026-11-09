import {
  type ContentBlock,
  type ExecResult,
  type JsonValue,
  PiscesError,
  type ToolFunction,
  type ToolResult,
} from "@pisces/core";

const SHELL = "/bin/sh";
const MAX_COMMAND_LENGTH = 65_536;
const MAX_TIMEOUT_MS = 600_000;
const INVALID_ARGS = "Invalid shell arguments";
const UNAVAILABLE = "Execution host is unavailable";
const DENIED = "Working directory is outside the workspace";
const ACCESS_FAILED = "Workspace access failed";
const EXEC_FAILED = "Shell command could not be run";

interface ShellArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

function failure(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, code };
}

function asObject(value: JsonValue): { [key: string]: JsonValue } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function parseArgs(value: JsonValue): ShellArgs | undefined {
  const args = asObject(value);
  if (args === undefined) return undefined;

  const command = args.command;
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    return undefined;
  }

  const cwd = args.cwd;
  if (cwd !== undefined && typeof cwd !== "string") return undefined;

  const timeoutMs = args.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS)
  ) {
    return undefined;
  }

  const parsed: ShellArgs = { command };
  if (cwd !== undefined) parsed.cwd = cwd;
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  return parsed;
}

function streamText(text: string, truncated: boolean): string {
  return truncated ? `${text}\n[truncated]` : text;
}

function formatResult(result: ExecResult): ToolResult {
  const content: ContentBlock[] = [
    { type: "text", text: `exit code: ${result.exitCode}` },
    { type: "text", text: streamText(result.stdout, result.stdoutTruncated) },
    { type: "text", text: streamText(result.stderr, result.stderrTruncated) },
  ];
  if (result.timedOut === true) content.push({ type: "text", text: "[timed out]" });
  if (result.aborted === true) content.push({ type: "text", text: "[aborted]" });
  const outcome: ToolResult = { content };
  if (result.exitCode !== 0 || result.timedOut === true || result.aborted === true) {
    outcome.isError = true;
  }
  return outcome;
}

const shell: ToolFunction = async (value, context) => {
  const args = parseArgs(value);
  if (args === undefined) return failure("tool.failed", INVALID_ARGS);

  const { files, exec } = context;
  if (files === undefined || exec === undefined) return failure("tool.failed", UNAVAILABLE);

  let cwd = context.workspace;
  if (args.cwd !== undefined) {
    try {
      cwd = files.resolve(args.cwd);
    } catch (error) {
      if (error instanceof PiscesError && error.code === "workspace.path_outside") {
        return failure("tool.denied", DENIED);
      }
      return failure("tool.failed", ACCESS_FAILED);
    }
  }

  let result: ExecResult;
  try {
    result = await exec.run(SHELL, ["-c", args.command], {
      cwd,
      signal: context.signal,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
  } catch {
    return failure("tool.failed", EXEC_FAILED);
  }

  return formatResult(result);
};

export default shell;

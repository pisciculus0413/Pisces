import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { type Exec, type ExecOptions, type ExecResult, PiscesError } from "@pisces/core";

const OUTPUT_CAP = 65_536;
const CLOSE_FALLBACK_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const START_FAILED = "Command could not be started";
const SIGNAL_EXIT_CODE = 1;

export interface ExecHostOptions {
  defaultTimeoutMs?: number;
  pathEnv?: string;
}

interface Collected {
  text: string;
  truncated: boolean;
}

interface Collector {
  push(chunk: Buffer): void;
  collect(): Collected;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

// The cap can split a multi-byte sequence, so retry without the partial tail.
function decodeUtf8(bytes: Buffer): string {
  for (let cut = 0; cut <= 3 && cut < bytes.length; cut++) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, bytes.length - cut),
      );
    } catch {
      // A shorter prefix may end on a code point boundary.
    }
  }
  return bytes.toString("utf8");
}

function createCollector(): Collector {
  let bytes = Buffer.alloc(0);
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      if (truncated) return;
      const room = OUTPUT_CAP - bytes.length;
      if (chunk.length <= room) {
        bytes = Buffer.concat([bytes, chunk], bytes.length + chunk.length);
        return;
      }
      truncated = true;
      if (room > 0) bytes = Buffer.concat([bytes, chunk.subarray(0, room)], OUTPUT_CAP);
    },
    collect(): Collected {
      return { text: decodeUtf8(bytes), truncated };
    },
  };
}

export function createExecHost(options: ExecHostOptions = {}): Exec {
  const basePath = options.pathEnv ?? DEFAULT_PATH;
  const defaultTimeoutMs = clampTimeout(options.defaultTimeoutMs);

  return {
    run(command: string, args: string[], runOptions: ExecOptions = {}): Promise<ExecResult> {
      const signal = runOptions.signal;
      if (signal?.aborted === true) {
        return Promise.resolve({
          exitCode: SIGNAL_EXIT_CODE,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          aborted: true,
        });
      }
      const timeoutMs = clampTimeout(runOptions.timeoutMs ?? defaultTimeoutMs);
      const env: Record<string, string> = { ...(runOptions.env ?? {}), PATH: basePath };
      const out = createCollector();
      const err = createCollector();

      return new Promise<ExecResult>((resolve, reject) => {
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
          child = spawn(command, args, {
            cwd: runOptions.cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          reject(new PiscesError("storage.io", START_FAILED, { cause: error }));
          return;
        }

        let settled = false;
        let killed = false;
        let timedOut = false;
        let aborted = false;
        let exitCode: number | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let closeTimer: NodeJS.Timeout | undefined;

        const clearTimers = (): void => {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          if (closeTimer !== undefined) clearTimeout(closeTimer);
          timeoutTimer = undefined;
          closeTimer = undefined;
        };

        const kill = (): void => {
          if (killed) return;
          killed = true;
          child.kill("SIGKILL");
        };

        const onAbort = (): void => {
          aborted = true;
          kill();
        };

        const finish = (code: number | null | undefined): void => {
          if (settled) return;
          settled = true;
          clearTimers();
          signal?.removeEventListener("abort", onAbort);
          const stdout = out.collect();
          const stderr = err.collect();
          resolve({
            exitCode: code ?? exitCode ?? SIGNAL_EXIT_CODE,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            ...(timedOut ? { timedOut } : {}),
            ...(aborted ? { aborted } : {}),
          });
        };

        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        // Destroyed streams can emit late errors; they must not reject a settled run.
        const ignoreStreamError = (): void => {};
        child.stdout.on("error", ignoreStreamError);
        child.stderr.on("error", ignoreStreamError);

        timeoutTimer = setTimeout(() => {
          // The child is already gone; a pending timer must not fake a timeout.
          if (exitCode !== undefined) return;
          timedOut = true;
          kill();
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimers();
          signal?.removeEventListener("abort", onAbort);
          reject(new PiscesError("storage.io", START_FAILED, { cause: error }));
        });

        child.on("exit", (code) => {
          exitCode = code ?? SIGNAL_EXIT_CODE;
          if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
          }
          if (settled || closeTimer !== undefined) return;
          // A grandchild may hold the pipes open; bound the wait on `close`.
          closeTimer = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            finish(exitCode);
          }, CLOSE_FALLBACK_MS);
        });

        child.on("close", (code) => {
          finish(code);
        });
      });
    },
  };
}

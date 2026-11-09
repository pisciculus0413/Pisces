import { PiscesError } from "@pisces/core";
import { expect, test } from "vitest";
import { createExecHost } from "../src/exec/exec-host.js";

const SHELL = "/bin/sh";
const NODE = process.execPath;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const OUTPUT_CAP = 65_536;
const START_FAILED = "Command could not be started";

function writeScript(value: string, count: number): string {
  return `process.stdout.write(${JSON.stringify(value)}.repeat(${count}))`;
}

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error to be thrown");
}

test("returns the exit code and both streams", async () => {
  const host = createExecHost();
  const result = await host.run(SHELL, ["-c", "printf out; printf err >&2; exit 3"]);
  expect(result).toEqual({
    exitCode: 3,
    stdout: "out",
    stderr: "err",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
});

test("passes argv verbatim instead of splitting a command string", async () => {
  const host = createExecHost();
  const result = await host.run(SHELL, ["-c", "printf '%s' \"$1\"", "sh", "a;b"]);
  expect(result.stdout).toBe("a;b");
  expect(result.exitCode).toBe(0);
});

test("does not inherit the daemon environment", async () => {
  const host = createExecHost();
  const probe = `printf '%s' "$SECRET\${PATH:+}\${HOME:-}"`;
  const result = await host.run(SHELL, ["-c", probe], { env: { SECRET: "x" } });
  expect(result.stdout).toBe("x");
  const home = process.env.HOME;
  if (home !== undefined && home.length > 0) expect(result.stdout).not.toContain(home);
});

test("exposes only the configured base PATH", async () => {
  const fallback = createExecHost();
  expect((await fallback.run(SHELL, ["-c", "printf '%s' \"$PATH\""])).stdout).toBe(DEFAULT_PATH);
  const custom = createExecHost({ pathEnv: "/custom/bin" });
  expect((await custom.run(SHELL, ["-c", "printf '%s' \"$PATH\""])).stdout).toBe("/custom/bin");
});

test("kills the child when the timeout elapses", async () => {
  const host = createExecHost();
  const started = Date.now();
  const result = await host.run(SHELL, ["-c", "printf before; sleep 5"], { timeoutMs: 50 });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result.timedOut).toBe(true);
  expect(result.stdout).toBe("before");
  expect(result.exitCode).not.toBe(0);
});

test("clamps a zero timeout instead of disabling it", async () => {
  const host = createExecHost();
  const started = Date.now();
  const result = await host.run(SHELL, ["-c", "printf before; sleep 5"], { timeoutMs: 0 });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result.timedOut).toBe(true);
});

test("kills the child when the signal aborts", async () => {
  const host = createExecHost();
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  const result = await host.run(SHELL, ["-c", "printf before; sleep 5"], {
    signal: controller.signal,
  });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result.aborted).toBe(true);
  expect(result.stdout).toBe("before");
  expect(result.exitCode).not.toBe(0);
});

test("resolves without spawning when the signal is already aborted", async () => {
  const host = createExecHost();
  const controller = new AbortController();
  controller.abort();
  const result = await host.run(SHELL, ["-c", "printf never"], { signal: controller.signal });
  expect(result.aborted).toBe(true);
  expect(result.stdout).toBe("");
});

test("resolves when a grandchild keeps the pipes open", async () => {
  const host = createExecHost();
  const started = Date.now();
  const result = await host.run(SHELL, ["-c", "sleep 30 & printf done"]);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("done");
});

test("does not report a timeout once the child has exited", async () => {
  const host = createExecHost();
  const started = Date.now();
  // The shell exits immediately; the background grandchild holds the pipes open
  // until the close fallback fires, which is past the timeout window.
  const result = await host.run(SHELL, ["-c", "sleep 30 & printf done"], { timeoutMs: 100 });
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result.timedOut).toBeFalsy();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("done");
});

test("truncates ASCII output at the byte cap", async () => {
  const host = createExecHost();
  const result = await host.run(NODE, ["-e", writeScript("a", 200_000)]);
  expect(result.stdoutTruncated).toBe(true);
  expect(Buffer.byteLength(result.stdout, "utf8")).toBe(OUTPUT_CAP);
  expect(result.stdout).toBe("a".repeat(OUTPUT_CAP));
  expect(result.stderrTruncated).toBe(false);
  expect(result.exitCode).toBe(0);

  const stderrOnly = await host.run(NODE, ["-e", "process.stderr.write('b'.repeat(200000))"]);
  expect(stderrOnly.stderrTruncated).toBe(true);
  expect(Buffer.byteLength(stderrOnly.stderr, "utf8")).toBe(OUTPUT_CAP);
  expect(stderrOnly.stderr).toBe("b".repeat(OUTPUT_CAP));
  expect(stderrOnly.stdoutTruncated).toBe(false);
  expect(stderrOnly.exitCode).toBe(0);
});

test("truncates multi-byte output on a UTF-8 boundary", async () => {
  const host = createExecHost();
  const twoByte = await host.run(NODE, ["-e", writeScript("é", 100_000)]);
  expect(twoByte.stdoutTruncated).toBe(true);
  expect(Buffer.byteLength(twoByte.stdout, "utf8")).toBe(OUTPUT_CAP);
  expect(twoByte.stdout).toBe("é".repeat(OUTPUT_CAP / 2));
  expect(twoByte.stdout).not.toContain("\uFFFD");

  const threeByte = await host.run(NODE, ["-e", writeScript("€", 50_000)]);
  expect(threeByte.stdoutTruncated).toBe(true);
  expect(Buffer.byteLength(threeByte.stdout, "utf8")).toBe(OUTPUT_CAP - 1);
  expect(threeByte.stdout).toBe("€".repeat((OUTPUT_CAP - 1) / 3));
  expect(threeByte.stdout).not.toContain("\uFFFD");
});

test("closes stdin so a reader exits immediately", async () => {
  const host = createExecHost();
  const started = Date.now();
  const result = await host.run(SHELL, ["-c", "cat"]);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("rejects with a fixed error when the command cannot start", async () => {
  const host = createExecHost();
  const error = await capture(() => host.run("/nonexistent/binary", []));
  expect(error).toBeInstanceOf(PiscesError);
  expect(error).toMatchObject({ code: "storage.io", message: START_FAILED });
});

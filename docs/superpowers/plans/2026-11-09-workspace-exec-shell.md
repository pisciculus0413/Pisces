# WorkspaceAccess / ExecHost + Built-in Shell Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tools a host-injected, policy-controlled way to reach the session workspace and run child processes, and prove it with one real built-in shell tool over the existing extension pipeline.

**Architecture:** Core defines `WorkspaceAccess`/`Exec` contracts and adds optional `files`/`exec` to `ToolInvocationContext` and `RunTurnInput`. The daemon implements both services; the Gateway constructs `files` at `turn.start` from the canonical workspace and injects a daemon-level `exec`. A real extension package at `extensions/builtin/shell` is the first consumer.

**Tech Stack:** TypeScript ESM, Node >=22.19, pnpm workspace, Vitest, `node:child_process.spawn`, existing jiti loader and extension discovery.

**Spec:** `docs/superpowers/specs/2026-11-09-workspace-exec-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no commit to `main`, no push/merge. Keep existing SDD material.
- Core has no filesystem/environment I/O and must not import daemon/protocol; both boundary scans must stay exit 1.
- Gate G before every commit, from the repo root: `node packages/daemon/native/build.mjs`; `pnpm exec tsc -b tsconfig.build.json`; `pnpm exec vitest run`; `pnpm exec tsc -p tsconfig.json`; `pnpm exec tsc -b tsconfig.build.json`; `pnpm exec biome check .`; `rg -n 'from "(node:)?(fs|http|https|net|tls|dgram|dns)|from "@pisces/(daemon|protocol)"' packages/core/src` (expect exit 1); `rg -n 'from "@pisces/(daemon|core)"' packages/protocol/src` (expect exit 1); `git diff --check`; `git status --short`. Exit 2 from `rg` is an error.
- Stage explicit paths only; never `git add -A`/`.`.
- Subagents (implementer/reviewer) use `model="deepseek-flash"`; no nested agents.
- Fixed values from the spec: default exec timeout `120_000` ms, max `600_000` ms; per-stream output cap `65_536` bytes; `exit`→`close` fallback `1_000` ms; default PATH `/usr/local/bin:/usr/bin:/bin`; shell command length 1..`65536` chars.
- New internal error code `workspace.path_outside` (never sent on the wire); I/O failures use `storage.io`; the shell tool maps access/host failures to `tool.failed`/`tool.denied` with fixed messages that never echo arguments or paths.
- The shell tool is **not** enabled by default; `extensions/builtin/shell` never runs during discovery; the tool module is imported only at first invoke.
- No sandbox claims: the shell runs as the daemon uid and can bypass `WorkspaceAccess`; docs must say so.

## Review Focus

1. Path escape: `resolve` must reject `..`, absolute paths, NUL, and symlinked targets/ancestors that leave the canonical root — including paths that do not exist yet (write/create case).
2. Process cleanup: timeout and abort must kill the direct child and return bounded, keeping partial output even when a grandchild holds the pipes; `daemon.stop()` must not fail because an exec never closed.
3. Environment isolation: the child must not see daemon env (credentials refs, socket paths, `HOME`); only explicit `env` plus base `PATH`.
4. Output volume: a huge or multi-byte stream must be cut at a UTF-8 boundary at 64 KiB and never exceed the 256 KiB node budget.
5. Absent capability: old/manual hosts without `files`/`exec`, or a workspace whose `realpath` fails, must fail the tool safely with fixed messages and must not change read/queue behaviour.

---

### Task 1: Core contracts and pass-through

**Files:**
- Create: `packages/core/src/exec/types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/tools/types.ts:39-43`
- Modify: `packages/core/src/tools/tools.ts:183-190`
- Modify: `packages/core/src/loop/types.ts` (`RunTurnInput`)
- Modify: `packages/core/src/loop/driver.ts:545-549`
- Test: `packages/core/test/tools-invoke.test.ts`

**Interfaces:**
- Produces: `WorkspaceAccess`, `ExecOptions`, `ExecResult`, `Exec` (exported from `@pisces/core`); `ToolInvocationContext { sessionId; workspace; signal; files?: WorkspaceAccess; exec?: Exec }`; `RunTurnInput` gains optional `files?: WorkspaceAccess; exec?: Exec`.

- [ ] **Step 1: Write the failing test** in `packages/core/test/tools-invoke.test.ts`:

```ts
test("forwards host files and exec to the tool and omits absent capabilities", async () => {
  const seen: ToolInvocationContext[] = [];
  const tools = createTools();
  tools.registerTool({
    id: "demo#t", source: "demo", name: "demo#t" as EntryName,
    description: "d", parameters: {},
    execute: async (_args, context) => { seen.push(context); return { content: [] }; },
  });
  const files = { resolve: (path: string) => `/ws/${path}`, ensureDirectory: async () => {},
    writeFile: async () => {}, readFile: async () => "", exists: async () => true };
  const exec = { run: async () => ({ exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }) };
  const call = { id: "c1", name: "demo#t" as EntryName, arguments: {} };
  await tools.invoke(call, ["demo#t" as EntryName], { sessionId: "s" as SessionId, workspace: "/ws", signal: new AbortController().signal, files, exec });
  await tools.invoke(call, ["demo#t" as EntryName], { sessionId: "s" as SessionId, workspace: "/ws", signal: new AbortController().signal });
  expect(seen[0]?.files).toBe(files);
  expect(seen[0]?.exec).toBe(exec);
  expect(seen[1] && "files" in seen[1]).toBe(false);
  expect(seen[1] && "exec" in seen[1]).toBe(false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run packages/core/test/tools-invoke.test.ts`
Expected: FAIL — the context lacks `files`/`exec` (TS error or failing assertion).

- [ ] **Step 3: Implement the contracts**

In `packages/core/src/exec/types.ts` define exactly:

```ts
export interface WorkspaceAccess {
  resolve(path: string): string;
  ensureDirectory(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}
export interface Exec {
  run(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}
```

Export it via `export * from "./exec/types.js";` in `packages/core/src/index.ts`. Extend `ToolInvocationContext` with the two optional fields (with a comment: host-injected; absent means the tool must fail safely). In `tools.ts` copy `files`/`exec` only when present, e.g. `...(context.files === undefined ? {} : { files: context.files })`, same for `exec`. Add the fields to `RunTurnInput` and pass them in `driver.ts` when building the invocation context.

- [ ] **Step 4: Run the test and the full suite**

Run: `pnpm exec vitest run packages/core`
Expected: PASS, no regressions.

- [ ] **Step 5: Gate G and commit**

Run the full gate G from Global Constraints, then:

```bash
git add packages/core/src/exec/types.ts packages/core/src/index.ts packages/core/src/tools/types.ts packages/core/src/tools/tools.ts packages/core/src/loop/types.ts packages/core/src/loop/driver.ts packages/core/test/tools-invoke.test.ts
git commit -m "feat(core): add workspace and exec capabilities to tool invocation"
```

---

### Task 2: `WorkspaceAccess` implementation

**Files:**
- Create: `packages/daemon/src/workspace/access.ts`
- Test: `packages/daemon/test/workspace-access.test.ts`

**Interfaces:**
- Consumes: `WorkspaceAccess` type from `@pisces/core`.
- Produces: `createWorkspaceAccess(root: string): WorkspaceAccess` where `root` is already canonical/absolute; throws `PiscesError("workspace.path_outside", "Path is outside the workspace")` for escapes and `PiscesError("storage.io", "Workspace access failed")` for I/O failures.

- [ ] **Step 1: Write the failing tests** covering: `..` escape; absolute path; NUL; symlink pointing outside root; symlink ancestor pointing outside; a not-yet-existing subdirectory path is allowed; `ensureDirectory` creates nested dirs; `writeFile`+`readFile` round-trip; `exists` true/false inside root; `exists` outside root throws `workspace.path_outside`; write failure surfaces `storage.io`. Use `mkdtemp` roots and a sibling `outside` directory for the escape cases.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/workspace-access.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `createWorkspaceAccess`**

Rules: reject non-string/empty/NUL; reject absolute input and `..` that crosses root while folding segments; for an existing target, `realpath` it and require containment under `root`; otherwise `realpath` the deepest existing ancestor, append the remaining lexically folded segments, require containment. `exists` resolves first (so outside-root probes throw) and maps `ENOENT` to `false`, other I/O errors to `storage.io`. `writeFile` calls `ensureDirectory(dirname(resolve(path)))` first. Do not add caching; `root` is trusted canonical input.

- [ ] **Step 4: Run and confirm pass**

Run: `pnpm exec vitest run packages/daemon/test/workspace-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate G and commit**

```bash
git add packages/daemon/src/workspace/access.ts packages/daemon/test/workspace-access.test.ts
git commit -m "feat(daemon): implement workspace path containment"
```

---

### Task 3: `ExecHost` implementation

**Files:**
- Create: `packages/daemon/src/exec/exec-host.ts`
- Test: `packages/daemon/test/exec-host.test.ts`

**Interfaces:**
- Consumes: `Exec`, `ExecOptions`, `ExecResult` from `@pisces/core`.
- Produces: `createExecHost(options?: { defaultTimeoutMs?: number; pathEnv?: string }): Exec`.

- [ ] **Step 1: Write the failing tests** (use `/bin/sh` and Node one-liners; no network):
  - echo/exit: `run("/bin/sh", ["-c", "printf out; printf err >&2; exit 3"])` returns `exitCode 3`, both streams, no throw.
  - argv is not a shell: `run("/bin/sh", ["-c", "printf '%s' \"$1\"", "sh", "a;b"])` yields `a;b` (no command split).
  - env isolation: `run("/bin/sh", ["-c", "printf '%s' \"$SECRET${PATH:+}${HOME:-}\""], { env: { SECRET: "x" } })` contains `x` but not the test process's `HOME` or any other inherited variable.
  - timeout: `run("/bin/sh", ["-c", "printf before; sleep 5"], { timeoutMs: 50 })` resolves within ~2 s with `timedOut: true`, `stdout` containing `before`.
  - abort: same with an `AbortController` aborted after 50 ms → `aborted: true`.
  - pipe-holding grandchild: `run("/bin/sh", ["-c", "sleep 30 & printf done"])` resolves within ~3 s (the 1 s `exit`→`close` fallback), `exitCode 0`, `stdout` includes `done`.
  - truncation: output of `200_000` ASCII bytes and of multi-byte `'é'.repeat(100_000)` is cut at ≤ `65_536` bytes on a UTF-8 boundary with `stdoutTruncated: true` and no `\uFFFD`.
  - stdin closed: `run("/bin/sh", ["-c", "cat"])` resolves quickly with empty stdout.
  - missing binary: `run("/nonexistent/binary", [])` rejects with `PiscesError` code `storage.io` and message `Command could not be started`.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/exec-host.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `createExecHost`**

`spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })`, no shell. Build env as `{ ...explicitEnv, PATH: options.pathEnv ?? "/usr/local/bin:/usr/bin:/bin" }` — never spread `process.env`. Apply timeout clamped to `1..600_000` (default `120_000`); on timer or abort send `SIGKILL` once and mark the flag. Collect each stream up to `65_536` bytes using a growing `Buffer`, dropping the rest and setting the `*Truncated` flag; decode with `toString("utf8")` after cutting back to a UTF-8 boundary. Resolve on `close`; if `exit` fires first, start a `1_000` ms timer that destroys both streams and resolves with collected output. Map spawn errors to the fixed `storage.io` error. Ignore late stream errors after resolve.

- [ ] **Step 4: Run and confirm pass**

Run: `pnpm exec vitest run packages/daemon/test/exec-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate G and commit**

```bash
git add packages/daemon/src/exec/exec-host.ts packages/daemon/test/exec-host.test.ts
git commit -m "feat(daemon): implement bounded command execution host"
```

---

### Task 4: Gateway injection of `files` and `exec`

**Files:**
- Modify: `packages/daemon/src/gateway/gateway.ts` (`GatewayDeps`, `SessionRuntime`, `turn.start` input construction)
- Test: `packages/daemon/test/gateway-turn.test.ts`
- Test: `packages/daemon/test/gateway-extensions.test.ts`

**Interfaces:**
- Consumes: `createWorkspaceAccess` (Task 2), `createExecHost` (Task 3), `RunTurnInput` fields (Task 1).
- Produces: `GatewayDeps.createWorkspaceAccess?: (workspace: string) => WorkspaceAccess` and `GatewayDeps.exec?: Exec`; every new turn's `RunTurnInput` carries `exec` always and `files` when the canonical workspace resolves.

- [ ] **Step 1: Write the failing tests**
  - In `gateway-turn.test.ts`: with an injected fake `exec` and `createWorkspaceAccess`, a turn with a registered tool observes both on its `ToolInvocationContext` (assert identity). Without injected deps, the same turn still observes a real `exec` (assert `typeof context.exec.run === "function"`). With a real workspace directory the tool sees `files`; after deleting that directory (manual mode, no extensions service), `turn.start` still proceeds and the tool sees `files === undefined` (no `session.invalid_workspace`, no failed turn) — use a fake provider that calls the tool before asserting.
  - In `gateway-extensions.test.ts`: one configured-mode turn asserts the tool context carries the injected `exec` and a `files` rooted at the canonical workspace.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/gateway-turn.test.ts packages/daemon/test/gateway-extensions.test.ts`
Expected: FAIL — context lacks the fields.

- [ ] **Step 3: Implement injection**

Add the two optional deps. Add `files?: WorkspaceAccess` and `filesRoot?: string` to `SessionRuntime` (cache). At the start of the new-turn branch of `turn.start` (inside the session lock, before building `RunTurnInput`): if `realpath(runtime.meta.workspace)` succeeds, set the cached access via `deps.createWorkspaceAccess ?? createWorkspaceAccess` with the realpath; on failure leave it undefined. Always set `exec: deps.exec ?? execHost` (module-level singleton from `createExecHost()`). Spread `files`/`exec` into `RunTurnInput`. Do not touch queue, snapshot, marker, confirm or registerTurn ordering.

- [ ] **Step 4: Run and confirm pass**

Run: `pnpm exec vitest run packages/daemon/test/gateway-turn.test.ts packages/daemon/test/gateway-extensions.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate G and commit**

```bash
git add packages/daemon/src/gateway/gateway.ts packages/daemon/test/gateway-turn.test.ts packages/daemon/test/gateway-extensions.test.ts
git commit -m "feat(daemon): inject workspace and exec into turn tool context"
```

---

### Task 5: Built-in shell extension

**Files:**
- Create: `extensions/builtin/shell/package.json`
- Create: `extensions/builtin/shell/tools/shell.ts`
- Create: `extensions/builtin/shell/tools/shell.ts.meta.json`
- Create: `packages/daemon/test/shell-tool.test.ts`
- Modify: `packages/daemon/test/extensions-discovery.test.ts:631-642`

**Interfaces:**
- Consumes: `ToolFunction`, `ToolResult`, `ToolInvocationContext` from `@pisces/core`; `context.files`/`context.exec` (Tasks 1–4).
- Produces: package `@pisces/builtin-shell`, entry `@pisces/builtin-shell#shell`, args `{ command: string; cwd?: string; timeoutMs?: number }`.

- [ ] **Step 1: Write the failing tests** in `packages/daemon/test/shell-tool.test.ts` (import the tool module directly; use a temp workspace + `createWorkspaceAccess` + `createExecHost`, and fakes for failure cases):
  - invalid args (missing/empty/non-string `command`, command > 65536 chars, non-integer `timeoutMs`) → `isError: true`, `code: "tool.failed"`, fixed message, no echo of the input.
  - success: `printf hello` → `isError` falsy, content text includes `hello` and `exit code: 0`.
  - non-zero exit: `exit 4` → `isError: true`, content includes `exit code: 4`.
  - cwd: `cwd: "sub"` runs in `<workspace>/sub`; `cwd: "../outside"` → `isError: true`, `code: "tool.denied"`, no path in the message.
  - missing capability: context without `files` or without `exec` → `isError: true`, `code: "tool.failed"`, message `Execution host is unavailable`.
  - truncation marker: fake exec result with `stdoutTruncated: true` shows `[truncated]`.
  - timeout: real exec with `timeoutMs: 50` and `sleep 5` → `isError: true`, content includes `[timed out]`.

- [ ] **Step 2: Also update the discovery test** `defaultBuiltinDir is module-relative and absent by default without being created` to the new reality: `defaultBuiltinDir()` still equals the module-relative path, the directory now exists, and `discoverExtensions({configDir}, workspace, {})` includes exactly the shell entry `@pisces/builtin-shell#shell` with a tool definition. Keep the "does not create the directory" assertion form by asserting the path pre-exists and is a directory.

- [ ] **Step 3: Run and confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/shell-tool.test.ts packages/daemon/test/extensions-discovery.test.ts`
Expected: FAIL — package/tool missing.

- [ ] **Step 4: Create the package and implement the tool**

`package.json`:

```json
{ "name": "@pisces/builtin-shell", "private": true, "type": "module", "pisces": { "tools": ["tools/shell.ts"] } }
```

`tools/shell.ts.meta.json` declares `name: "shell"`, a description that says it runs a shell command in the workspace, and a draft-07 `parameters` object with `command` (string, minLength 1, maxLength 65536), optional `cwd` (string), optional `timeoutMs` (integer, minimum 1, maximum 600000), `required: ["command"]`.

`tools/shell.ts` default-exports a `ToolFunction` that: validates args (returning the safe `tool.failed` result on any violation); requires `context.files` and `context.exec` (else `tool.failed` with `Execution host is unavailable`); resolves `cwd` through `files.resolve` (mapping `workspace.path_outside` to `tool.denied` with a fixed message); runs `/bin/sh -c command` with `cwd`, `signal`, `timeoutMs`; formats text blocks `exit code: N`, stdout, stderr (append `[truncated]` per truncated stream, `[timed out]` when `timedOut`, `[aborted]` when `aborted`); sets `isError: true` when exit code ≠ 0 or timed out/aborted; never echoes arguments or paths in messages.

- [ ] **Step 5: Run and confirm pass, then check the default-discovery fallout**

Run: `pnpm exec vitest run packages/daemon/test/shell-tool.test.ts packages/daemon/test/extensions-discovery.test.ts packages/daemon/test/extensions-binding.test.ts packages/daemon/test/extensions-host.test.ts`
Expected: PASS. If another suite assumed an empty default builtin dir, update only the expectation that encodes that assumption and note it in the commit message; do not weaken behaviour.

- [ ] **Step 6: Gate G and commit**

```bash
git add extensions/builtin/shell/package.json extensions/builtin/shell/tools/shell.ts extensions/builtin/shell/tools/shell.ts.meta.json packages/daemon/test/shell-tool.test.ts packages/daemon/test/extensions-discovery.test.ts
git commit -m "feat(extensions): ship a built-in shell tool"
```

---

### Task 6: Socket acceptance and documentation

**Files:**
- Modify: `packages/daemon/test/extensions-socket.test.ts`
- Modify: `docs/extensions.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md` (§6.3)
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` (§3.9, §5.7)

**Interfaces:**
- Consumes: everything above; the existing socket harness in `extensions-socket.test.ts`.

- [ ] **Step 1: Write the failing socket test**

Add one test in `extensions-socket.test.ts` that starts the daemon with `extensions: { configDir }` (default builtin dir, so the builtin shell is discovered), creates a session with `extensions: ["@pisces/builtin-shell#shell"]`, reads `entries.snapshot` (entry present, not selected in persisted selection), confirms and starts a turn whose fake provider returns a tool call `printf socket-shell`, then asserts: the persisted tool node contains `socket-shell` and `exit code: 0`; the shell entry appears in `request.tools` for that turn; and before confirmation/selection it does not. Also assert `docs`-independent safety: a command with a `cwd` escaping the workspace yields `tool.denied` in the tool result and no throw.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/extensions-socket.test.ts`
Expected: FAIL until the wiring above is complete (should already pass if Tasks 1–5 are correct; if it passes, treat it as the acceptance test and proceed — note this in the report).

- [ ] **Step 3: Update the docs**

- HLD §6.3: add optional `files?: WorkspaceAccess` and `exec?: Exec` to `ToolInvocationContext`, with "host-injected; absent means the tool must fail safely" and a pointer to DDS §5.7.
- DDS §5.7.1/§5.7.2: state implemented status; record canonical root, deepest-existing-ancestor containment, `exists` throwing on escape, `storage.io` mapping; exec env allow-list, timeout, 1 s exit→close fallback, 64 KiB/stream truncation, direct-child-only kill, no supervision of orphaned children.
- DDS §3.9: add `workspace.path_outside` as an internal-only code.
- `docs/extensions.md`: new section "Built-in shell" with the exact entry name, selection example, argument schema, output/truncation behaviour, no-sandbox warning, not-enabled-by-default statement, and the documented residual risks (children may outlive a killed daemon).

- [ ] **Step 4: Run the full gate and the socket suite**

Run: `pnpm exec vitest run packages/daemon/test/extensions-socket.test.ts` then the full gate G. Expected: PASS; record actual counts, Node version and platform in the report. Remote CI remains unrun.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/test/extensions-socket.test.ts docs/extensions.md "docs/1 High-Level Design/1 High-Level Design.md" "docs/2 Detailed Design Specification/2 Detailed Design Specification.md"
git commit -m "feat(daemon): verify and document the built-in shell tool"
```

# CLI Non-interactive `run` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-interactive `pisces run [prompt]` with session selection, per-session options, queued prompts, turn execution, streamed/`--print`/`--json` output, and Ctrl-C cancellation.

**Architecture:** Extend the CLI protocol client with event-frame delivery (`onEvent`). A new `run.ts` composes existing protocol methods (`session.create`, `session.list`, `session.read`, `session.configure`, `entries.snapshot`, `queue.enqueue`, `session.subscribe`, `turn.start`, `turn.cancel`) and waits for `turn.ended`. No daemon/protocol changes.

**Tech Stack:** TypeScript ESM, Node >=22.19, Vitest, existing `connectClient`, `@pisces/daemon` gateway protocol types.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-run-noninteractive-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no `main` commit, no push/merge.
- No new protocol methods or daemon behavior; prompts only via `queue.enqueue`.
- Never print config values, credentials, environment values, or raw exceptions.
- Exit codes: 0 completed; 1 runtime/protocol/session failure; 2 usage or config; 130 interrupted (Ctrl-C).
- `--json` emits exactly one JSON object at the end; `--print` emits only final text; default streams text deltas.
- Gate G before every commit (native build, `tsc -b`, full vitest, `tsc -p`, `tsc -b`, biome, both rg scans exit 1, `git diff --check`, `git status --short`).
- Stage explicit files; `model="deepseek-flash"`; no nested subagents.

## Review Focus

1. Event framing: `{event,data}` frames are delivered without breaking response routing; malformed frames still kill the connection with `client.protocol`; unsubscribe/close stop delivery.
2. Session selection: no selector/`--new` create; `--continue` truly picks the newest by `createdAt`; `--session` read/`--create` fallback; mutual-exclusion and `--create`-only-with-`--session` enforced.
3. Ordering/atomicity: subscribe before enqueue; prompt and toggle declaration in one `queue.enqueue` batch; toggle diff never toggles unchanged entries; no prompt in request bodies.
4. Turn lifecycle: only `turn.ended` for the started `turnId` ends the command; failed reason prints safe code/message and exits 1; late/unrelated events ignored; Ctrl-C sends one `turn.cancel`, waits for end, exits 130.
5. Output contract: `--print` final text only, default deltas, `--json` one object with `{sessionId,turnId,reason,text,error?}`; no duplicated or missing text.

---

### Task 1: Client event delivery

**Files:**
- Modify: `packages/cli/src/client.ts`
- Modify: `packages/cli/src/sessions.ts` (narrow local client type if needed)
- Modify: `packages/cli/src/templates.ts` (same)
- Test: `packages/cli/test/client.test.ts`

**Interfaces:**
- Produces: `Client.onEvent(listener: (event: ProtocolEvent) => void): () => void`; `ProtocolEvent` imported from `@pisces/protocol` (shape `{event:string;data:JsonValue}`).
- Keeps: `request`/`close` unchanged; response frames with string `id` route exactly as before.

- [ ] **Step 1: RED tests** using the existing socket-pair helpers:
  - Event frame `{event:"turn.delta",data:{...}}` reaches one listener; second listener also receives; returned unsubscribe stops only that listener.
  - Response frame with `id` still resolves its waiter and does not reach listeners.
  - Malformed no-`id`/no-`event` frame → existing `client.protocol` failure and pending request rejects.
  - `close()` clears listeners; later frames deliver nothing.
- [ ] **Step 2: RED** `pnpm exec vitest run packages/cli/test/client.test.ts`.
- [ ] **Step 3: Implement** listener set + dispatch in `handleLine`; clear on `close`; export type. Adjust local client types in sessions/templates only if the compiler requires it (do not weaken `Client`).
- [ ] **Step 4: GREEN + full gate; commit** `feat(cli): deliver protocol events to client listeners`.

---

### Task 2: `run.ts` command, parsing and dispatch

**Files:**
- Create: `packages/cli/src/run.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/run-command.test.ts`

**Interfaces:**
- Produces: `RunOptions {configPath; dataDir?; io?; prompt; newSession; continueSession; sessionId?; create; model?; provider?; systemPrompt?; useDefaultSystemPrompt; enable: string[]; disable: string[]; print; json}`; `RunDeps {connect(socketPath, timeoutMs?): Promise<Client>; onInterrupt(handler: () => void): () => void}`; `productionRunDeps`; `runCommand(options, deps?): Promise<number>`.
- `main.ts`: parser accepts the syntax in the spec; `--enable`/`--disable` repeatable; `--model`/`--provider` take values; `--print`/`--json` mutually exclusive; unknown/positional extras → 2. `runCli` gains a 7th optional `RunDeps` parameter defaulting to production.

- [ ] **Step 1: RED tests (fake client with event emitter + recorder io)**:
  - No selector: `session.create` with model/provider/systemPrompt as given (omit absent), then subscribe, enqueue one user prompt `{kind:"agent",role:"user",source:"run",content:[{type:"text",text}]}`, `turn.start`; emit `turn.delta` text and `turn.ended` completed → default stdout text + newline; exit 0; unsubscribe/close.
  - `--print`: deltas not printed, final text only; `--json`: one object `{sessionId,turnId,reason:"completed",text}`.
  - `--continue`: `session.list` with several metas → newest `createdAt`; no sessions → `session.not_found` 1.
  - `--session` found: `session.read` meta used, no create; `--session` missing + `--create` → create; missing without → error 1.
  - Existing session with `--model/--provider/--system-prompt` → `session.configure` with exactly those fields; `--use-default-system-prompt` on existing → `run.default_system_prompt_unsupported` 1.
  - `--enable`/`--disable`: `entries.snapshot` selection `["a#x","b#y"]`, enable `c#z`, disable `b#y`, enable `a#x` → one declaration toggling `["a#x"→no], verify exact toggle payload `["c#z","b#y"]` order as computed (define deterministic order: enables in given order then disables in given order), same `queue.enqueue` batch as prompt; no changes → no control entry.
  - `turn.ended` failed with `{code:"turn.empty",message:...}` → stderr fixed, exit 1; `--json` still emits object with `error`, no stderr.
  - Unrelated `turnId`/session events ignored; duplicate `turn.ended` only first completes.
  - Injected interrupt after `turn.start` → one `turn.cancel {turnId}`, wait for ended, exit 130.
  - config 2 (no connect); connect 1; protocol error passthrough; missing/empty prompt, conflicting selectors, `--create` alone, `--print --json` → 2.
- [ ] **Step 2: RED** `pnpm exec vitest run packages/cli/test/run-command.test.ts`.
- [ ] **Step 3: Implement** resolution, validation, subscribe-before-enqueue, single enqueue batch, event wait, output modes, interrupt seam, cleanup. Reuse `withSessionsClient`-style error mapping locally.
- [ ] **Step 4: GREEN + full gate; commit** `feat(cli): run a turn from the command line`.

---

### Task 3: Real-socket acceptance, docs, final gate

**Files:**
- Create: `packages/cli/test/run-e2e.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`

**Interfaces:** consumes `runCommand`; patterns from `sessions-export-cancel-e2e.test.ts` and `gateway-turn.test.ts` (provider host, blocked generator, built CLI cleanup).

- [ ] **Step 1: Acceptance**
  - Real in-process daemon + stub provider yielding text: `run "hello" --print` → final text, exit 0; `--json` object with `sessionId/turnId/reason/text`; `session.list` shows the now-persisted session; session meta workspace/provider/model match daemon defaults.
  - `--continue` picks the persisted session (second run).
  - `--enable`/`--disable` in non-extension daemon mode → protocol queue error surfaced safely (or a configured-mode daemon case proving toggle payload accepted).
  - Blocked provider + injected interrupt → turn cancelled, exit 130, turn gone from `turn.list`.
  - Failed provider (turn.end failed) → exit 1, no success text; JSON includes `error`.
  - Daemon stopped → exit 1 `daemon.unreachable`.
  - Built CLI subprocess at least once with `--print` against a daemon started by `pisces start` (fake baseUrl never dialed if provider not used? use in-process daemon instead to avoid network), cleanup children/pids.
- [ ] **Step 2: Docs** — `docs/cli.md` `run` section (syntax, selection, option semantics, output modes, exit codes incl. 130, cancellation caveat); HLD §6.8 and status §8.1; DDS §7.2 mark implemented with the event/output contract and remaining limitations.
- [ ] **Step 3: Full gate G; record counts; remote CI not run.** Commit `feat(cli): verify non-interactive run`.

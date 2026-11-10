# CLI Sessions Export and Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pisces sessions export <session-id>` (JSONL `SessionNode` records, full tree or `--node` branch) and `pisces sessions cancel <session-id>` (resolve active turn via `turn.list`, then `turn.cancel`).

**Architecture:** Extend the existing sessions CLI family. A shared short-connection helper in `sessions.ts` is reused by list/export/cancel. Export loops `session.read` with `cursor`/`nextCursor`; cancel selects `turn.list` entries by `sessionId`. No daemon or protocol changes.

**Tech Stack:** TypeScript ESM, Node >=22.19, Vitest, `connectClient`, `socketPathFor`, `session.read`, `turn.list`, `turn.cancel`.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-sessions-export-cancel-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no `main` commit, no push/merge.
- CLI only via protocol; never read `events.jsonl` or session files directly.
- Export JSONL is exactly one `SessionNode` JSON object per line, no wrapper, no field trimming.
- No `--output`; stdout only. No new protocol methods.
- Fixed messages; never echo config values, paths, or raw exceptions.
- Exit codes: config 2; connect 1; protocol error by code 1; usage 2; no active turn 0.
- Gate G before every commit (native build, `tsc -b`, full vitest, `tsc -p`, `tsc -b`, biome, both rg scans exit 1, `git diff --check`, `git status --short`).
- Stage explicit files; `model="deepseek-flash"`; no nested subagents.

## Review Focus

1. Pagination: first request has no `cursor`, later requests carry the prior `nextCursor`; loop stops exactly when `nextCursor` is absent; repeated cursor cannot loop forever; records from all pages are printed in order, once.
2. Export fidelity: each line parses to the same object the daemon returned (unknown/optional fields preserved); no `queue`/`selection`/`meta` leakage; `--node` forwarded only when given.
3. Cancel selection: only turns whose `sessionId` matches are cancelled; no active turn → `no active turn`, 0; false → `turn.cancel_failed`, 1; protocol errors pass through.
4. Failure atomicity: malformed `session.read`/`turn.list`/`turn.cancel` responses produce `client.protocol`, exit 1, and never print a partial line/claim success.
5. Dispatch regressions: `sessions list` unchanged; export/cancel usage errors exit 2; shared helper preserves list behavior and closes the client on all paths.

---

### Task 1: Shared session helper + `sessions export`

**Files:**
- Modify: `packages/cli/src/sessions.ts`
- Create: `packages/cli/src/session-export.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/session-export-command.test.ts`
- Test: `packages/cli/test/sessions-command.test.ts` (regression only)

**Interfaces:**
- Produces: `withSessionsClient(options, deps, run)` in `sessions.ts`; `SessionExportOptions {configPath; dataDir?; io?; sessionId: string; nodeId?: string}`; `sessionExport(options, deps?): Promise<number>` in `session-export.ts`.
- Consumes: `SessionsClient`/`SessionsDeps`, `loadConfig`, `socketPathFor`, `ClientError`, `CommandIo`.

- [ ] **Step 1: RED tests** with fake client:
  - two-page tree export: first request `{sessionId}`; response `{records:[a,b], nextCursor:"b"}`; second request `{sessionId, cursor:"b"}`; response `{records:[c]}` → stdout `a`, `b`, `c` lines, each `JSON.stringify`-equal; client closed.
  - `--node n1` forwards `nodeId:"n1"` on every page.
  - empty `records` → no stdout, exit 0.
  - malformed result (missing/non-array records, record missing required fields) → `client.protocol`, exit 1, no stdout; repeated `nextCursor` → exit 1.
  - protocol error passthrough (`session.node_not_found`, `session.not_found`).
  - config failure 2 (no connect); connect failure 1.
  - dispatch: `sessions export s1`, `--node n --data-dir /x`; missing session id / unknown flag → 2; `sessions list` tests unchanged.
- [ ] **Step 2: Run RED**: `pnpm exec vitest run packages/cli/test/session-export-command.test.ts` → module/export missing.
- [ ] **Step 3: Implement**
  - Extract `withSessionsClient(options, deps, run)` from `sessionsList` preserving exact config/connect/error/close behavior; `sessionsList` uses it.
  - `sessionExport`: loop `session.read`; validate each page is a record with `records` array and optional string `nextCursor`; validate record has string `id`, `parentId`, `kind`, `role`, `source`, `createdAt`, numeric `schemaVersion`, `content` array; print raw record with `io.out(JSON.stringify(record))`.
  - `main.ts`: extend `SessionsParsed` to a union for `list|export|cancel`; export takes one positional session id, `--node` only for export; update `USAGE`; wire dispatch.
- [ ] **Step 4: GREEN + gate G; commit** `feat(cli): export session records as jsonl`.

---

### Task 2: `sessions cancel`

**Files:**
- Create: `packages/cli/src/session-cancel.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/session-cancel-command.test.ts`

**Interfaces:**
- Produces: `SessionCancelOptions {configPath; dataDir?; io?; sessionId: string}`; `sessionCancel(options, deps?): Promise<number>`.
- Consumes: `withSessionsClient`, `SessionsDeps`.

- [ ] **Step 1: RED tests**:
  - `turn.list` returns `[{sessionId:"other"...},{sessionId:"s1", turnId:"t1"}]` → exactly one `turn.cancel {turnId:"t1"}`; stdout `cancelled t1`; exit 0.
  - no matching turn → `no active turn`, exit 0, no cancel call.
  - `{cancelled:false}` → stderr `error: turn.cancel_failed: Cancel request was not accepted`, exit 1, no success stdout.
  - malformed `turn.list`/`turn.cancel` → `client.protocol`, exit 1.
  - multiple matching turns → cancel each in order; one false → exit 1.
  - config/connect failures; dispatch `sessions cancel s1`, missing id/unknown flag → 2.
- [ ] **Step 2: RED**, `pnpm exec vitest run packages/cli/test/session-cancel-command.test.ts`.
- [ ] **Step 3: Implement** validation + selection + cancel loop; `main.ts` dispatch for `cancel` (same one-positional rule); `USAGE` wording.
- [ ] **Step 4: GREEN + gate G; commit** `feat(cli): cancel a session's active turn`.

---

### Task 3: Real-socket/built-CLI acceptance, docs, final gate

**Files:**
- Create: `packages/cli/test/sessions-export-cancel-e2e.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`

**Interfaces:** consumes Task 1/2 commands; patterns from `sessions-list-socket.test.ts` and `templates-e2e.test.ts`.

- [ ] **Step 1: Acceptance**
  - Real in-process daemon: create session, enqueue, `turn.start` with a provider that holds the stream open until aborted; wait until a node exists; export full tree → JSONL lines parse to `SessionNode`s; export `--node <last>` → linear branch (ancestor chain only).
  - Start a real turn, run `sessions cancel` → output, exit 0; wait `turn.list` empty; second cancel → `no active turn`, 0.
  - Stop daemon → export/cancel exit 1 `daemon.unreachable`.
  - Built CLI subprocess at least once each (start daemon via `pisces start`, export existing session and cancel when idle); cleanup children/pids like existing e2e.
- [ ] **Step 2: Docs** — `docs/cli.md` sections for both commands (syntax, JSONL contract, `--node`, exit codes, `no active turn`, `turn.cancel_failed`); HLD §6.8 command tree; DDS §7.1 table and §7.2 “not implemented” list.
- [ ] **Step 3: Full gate G; record counts; remote CI not run.** Commit `feat(cli): verify session export and cancel`.

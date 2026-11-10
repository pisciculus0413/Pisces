# `status` Active Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show unique active `sessionId` values from `turn.list` in `pisces status` human and `--json` output.

**Architecture:** Add a `listSessions(socketPath)` seam to `CommandDeps`; production opens one short connection, sends `turn.list`, validates and dedupes. `statusCommand` queries only for `running`/`unmanaged` and renders `sessions` in human/JSON forms without changing exit codes.

**Tech Stack:** TypeScript ESM, Vitest, existing `connectClient`/`socketPathFor`, `CommandIo`.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-status-sessions-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no `main` commit, no push/merge.
- No protocol/daemon changes; only `turn.list` read.
- Output only `sessionId` values; never turnId, meta, paths beyond existing fields, or errors.
- Exit codes unchanged; query failure never changes status code or writes stderr.
- Gate G before commit (native build, `tsc -b`, full vitest, `tsc -p`, `tsc -b`, biome, both rg scans exit 1, `git diff --check`, `git status --short`).
- Stage explicit files; `model="deepseek-flash"`; no nested subagents.

## Review Focus

1. Query gating: no `listSessions` call for stopped/stale/unresponsive/unknown-owner; called for running and unmanaged only.
2. Failure containment: connect/protocol/malformed `turn.list` → human `sessions: unavailable`, JSON omits `sessions`, exit code unchanged, no stderr.
3. Dedup/order: same sessionId twice → once, first occurrence order preserved; empty → `sessions: none` / `[]`.
4. Data safety: JSON adds only `sessions`; no turnId or raw error; existing `--json` fields unchanged.
5. Seam: production closes the connection on every path; fake deps compile and existing lifecycle tests unaffected.

---

### Task 1: Implement `status` sessions, tests, acceptance, docs

**Files:**
- Modify: `packages/cli/src/commands.ts` (deps + production implementation + status rendering)
- Modify: `packages/cli/test/commands.test.ts`
- Create: `packages/cli/test/status-sessions-e2e.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`

**Interfaces:**
- Produces: `CommandDeps.listSessions(socketPath: string): Promise<string[]>`.
- Consumes: `connectClient`, `turn.list`; `TurnListResult` shape `{turns:[{sessionId,turnId,startedAt}]}`.

- [ ] **Step 1: RED unit tests** in `commands.test.ts`:
  - running: two turns, same session twice then another → human second line `sessions: a, b`; called once with the socket.
  - running + empty turns → `sessions: none`; `--json` has `"sessions":[]`.
  - running + `listSessions` rejects → human `sessions: unavailable`; `--json` has no `sessions` key; exit 0.
  - running + malformed result is production-parser behavior (see Step 3): unit-test the production `listSessions` separately with a fake socket/server if feasible, or cover via e2e/daemon.
  - unmanaged: called; stopped/stale/unresponsive: not called (assert zero calls); unknown-owner: not called (existing error path).
  - `--json` output adds only `sessions` (compare full object), no turnId; `sessions` omitted for stopped/stale/unresponsive.
- [ ] **Step 2: RED** `pnpm exec vitest run packages/cli/test/commands.test.ts`.
- [ ] **Step 3: Implement**
  - `CommandDeps.listSessions`; production uses `connectClient(socketPath)` + `turn.list`, validates record/`turns` array and each `sessionId` string (ignore unrelated fields), dedupes in order, closes in `finally`; any error propagates.
  - `statusCommand`: after state determined, if `running`/`unmanaged` query; render human line and JSON field per design; never change code/stderr.
  - Update all fake deps/helpers in tests to supply `listSessions` (default empty) without altering existing assertions.
- [ ] **Step 4: GREEN** focused test.
- [ ] **Step 5: E2E** `status-sessions-e2e.test.ts`: real in-process daemon + blocked provider → active turn; `statusCommand` (production deps, config/dataDir) human/`--json` shows the sessionId; no duplicate; stopped daemon → stopped with no `sessions`; no network.
- [ ] **Step 6: Docs** — `docs/cli.md` status section (human/JSON examples, `none`/`unavailable`, gating); HLD status description and DDS §7.1 status row/§7.5.
- [ ] **Step 7: Full gate G; commit** `feat(cli): report active sessions in status`.

## Report

`.superpowers/sdd/2026-11-09-cli-status-sessions/task-1-report.md`; reply Status, commit, test summary, concerns.

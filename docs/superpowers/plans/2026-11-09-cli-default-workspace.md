# Default Workspace and `run --workspace` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make global `defaultWorkspace` seed daemon `SessionDefaults.workspace`, and add `pisces run --workspace <dir>` for new sessions.

**Architecture:** Extend `CliConfig`/`loadConfig` and `buildDaemonOptions`; extend `RunOptions`/parser/create call; reject workspace on existing sessions locally. No protocol/daemon behavior changes.

**Tech Stack:** TypeScript ESM, Vitest, existing config/assembly/run modules and e2e harnesses.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-default-workspace-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no `main` commit, no push/merge.
- No protocol/daemon changes; `defaultWorkspace` stays global-only and absolute.
- Existing sessions never change workspace; `--workspace` with an existing session → `run.workspace_unsupported` exit 1.
- Fixed messages; no config/secrets leakage.
- Gate G before commit (native build, `tsc -b`, full vitest, `tsc -p`, `tsc -b`, biome, both rg scans exit 1, `git diff --check`, `git status --short`).
- Stage explicit files; `model="deepseek-flash"`; no nested subagents.

## Review Focus

1. Merge semantics: `defaultWorkspace` merges with `defaults` without dropping provider/model; only-workspace and neither cases; no empty `defaults`.
2. Validation parity: global loader accepts absolute `defaultWorkspace`, rejects relative/empty/non-string; workspace layer still rejects it; draft validation unchanged where it should be.
3. Run semantics: `--workspace` reaches only `session.create` (including `--session --create` fallback); existing session returns the local code before any write; relative/empty → 2; no flag preserves old behavior.
4. Daemon restart reality: docs state running daemons keep old defaults; acceptance restarts.
5. Tests bite: dropping merge field, passing workspace to configure, or accepting relative paths fails.

---

### Task 1: Config/assembly plumbing, `run --workspace`, acceptance, docs

**Files:**
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/run.ts`
- Modify: `packages/cli/src/main.ts` (parser/USAGE)
- Modify: `packages/cli/test/config.test.ts`
- Modify: `packages/cli/test/assembly.test.ts`
- Modify: `packages/cli/test/run-command.test.ts`
- Create: `packages/cli/test/default-workspace-e2e.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`

**Interfaces:**
- `CliConfig.defaultWorkspace?: string`
- `RunOptions.workspace?: string`
- Existing `StartDaemonOptions.defaults` already supports `workspace`.

- [ ] **Step 1: RED config/assembly tests**
  - `parseConfig` returns `defaultWorkspace` for absolute; rejects relative/empty/non-string with `config.invalid`; workspace scope still rejects the key; `loadConfig` returns it; `config list --json` includes it (update expected key lists).
  - `buildDaemonOptions`: workspace only → `defaults {workspace}`; workspace+defaults → both; neither → no `defaults`; templates/providerHost unaffected.
- [ ] **Step 2: RED run tests**
  - `run --workspace /tmp/ws --new` → `session.create` params include `workspace`; `--session s --create` missing session → create includes workspace; existing session + `--workspace` → `run.workspace_unsupported` 1, no configure/enqueue; relative/empty `--workspace` → 2 without connect; without flag → no workspace param.
- [ ] **Step 3: Implement**
  - `config.ts`: add field, parse with absolute check, include in returned config; draft already validates via extension parser (verify).
  - `assembly.ts`: merge defaults as specified.
  - `run.ts`: add `workspace`, local absolute validation, pass to create only; existing session guard.
  - `main.ts`: `--workspace` value parsing + USAGE.
- [ ] **Step 4: GREEN focused** (`config`, `assembly`, `run-command`).
- [ ] **Step 5: E2E** `default-workspace-e2e.test.ts`: temp global config with `defaultWorkspace` + temp dataDir, start daemon via `pisces start` (or in-process `buildDaemonOptions` + `startDaemon`) with stub provider; `run --print` without `--workspace` creates session whose meta.workspace equals default; restart daemon after config change proves new default; `run --workspace` overrides; existing session + `--workspace` fails with the local code. Use real socket/process; no network.
- [ ] **Step 6: Docs** — `docs/cli.md` config table (`defaultWorkspace` now effective), run options/table, restart caveat; HLD/DDS config/run/status sections.
- [ ] **Step 7: Full gate G; commit** `feat(cli): honor default workspace and add run workspace`.

## Report

`.superpowers/sdd/2026-11-09-cli-default-workspace/task-1-report.md`; reply Status, commit, test summary, concerns.

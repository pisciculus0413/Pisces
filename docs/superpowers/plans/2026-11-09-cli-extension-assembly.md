# CLI Extension Assembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start every CLI-launched daemon in directory-driven extension mode using the exact config file path, reading config and scanning extension directories only in `prepare(workspace)`.

**Architecture:** Add `configPath` to daemon `ExtensionsOptions` and derive the config/extension root. `buildDaemonOptions` passes only `extensions.configPath` plus templates (no `defaults`), letting the daemon read `defaults`/`defaultWorkspace`/`extensions`/`entryConfig` at `session.create`. Update docs to remove the restart caveat.

**Tech Stack:** TypeScript ESM, Vitest, existing `Extensions`/`discoverExtensions`, CLI assembly, real-socket + local SSE test server.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-extension-assembly-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no `main` commit, no push/merge.
- Startup passes only locations; no config read or extension scan at start.
- No protocol changes. Builtin shell stays disabled by default.
- `defaults`/`defaultWorkspace` come from the extension config layer at `session.create`; no restart needed for new sessions.
- Fixed safe errors; never print extension paths, config values or raw loader errors.
- Gate G before every commit (native build, `tsc -b`, full vitest, `tsc -p`, `tsc -b`, biome, both rg scans exit 1, `git diff --check`, `git status --short`).
- Stage explicit files; `model="deepseek-flash"`; no nested subagents.

## Review Focus

1. Path resolution: `configPath` wins; extension dir = `dirname(configPath)/extensions`; `configDir` legacy still works; neither → safe failure; relative CLI path absolutized.
2. Timing: no file read at construction; `prepare(workspace)` reads exact global file + workspace layer and scans both dirs; config changes apply to new sessions without restart.
3. Mode exclusivity: CLI no longer injects `defaults` (would fail startup); providers/templates still assembled; `start` behavior unchanged otherwise.
4. Tool path: builtin shell enabled via config or `--enable`, actually executes through the real provider loop; no extension code loaded before selection.
5. Regressions: configured-mode defaults/workspace resolution, workspace extensions, custom `--config alt.json`, template assembly, lifecycle start/stop.

---

### Task 1: daemon `configPath` support

**Files:**
- Modify: `packages/daemon/src/extensions/types.ts`
- Modify: `packages/daemon/src/extensions/config.ts` (path helper)
- Modify: `packages/daemon/src/extensions/extensions.ts`
- Modify: `packages/daemon/src/extensions/discovery.ts` (only if configDir resolution needs it)
- Modify: `packages/daemon/src/index.ts` (export if needed)
- Test: `packages/daemon/test/extensions-config.test.ts`, `packages/daemon/test/gateway-extensions.test.ts` or a focused new test.

**Interfaces:**
- `ExtensionsOptions { configDir?: string; configPath?: string; builtinDir?: string }`.
- Produces internal resolved `{configDir, configPath}`; `createExtensions` resolves once and uses `configPath` for global read, `configDir/extensions` for discovery.
- `readGlobalConfig` remains for `configDir` callers; add/extend path-based helper without breaking exports.

- [ ] **Step 1: RED tests**
  - `prepare` with only `configPath` pointing at `alt.json` in a temp dir: defaults/workspace/extensions/entryConfig from that file; `<dir>/extensions/<pkg>` discovered; `<dir>/config.json` is *not* read.
  - `configDir` only still reads `<dir>/config.json` and scans `<dir>/extensions`.
  - both missing → construction/start failure with safe `config.invalid`.
  - config editing after construction but before `prepare` is observed (proves no eager read).
- [ ] **Step 2: RED**, implement resolution/read/discovery, GREEN focused.
- [ ] **Step 3: Gate G; commit** `feat(daemon): locate extension config by file path`.

---

### Task 2: CLI always assembles extensions

**Files:**
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/daemon-child.ts`
- Modify: `packages/cli/test/assembly.test.ts`
- Modify: `packages/cli/test/default-workspace-e2e.test.ts`
- Modify: `packages/cli/test/templates-command.test.ts`
- Modify: `packages/cli/test/cli-lifecycle.test.ts` (if start options asserted)
- Modify: docs only where the old startup-defaults/restart behavior is stated (full docs pass in Task 3).

**Interfaces:**
- `buildDaemonOptions(config, dataDir, env, options: {configPath: string; templatesDir?: string})`.
- Always `extensions: {configPath: resolve(options.configPath)}`; never `defaults`.
- `templates` still from `templatesDir`.

- [ ] **Step 1: RED assembly tests**
  - options include `extensions: {configPath}` (absolute) and no `defaults` for configs with defaults/defaultWorkspace.
  - templates still passed; providerHost/providers unchanged.
  - `daemonChildMain` forwards its config path.
- [ ] **Step 2: RED, implement, GREEN focused.**
- [ ] **Step 3: Update default-workspace e2e**
  - In-process daemon from `buildDaemonOptions` now reads `defaultWorkspace` at `session.create`; changing config while running must affect the **next new session without restart** (old restart expectation replaced).
  - Keep `--workspace` override and existing-session rejection.
- [ ] **Step 4: Gate G; commit** `feat(cli): assemble directory-driven extensions`.

---

### Task 3: Real tool acceptance, docs, final gate

**Files:**
- Create: `packages/cli/test/extensions-e2e.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/extensions.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`

**Interfaces:** consumes Tasks 1–2; local HTTP SSE server pattern from `packages/core/test/providers-openai-chat.test.ts`.

- [ ] **Step 1: Tool acceptance**
  - Temp config enables `["@pisces/builtin-shell#shell"]`, provider `baseUrl` points at a local HTTP server; start a real in-process daemon via `buildDaemonOptions` (real providerHost) + `startDaemon`.
  - Server first returns an OpenAI `tool_calls` chunk requesting the shell tool to run `printf tool-ok` (or equivalent), then after the tool result returns a final text chunk.
  - `run "..." --print` (CLI function or built `dist/main.js`) succeeds; output contains the command output/tool round-trip; `entries.snapshot`/session records show the tool call and result; no network beyond localhost.
  - Variant: config without `extensions` + `run --enable @pisces/builtin-shell#shell` succeeds.
  - Variant: `--config alt.json` reads alt file and `alt/extensions` (not sibling `config.json`).
  - Workspace `.pisces/extensions` discovery: create a tiny package there and select it, or state honestly if deferred.
- [ ] **Step 2: Docs**
  - `docs/cli.md`: CLI now always assembles extensions; config read at `session.create`; no restart needed for defaults/workspace/extension config changes; `templatesDir` still startup-bound; `--config` exact path also sets extension dir.
  - `docs/extensions.md`: remove "CLI 尚不装配扩展"; document startup path injection + create-time read/scan.
  - HLD §6.6/§7.2/§8.1 and DDS §5.1/§5.5/§7.5: align timing, options, no-restart semantics; leftover-unimplemented lists unchanged otherwise.
- [ ] **Step 3: Full gate G; record counts; remote CI not run.** Commit `feat(cli): verify extension assembly and tool execution`.

## Report

`.superpowers/sdd/2026-11-09-cli-extension-assembly/task-N-report.md`; reply Status, commit, test summary, concerns.

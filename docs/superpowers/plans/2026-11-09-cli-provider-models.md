# CLI Provider and Models List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only `pisces provider list` and `pisces models list` over the existing `provider.list` protocol method.

**Architecture:** One new CLI module (`providers.ts`) reuses the established short-connection pattern (`loadConfig` → `socketPathFor` → `connectClient`). Both commands send `provider.list`; `models list` flattens and optionally filters client-side. No daemon or protocol changes.

**Tech Stack:** TypeScript ESM, Node >=22.19, Vitest, existing `connectClient`/`socketPathFor`, `@pisces/daemon` protocol types.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-provider-models-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no commit to `main`, no push/merge.
- Only `provider.list` is used; no new protocol methods, no daemon behavior changes, no local provider-definition reads.
- Never print `baseUrl`, headers, credentials, or environment values.
- Exit codes: unreadable config `config.invalid` → 2; connect failure `daemon.unreachable` → 1; protocol errors → 1; unknown `--provider` `provider.not_found` → 1; usage errors → 2.
- `--json` shapes: `provider list` = raw `{providers}`; `models list` = `{models: [{provider, id, contextWindow, maxOutput, modalities, pricing?}]}`.
- Human: `provider` line `id  ready|unready  models=<n>`; model line `provider/model  context=<n>  maxOutput=<n>  modalities=text,image`.
- `models list` lists all providers regardless of `ready`; empty result → `no models`, exit 0.
- Gate G before every commit: native build; `tsc -b`; full vitest; `tsc -p`; `tsc -b`; biome; both rg boundary scans (exit 1); `git diff --check`; `git status --short`.
- Stage explicit files; agents use `model="deepseek-flash"`; no nested subagents.

## Review Focus

1. Response validation: malformed/missing `providers`, non-string ids, non-boolean `ready`, malformed models, non-integer/negative context/maxOutput, unknown modality → `client.protocol`, exit 1, never print partial data.
2. Filtering: `--provider` missing/unknown exits 1 with `provider.not_found`; valid filter keeps only that provider; no filter lists every provider including `ready:false` and empty model lists.
3. Output honesty: no `baseUrl`/headers/credential values in human or JSON output; `pricing` only in `models --json`.
4. Connection/exit behavior: config failure 2 before connecting; daemon down 1 with fixed text; protocol error code/message passthrough; client always closed.
5. Dispatch regression: existing `start/status/stop/config/extensions/templates/sessions` parsing and exit codes unchanged; `provider`/`models` bad subcommands exit 2.

---

### Task 1: `providers.ts` commands and dispatch

**Files:**
- Create: `packages/cli/src/providers.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/test/providers-command.test.ts`

**Interfaces:**
- Produces: `providerList(options, deps?)`, `modelsList(options, deps?)`, `ProvidersOptions {configPath; dataDir?; io?; json?}`, `ModelsOptions extends ProvidersOptions {provider?}`, `ProvidersDeps {connect(...)}`.
- Consumes: `connectClient`, `ClientError`, `UNREACHABLE_MESSAGE` (`client.ts`); `loadConfig`; `socketPathFor`; `CommandIo`.

- [ ] **Step 1: Write the failing tests** with an injected fake client and fake `io`:
  - `providerList` human: two providers → `alpha  ready  models=1`, `beta  unready  models=0`.
  - `providerList --json` prints raw `{providers}` unchanged.
  - `modelsList` human: models flattened, providers sorted lexicographically, model order preserved, modalities joined with `,`; pricing absent from human output.
  - `modelsList --json` shape includes `pricing` when present.
  - `modelsList --provider alpha` keeps only alpha; `--provider missing` → stderr `error: provider.not_found: ...`, exit 1, no stdout.
  - Empty `providers` → `no models`, exit 0 (both JSON? JSON is `{models:[]}`).
  - Malformed response (missing `providers`, `ready: "yes"`, `contextWindow: 0`, unknown modality) → `error: client.protocol: ...`, exit 1.
  - `loadConfig` failure → exit 2 without connecting; connect failure → `daemon.unreachable`, exit 1; protocol `PiscesError`/`ClientError` code passthrough exit 1; client closed on all paths.
  - `runCli` dispatch: `provider list`, `models list`, `models list --provider p --json --data-dir /x`; `provider`/`models` with missing/unknown subcommand or bad flag → 2.

- [ ] **Step 2: Run RED**
  `pnpm exec vitest run packages/cli/test/providers-command.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - `providers.ts`: response parser with exact `ProviderInfo`/`ModelInfo` checks; `providerList` prints/JSON; `modelsList` flattens `{provider: provider.id, ...model}`, sorts provider ids, applies `--provider`, validates filter existence, prints/JSON.
  - Reuse a `withClient`-style helper (local to this module is fine) mapping errors exactly like `templates.ts`: `config.invalid` (2), `daemon.unreachable` (1), `ClientError` code/message (1), anything else `client.protocol` (1); `finally { client.close() }`.
  - `main.ts`: parse `provider list` and `models list`; accept `--config`, `--data-dir`, `--json`, `--provider` (models only); usage errors 2; wire before lifecycle fallthrough.
  - No daemon/protocol changes.

- [ ] **Step 4: Run GREEN + gate G, commit**
  `git add packages/cli/src/providers.ts packages/cli/src/main.ts packages/cli/test/providers-command.test.ts`
  `git commit -m "feat(cli): list providers and models over the protocol"`

---

### Task 2: Real-socket acceptance, docs and final gate

**Files:**
- Create: `packages/cli/test/providers-e2e.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`

**Interfaces:** consumes Task 1 commands; existing daemon test harness / CLI build helpers from `packages/cli/test/templates-e2e.test.ts`.

- [ ] **Step 1: Acceptance tests**
  - Start a real daemon with two registered providers (one with 1–2 models, one with zero models), using the existing host/test-seam approach from the daemon suites.
  - `provider list`: exit 0, human lines match `ready` state and `models=<n>`; `--json` equals the protocol result.
  - `models list`: exit 0, all models including the empty provider contributes none; `--provider` filters; unknown provider exits 1 with `provider.not_found`; `--json` shape.
  - Stopped daemon: both commands exit 1 with `daemon.unreachable`.
  - Run the real built CLI (subprocess) at least once per command.
- [ ] **Step 2: Docs**
  - `docs/cli.md`: add both commands with options, output examples, exit codes; update delivered/undelivered list.
  - HLD §7 and DDS §3.7.1/§7.1: mark CLI entries implemented; `models list` flatten/filter semantics and `provider.not_found`.
- [ ] **Step 3: Full gate G; record actual counts, Node/platform; state remote CI not run.**
  `git add` the test + docs; `git commit -m "feat(cli): verify provider and model listing"`.

# Template System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a declarative template system: validated templates, side-effect-free preview, confirmed apply via `WorkspaceAccess`/`ExecHost`, project records, Gateway routes, `session.create` template defaults, and `pisces templates` commands.

**Architecture:** Core holds template types only. A daemon `TemplateStore` loads and validates `<configDir>/templates/*.json`, previews conflicts, and applies files/script/project records; the Gateway owns session creation and validation order. The CLI talks to the daemon over the existing NDJSON protocol via a new minimal client.

**Tech Stack:** TypeScript ESM, Node >=22.19, pnpm workspace, Vitest, existing `WorkspaceAccess`/`ExecHost`, `@pisces/protocol`.

**Spec:** `docs/superpowers/specs/2026-11-09-templates-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no commit to `main`, no push/merge.
- Core has no filesystem/environment I/O and no daemon/protocol imports; both boundary scans must stay exit 1.
- Gate G before every commit: `node packages/daemon/native/build.mjs`; `pnpm exec tsc -b tsconfig.build.json`; `pnpm exec vitest run`; `pnpm exec tsc -p tsconfig.json`; `pnpm exec tsc -b tsconfig.build.json`; `pnpm exec biome check .`; the two `rg` boundary scans (expect exit 1); `git diff --check`; `git status --short`.
- Stage explicit paths only; subagents use `model="deepseek-flash"`; no nested agents.
- Exact values: template dir `<configDir>/templates`, one `<id>.json` per template, id equals filename stem; single template JSON ≤ `1_048_576` bytes; `initScript.timeoutMs` integer `1..600_000`, default `60_000`; `projects.json` mode `0600` in `<dataDir>` written tmp+rename.
- Error codes: `template.not_found`, `template.invalid`, `template.init_failed`, `template.workspace_conflict`, plus existing `session.invalid_workspace`, `session.model_required`, `session.invalid_model`, `storage.io`, `storage.corrupt`. Messages are fixed and never echo file contents or paths from the template on failure (preview legitimately lists paths).
- `template.preview` performs no writes and runs no script; `template.apply` requires `confirmed: true` and all session-config validation completes before the first write.
- Workspace must already exist; the store never creates the workspace root.
- CLI-started daemons remain in no-extension mode; templates with `config.extensions` are rejected there by existing semantics, not newly added plumbing.

## Review Focus

1. Path escape: template `directories`/`files` entries with `..`, absolute paths, NUL, or symlink escape must be rejected at load and re-resolved through `WorkspaceAccess` at apply; no file may land outside the workspace.
2. Side-effect freedom: `preview` (and `session.create {templateId}`) must not create, modify, or execute anything, including when the template is invalid or conflicts.
3. Ordering: conflicts, workspace validity, provider/model, and extension legality must fail before the first write; a failed script must not create a session or a `ProjectRef`.
4. Concurrency/durability: `projects.json` append must be atomic and survive parallel applies; corrupt/missing records fail closed without partial writes.
5. CLI wire honesty: `templates apply` must require `--confirm`, surface protocol codes unchanged, print nothing secret, and exit 2 for usage errors vs 1 for daemon/template failures.

---

### Task 1: Core template types and template loading/validation

**Files:**
- Create: `packages/core/src/templates/types.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/daemon/src/templates/schema.ts`
- Test: `packages/daemon/test/templates-schema.test.ts`

**Interfaces:**
- Produces: `TemplateInfo`, `TemplatePreview`, `ProjectRef` (core); `LoadedTemplate`, `TemplateIssue`; `loadTemplates(configDir: string): Promise<{ templates: LoadedTemplate[]; issues: TemplateIssue[] }>`; `parseTemplate(id: string, raw: string): LoadedTemplate` where `LoadedTemplate` includes `info`, `directories`, `files`, `initScript?`, `config?`.

- [ ] **Step 1: Define core types and export them**

```ts
export interface TemplateInfo { id: string; name: string; description?: string }
export interface TemplatePreview {
  directories: string[];
  files: { path: string; content: string }[];
  conflicts: string[];
  initScript?: { command: string; args: string[]; timeoutMs: number };
}
export interface ProjectRef { id: string; templateId: string; workspace: string; createdAt: string }
```

Export via `packages/core/src/index.ts`.

- [ ] **Step 2: Write the failing loader/validation test**

```ts
test("loads valid templates and isolates invalid ones", async () => {
  const dir = await tempTemplates();
  await write("notes.json", JSON.stringify(valid));
  await write("bad.json", "{");
  const result = await loadTemplates(dir);
  expect(result.templates.map((t) => t.info.id)).toEqual(["notes"]);
  expect(result.issues).toEqual([{ id: "bad", code: "template.invalid" }]);
});
```

Add cases: id mismatch with filename; unknown top-level/file/initScript/config keys; missing name; duplicate `directories`/`files` paths; absolute path; `..`; NUL; trailing slash; file path equal to a directory path or nested under a file path; non-absolute `initScript.command`; non-string args; `timeoutMs` non-integer/0/600001; valid `timeoutMs` default 60000 and explicit; `systemPromptFile` not declared in `files`; template > 1 MiB; directory missing (no throw, empty result); unreadable file → issue.

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/templates-schema.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement loading and validation**

`loadTemplates`: readdir `configDir` (missing → `{ templates: [], issues: [] }`), consider only files ending `.json`, `stat` for size, read UTF-8, `parseTemplate`; any failure becomes `TemplateIssue { id: <stem>, code: "template.invalid" }` and is omitted. Sort templates by `info.id`. `parseTemplate`: strict key sets (`id,name,description,directories,files,initScript,config`; file entries `path,content`; script `command,args,timeoutMs`; config `provider,model,extensions,systemPromptFile`), filename/id equality, path rules per spec, `systemPromptFile ∈ files[].path`, default `timeoutMs`.

- [ ] **Step 5: Gate and commit**

```bash
git add packages/core/src/templates/types.ts packages/core/src/index.ts packages/daemon/src/templates/schema.ts packages/daemon/test/templates-schema.test.ts
git commit -m "feat(templates): validate declarative template files"
```

---

### Task 2: `TemplateStore` preview/apply and project records

**Files:**
- Create: `packages/daemon/src/templates/projects.ts`
- Create: `packages/daemon/src/templates/store.ts`
- Test: `packages/daemon/test/templates-store.test.ts`

**Interfaces:**
- Consumes: Task 1 loader; `WorkspaceAccess`, `Exec` from `@pisces/core`.
- Produces: `createTemplateStore(options: TemplateStoreOptions): TemplateStore`; `TemplateStore.resolve(templateId, workspace): Promise<TemplatePlan>` (read-only); `TemplateStore.apply(...): Promise<TemplateResolution>`; `readProjects(dataDir): Promise<ProjectRef[]>`; `appendProject(dataDir, ref): Promise<void>`; `TemplateDefaults { provider?; model?; extensions?; systemPrompt? }`; `TemplatePlan { preview; defaults: TemplateDefaults }`; `TemplateResolution extends TemplatePlan { projectId }`.

- [ ] **Step 1: Write the failing store tests** with real temp dirs, a real `createWorkspaceAccess`, and a fake `Exec`:
  - `preview` lists directories/files and detects existing files as conflicts without writing; a template with escaping paths is rejected at load, so preview by id → `template.not_found`.
  - `resolve` returns the same preview/defaults without writing, reads `systemPromptFile` through `WorkspaceAccess`; unknown id → `template.not_found`; missing prompt file → `template.invalid`; no files created.
  - `preview` on a workspace containing one conflicting file returns it, and no file mtime changes.
  - `apply` without conflicts writes directories/files in order, creates no session, and appends exactly one `ProjectRef` with a UTC timestamp.
  - `apply` with conflicts and no `overwrite` → `template.workspace_conflict`, zero writes, no project record.
  - `apply` with `overwrite: true` replaces the conflicting file.
  - `apply` with `initScript` passes `cwd`, `timeoutMs` from the template, and `args` unchanged; non-zero exit → `template.init_failed`, files remain, no `ProjectRef`.
  - `apply` reads `systemPromptFile` after writing and returns its content in `defaults.systemPrompt`.
  - `appendProject` twice yields two entries; corrupt `projects.json` → `storage.corrupt` and no rewrite; write uses tmp+rename (`0600`).

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/templates-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `projects.ts`**

`readProjects`: missing file → `[]`; malformed JSON/wrong shape → `PiscesError("storage.corrupt", "Project records are corrupt")`; `appendProject`: mkdir dataDir with `0700`, write `${projects.json}.${pid}.tmp` then `rename`, mode `0600`, reject symlinked target. Serialize read+append per resolved dataDir through a module-level promise chain so concurrent applies cannot lose records (test with two concurrent `appendProject` calls).

- [ ] **Step 4: Implement `store.ts`**

```ts
export interface TemplateStoreOptions {
  configDir: string;
  dataDir: string;
  workspaceAccess: (workspace: string) => WorkspaceAccess;
  exec: Exec;
  now?: () => string;
  newProjectId?: () => string;
}
```

`list` reloads and maps to `TemplateInfo`. `resolve` loads, finds id or throws `template.not_found`, resolves every path via `workspaceAccess(workspace)`, computes conflicts, reads `systemPromptFile` (missing → `template.invalid`), and returns `{ preview, defaults }` **without writing and without generating a project id**. `apply` calls the same resolution path, rejects conflicts, writes directories then files, runs `initScript` via `exec.run` with `{ cwd, timeoutMs }`, re-reads the prompt if needed, appends the project record, and returns `TemplateResolution` with the generated `projectId`. Map `workspace.path_outside` to `template.invalid` (fixed text); do not leak resolver messages.

- [ ] **Step 5: Gate and commit**

```bash
git add packages/daemon/src/templates/projects.ts packages/daemon/src/templates/store.ts packages/daemon/test/templates-store.test.ts
git commit -m "feat(templates): preview, apply and record projects"
```

---

### Task 3: Gateway routes, `session.create` template defaults, host wiring

**Files:**
- Modify: `packages/daemon/src/gateway/protocol.ts`
- Modify: `packages/daemon/src/templates/store.ts` (add read-only `inspect`)
- Modify: `packages/daemon/src/gateway/gateway.ts`
- Modify: `packages/daemon/src/host/daemon-host.ts`
- Test: `packages/daemon/test/templates-gateway.test.ts`

**Interfaces:**
- Consumes: `TemplateStore` (Task 2).
- Produces: `TemplateStore.inspect(templateId, workspace): Promise<TemplatePlan>` (preview + config defaults, **never reads the prompt file**; used for pre-write validation); `GatewayDeps.templates?: Pick<TemplateStore, "list" | "preview" | "inspect" | "resolve" | "apply">`; `template.list|preview|apply` methods; `StartDaemonOptions.templates?: { configDir: string }`.

- [ ] **Step 1: Write the failing Gateway tests** (in-memory gateway harness or the existing socket harness):
  - No store → `template.list/preview/apply` return `protocol.unknown_method`.
  - With a fake store: `list` → `{ templates }`; `preview` requires string `templateId`/`workspace`, returns preview; `apply` without `confirmed: true` → `protocol.invalid_request` and store not called.
  - `session.create {templateId}` with a fake store whose `resolve` returns `{provider, model}` creates a session whose meta uses those values and enqueues the template prompt as `role: "system"` when the caller gives no `systemPrompt`; explicit `systemPrompt` suppresses the template prompt; unknown template → `template.not_found`; no store → `protocol.invalid_request`.
  - `apply` validates session config before store.apply: missing provider/model with no defaults → `session.model_required` and fake store's apply not called; unknown model → `session.invalid_model`; invalid workspace → `session.invalid_workspace`.
  - On successful fake `apply`, the returned `sessionId` reads back over `session.read` and the store's defaults were applied.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm exec vitest run packages/daemon/test/templates-gateway.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Gateway integration**

Add `inspect` to `store.ts`: same resolution/conflict/workspace path as `resolve`, but returns `preview` and `defaults` without `systemPrompt` and without touching `systemPromptFile`. Test: works when the prompt file does not exist yet; still no writes/no project record.

Add the types to `protocol.ts` (`TemplateListResult`, `TemplatePreviewParams`, `TemplateApplyParams`, `TemplateApplyResult`). Add the three handlers next to the other gateway methods with strict param checks. Extract a `createSessionFrom` helper used by both `session.create` and `template.apply`; keep the configured/manual branches intact and their validation ordering. For `session.create {templateId}`: call `store.resolve(templateId, workspace)` first, merge defaults under explicit params, and enqueue the template prompt only when no explicit `systemPrompt`. For `apply`: call `store.inspect` first (no writes, no prompt read), merge template defaults with `deps.defaults`, validate workspace/provider/model/extensions via the same path the create uses, then `store.apply` (which re-reads the prompt after writing); create the session from the apply resolution's `defaults` (do not re-resolve on the now-changed workspace). Map store errors through unchanged (`PiscesError` code preserved).

- [ ] **Step 4: Wire `startDaemon`**

`StartDaemonOptions.templates?: { configDir: string }`; after lock acquisition and before listening, construct `createTemplateStore({ configDir, dataDir, workspaceAccess: createWorkspaceAccess, exec: createExecHost(), now })` once and pass to `GatewayDeps.templates` through `bootstrapGateway`. Coexists with `extensions`; missing/unreadable template dir yields an empty list, not a startup failure.

- [ ] **Step 5: Gate and commit**

```bash
git add packages/daemon/src/gateway/protocol.ts packages/daemon/src/gateway/gateway.ts packages/daemon/src/host/daemon-host.ts packages/daemon/test/templates-gateway.test.ts
git commit -m "feat(templates): route template methods and session defaults"
```

---

### Task 4: CLI client and `templates` commands

**Files:**
- Create: `packages/cli/src/client.ts`
- Create: `packages/cli/src/templates.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/daemon-child.ts`
- Modify: `packages/cli/src/commands.ts` (pass templates dir to the child)
- Test: `packages/cli/test/client.test.ts`
- Test: `packages/cli/test/templates-command.test.ts`
- Test: `packages/cli/test/config.test.ts` (templatesDir cases)

**Interfaces:**
- Consumes: Tasks 2–3; `PROTOCOL_VERSION`, `encodeFrame`/NDJSON from `@pisces/protocol`.
- Produces: `connectClient(socketPath, timeoutMs?): Promise<Client>` with `request(method, params)` and `close()`; `templatesList/Preview/Apply` command functions; `CliConfig.templatesDir?: string`.

- [ ] **Step 1: Write failing client tests**

Fake `node:net` server that speaks NDJSON: handshake `protocol.hello` must happen first; `request` resolves matching `id`, rejects on `error`, times out at the per-request budget (default 5 s; `templates apply` passes 660 s), rejects on close; two concurrent requests on one client resolve independently; oversized/invalid line rejects safely without a raw stack. Assert the client sends `{id, method, params}` and closes on `close()`.

- [ ] **Step 2: Write failing command tests** with an injected client factory:
  - `templates list` prints ids/names and `--json` outputs `{templates}`.
  - `templates preview <id> --workspace <dir>` prints directories, files, conflicts, and `initScript` with `timeoutMs`; `--json` matches.
  - `templates apply <id> --workspace <dir>` without `--confirm` → exit 2 and no request.
  - successful apply prints `project <id> session <id>`; protocol `error.code` is printed unchanged and exit 1.
  - daemon unreachable (connect rejects) → `daemon.unreachable`, exit 1.
  - config `templatesDir` must be absolute; `start` forwards it to the child as an additional argv element and the child builds `templates: {configDir}`.

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm exec vitest run packages/cli/test/client.test.ts packages/cli/test/templates-command.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the client and commands**

`client.ts`: net connect, `hello` first (single request id), line-buffered JSON parse, per-id waiters, per-request timeout (default 5 s, caller override), `close()` destroys; map socket/parse failures to a `ClientError` with a fixed message (no raw error). `templates apply` passes 660 s (script cap + I/O); other commands stay at 5 s. `templates.ts`: parse `list`, `preview <id>`, `apply <id>` with `--workspace`, `--confirm`, `--overwrite`, `--json`; usage errors 2; call the daemon at `socketPathFor(dataDir)`; no secret output. `config.ts`: optional absolute `templatesDir`. `commands.ts`/`daemon-child.ts`: forward `templatesDir` as the fourth child argv when present; child passes `templates: {configDir}` to `startDaemon`.

- [ ] **Step 5: Gate and commit**

```bash
git add packages/cli/src/client.ts packages/cli/src/templates.ts packages/cli/src/main.ts packages/cli/src/config.ts packages/cli/src/daemon-child.ts packages/cli/src/commands.ts packages/cli/test/client.test.ts packages/cli/test/templates-command.test.ts packages/cli/test/config.test.ts
git commit -m "feat(cli): add template commands over the protocol"
```

---

### Task 5: Real-socket acceptance, docs and final gate

**Files:**
- Create: `packages/daemon/test/templates-socket.test.ts`
- Create: `docs/templates.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md` (§5.5, §6.9 status)
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` (§3.7.2, §5.8.1, §6.6, error table if needed)

**Interfaces:**
- Consumes: everything above; real `startDaemon({templates})`.

- [ ] **Step 1: Write the failing/acceptance socket test**

Start a daemon with a temp templates dir and a real workspace; register a provider/model. Cases:
- `preview` returns directories/files/conflicts/`initScript.timeoutMs` and the workspace is byte-identical afterwards.
- `apply` without `confirmed` → `protocol.invalid_request` and no files.
- `apply` with an existing conflicting file and no `overwrite` → `template.workspace_conflict`, no changes.
- `apply` with `confirmed` creates files, runs a real script (absolute path to a small executable script created by the test) that writes a marker, appends one `projects.json` record, returns `{projectId, sessionId}`; `session.read` shows the template prompt queued; no persisted session until `turn.start` (check store files).
- Script exits non-zero → `template.init_failed`, marker of later file absent, no `ProjectRef`, no session.
- Unknown template → `template.not_found`.
- `session.create {templateId}` uses template provider/model and does not create files.
- CLI acceptance: run the built CLI `templates list/preview/apply` against this daemon; apply without `--confirm` → 2; apply with `--confirm` prints project/session; daemon down → 1 with `daemon.unreachable`.

- [ ] **Step 2: Run it**

Prerequisites: `node packages/daemon/native/build.mjs`, `pnpm exec tsc -b tsconfig.build.json`. Run: `pnpm exec vitest run packages/daemon/test/templates-socket.test.ts`.
Expected: PASS; fix product defects, not assertions.

- [ ] **Step 3: Docs**

`docs/templates.md`: template format with full example, path/script/timeout rules, preview/apply flow, conflict/overwrite, `projects.json`, error codes, CLI examples, limitations (no rollback, scripts run as daemon user, apply can delay stop, CLI-started daemons cannot select extensions). HLD/DDS: mark `template.*` implemented with the shipped shape (`{templates}`, `TemplateResolution` store boundary), note `session.create {templateId}` behavior, and remove "目标设计/尚未路由" wording only where it is now false.

- [ ] **Step 4: Final gate and commit**

Full gate G; record actual counts, Node/platform; remote CI unrun.

```bash
git add packages/daemon/test/templates-socket.test.ts docs/templates.md "docs/1 High-Level Design/1 High-Level Design.md" "docs/2 Detailed Design Specification/2 Detailed Design Specification.md"
git commit -m "feat(templates): verify the template flow and document it"
```

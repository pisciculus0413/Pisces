# CLI Daemon Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `pisces` CLI whose `start` / `status` / `stop` commands manage a real background daemon configured from one JSON file and an environment-variable API key.

**Architecture:** A new `@pisces/cli` package parses and validates the config, then supervises a detached child process that assembles `ProviderManagement` / `Credentials` / `ProviderHost` and calls the existing `startDaemon`. The parent owns the pid file, log, readiness probe and signals; the daemon code is untouched.

**Tech Stack:** TypeScript ESM, Node >=22.19, pnpm workspace, Vitest, `node:child_process`, `node:net`, `@pisces/protocol` framing.

**Spec:** `docs/superpowers/specs/2026-11-09-cli-daemon-lifecycle-design.md`

## Global Constraints

- Branch `dev-pi`; no worktree, no commit to `main`, no push/merge.
- Linux only. The daemon rejects other platforms; the CLI must not claim macOS support.
- New package `packages/cli` (`@pisces/cli`, `private`, `type: module`), depends on `@pisces/core`, `@pisces/daemon`, `@pisces/protocol`; `bin: { "pisces": "dist/main.js" }`; build via its own `tsconfig.build.json` referenced from the root build.
- Gate G before every commit (from repo root): `node packages/daemon/native/build.mjs`; `pnpm exec tsc -b tsconfig.build.json`; `pnpm exec vitest run`; `pnpm exec tsc -p tsconfig.json`; `pnpm exec tsc -b tsconfig.build.json`; `pnpm exec biome check .`; `rg -n 'from "(node:)?(fs|http|https|net|tls|dgram|dns)|from "@pisces/(daemon|protocol)"' packages/core/src` (expect exit 1); `rg -n 'from "@pisces/(daemon|core)"' packages/protocol/src` (expect exit 1); `git diff --check`; `git status --short`.
- Stage explicit paths only; never `git add .`/`-A`. Subagents use `model="deepseek-flash"`; no nested agents.
- Exact values: dataDir default `$XDG_STATE_HOME/pisces` else `~/.local/state/pisces`; config default `$XDG_CONFIG_HOME/pisces/config.json` else `~/.config/pisces/config.json`; readiness poll `50 ms`, start timeout `10_000 ms`, stop timeout `10_000 ms`; pid file and log inside `<dataDir>`; pid file mode `0600`; dataDir mode `0700`.
- Exit codes: `0` success, `1` runtime failure, `2` usage/config error.
- Fixed user-visible codes/messages: `config.invalid` (`Invalid configuration`), `daemon.already_running` (`A daemon is already running`), `daemon.unknown_owner` (`A process owns the runtime but did not answer; check manually`), `daemon.start_failed` (`Daemon could not start; see the log`), `daemon.stop_timeout` (`Daemon did not stop in time`), `daemon.insecure_directory` (`Data directory is not private`). Never print a key, a config value or a raw error message.
- The key is read only from the environment variable named by `apiKeyEnv`; it never appears in argv, config, pid file, log or JSON output.

## Review Focus

1. PID reuse and ownership: `stop` must never signal a process unless the same pid is alive and this dataDir's socket completes a protocol handshake; stale or unresponsive pid files must not be deleted while the process lives.
2. Concurrent `start`: two invocations on one dataDir must not both succeed, and neither may overwrite the other's pid file; the loser must not leave an orphan child.
3. Key leakage: argv, pid file, log file, stderr messages and `status --json` must contain no key material; the child inherits only `process.env`.
4. Bad dataDir/log access: an insecure or uncreatable dataDir must fail fast with a fixed message, not after a 10 s wait or with a partial pid file.
5. Half-started daemon: if the child exits or the pid changes during the readiness window, `start` must clean its own pid file, terminate its child, and exit 1 — never report `running` for someone else's daemon.

---

### Task 1: CLI package scaffold and configuration

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.build.json`
- Create: `packages/cli/src/config.ts`
- Modify: `tsconfig.build.json` (add reference)
- Modify: `tsconfig.json` (add `@pisces/cli` path)
- Test: `packages/cli/test/config.test.ts`

**Interfaces:**
- Produces: `CliConfig`, `CliProviderConfig`, `CliModelConfig`, `loadConfig(path: string): Promise<CliConfig>` and `parseConfig(value: unknown): CliConfig`; `defaultConfigPath(env)`, `defaultDataDir(env)`; `config.invalid` errors via `PiscesError`.

- [ ] **Step 1: Create the package manifest and build config**

`packages/cli/package.json`: name `@pisces/cli`, `private: true`, `type: "module"`, exports `"."` → `./dist/index.js`, `bin: { "pisces": "dist/main.js" }`, `scripts.build`/`clean` like the daemon package, dependencies `@pisces/core`, `@pisces/daemon`, `@pisces/protocol` (`workspace:*`). `packages/cli/tsconfig.build.json` mirrors `packages/daemon/tsconfig.build.json` with `references` to core, daemon and protocol. Add `{ "path": "packages/cli/tsconfig.build.json" }` to root `tsconfig.build.json`, and `"@pisces/cli": ["./packages/cli/src/index.ts"]` plus include coverage to root `tsconfig.json`. Create `packages/cli/src/index.ts` re-exporting `./config.js`.

- [ ] **Step 2: Write the failing config test**

```ts
test("accepts a valid config and rejects unknown keys and unresolved defaults", () => {
  const valid = parseConfig({ dataDir: "/tmp/pisces", providers: [provider()], defaults: { provider: "openai", model: "m" } });
  expect(valid.providers[0]?.id).toBe("openai");
  expect(() => parseConfig({ ...raw(), extra: true })).toThrowError(PiscesError);
  expect(() => parseConfig({ ...raw(), defaults: { provider: "openai", model: "missing" } })).toThrowError(/Invalid configuration/);
});
```

Add cases: missing provider id/baseUrl/models; duplicate provider ids; duplicate model ids; model without `contextWindow`/`maxOutput`/`modalities`; `apiKeyEnv` not matching `^[A-Za-z_][A-Za-z0-9_]*$`; `baseUrl` with credentials/query/hash or non-http; relative `dataDir`; `defaults` omitted (allowed); unknown top-level, provider and model keys.

- [ ] **Step 3: Run it to confirm failure**

Run: `pnpm exec vitest run packages/cli/test/config.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement config parsing**

```ts
export interface CliModelConfig { id: string; contextWindow: number; maxOutput: number; modalities: ("text" | "image" | "audio")[] }
export interface CliProviderConfig { id: string; baseUrl: string; apiKeyEnv: string; headers?: Record<string, string>; models: CliModelConfig[]; }
export interface CliConfig { dataDir: string; providers: CliProviderConfig[]; defaults?: { provider: string; model: string } }
export function parseConfig(value: unknown): CliConfig;
export async function loadConfig(path: string): Promise<CliConfig>;
export function defaultConfigPath(env: NodeJS.ProcessEnv): string;
export function defaultDataDir(env: NodeJS.ProcessEnv): string;
```

Strict key sets at every level; every failure throws `new PiscesError("config.invalid", "Invalid configuration")`; `loadConfig` maps read/JSON errors to the same fixed error. Resolve `dataDir`/`~`-expansion only via `env`, never `process.env` inside pure functions. `defaultDataDir`/`defaultConfigPath` take `env` explicitly.

- [ ] **Step 5: Run test and gate**

Run: `pnpm exec vitest run packages/cli/test/config.test.ts`, then full gate G, then:

```bash
git add packages/cli/package.json packages/cli/tsconfig.build.json packages/cli/src/index.ts packages/cli/src/config.ts packages/cli/test/config.test.ts tsconfig.build.json tsconfig.json pnpm-lock.yaml
git commit -m "feat(cli): add package scaffold and strict configuration"
```

---

### Task 2: Credentials and daemon child assembly

**Files:**
- Create: `packages/cli/src/credentials.ts`
- Create: `packages/cli/src/assembly.ts`
- Create: `packages/cli/src/daemon-child.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Consumes: `CliConfig` (Task 1).
- Produces: `createEnvCredentials(config: CliConfig, env: NodeJS.ProcessEnv): Credentials`; `buildProviders(config: CliConfig): ProviderManagement`; `buildDaemonOptions(config: CliConfig, dataDir: string, env: NodeJS.ProcessEnv): StartDaemonOptions`; `daemonChildMain(argv: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing assembly test**

```ts
test("registers openai-chat providers and reads only the named env var", async () => {
  const options = buildDaemonOptions(config(), "/tmp/pisces", { OPENAI_API_KEY: "sk-test" });
  const descriptor = options.providers.get("openai");
  expect(descriptor).toMatchObject({ dialect: "openai-chat", auth: { type: "apiKey", credentialRef: "openai" } });
  expect(options.providers.list()).toHaveLength(1);
  expect(options.providerHost).toBeDefined();
  const credentials = createEnvCredentials(config(), { OPENAI_API_KEY: "sk-test" });
  expect((await credentials.get("openai"))?.value).toBe("sk-test");
  expect(await credentials.get("other")).toBeUndefined();
});
```

Also assert: dialect registration allows `providers.createAdapter("openai")` to return an adapter whose `dialect` is `openai-chat`; a missing env var yields `get() === undefined` and `refresh()` rejects; `dataDir` override wins over `config.dataDir`; `defaults` is forwarded unchanged; the returned object has no extra keys beyond what `StartDaemonOptions` allows. Provide a small test helper to reach the credentials object (export `createEnvCredentials` and build it separately rather than digging into options).

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/cli/test/assembly.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement credentials and assembly**

`createEnvCredentials`: `get(ref)` looks up the provider whose `id === ref`, returns `{ type: "apiKey", value }` from `env[apiKeyEnv]` when non-empty, else `undefined`; `refresh(ref)` throws `new PiscesError("provider.credentials_unavailable", "Credentials could not be refreshed")` (check whether that code already exists; if not, use the closest existing provider error code and note it in the report). `buildProviders`: `createProviderManagement()`, `registerDialect("openai-chat", openAiChatAdapterFactory)`, then register each provider with `auth: { type: "apiKey", credentialRef: provider.id }`, copying `headers` only when present. `buildDaemonOptions`: `{ dataDir: override, providers, providerHost: createProviderHost({ providers, credentials }), ...(defaults ? { defaults } : {}) }`.

`daemon-child.ts`: `daemonChildMain([configPath, dataDir])` loads config, builds options, `const host = await startDaemon(options)`, logs `running <socketPath>` to stdout (captured by the log file), installs `SIGTERM`/`SIGINT` handlers that call `host.stop()` and exit 0 (exit 1 on failure), and keeps the process alive. On startup failure, write one line `error: <code>` using only the `PiscesError.code` (fallback `daemon.start_failed`), then `process.exitCode = 1`. Guard `argv.length` and exit `2` on misuse.

- [ ] **Step 4: Run tests and gate**

Run: `pnpm exec vitest run packages/cli/test/assembly.test.ts`, then gate G, then:

```bash
git add packages/cli/src/credentials.ts packages/cli/src/assembly.ts packages/cli/src/daemon-child.ts packages/cli/src/index.ts packages/cli/test/assembly.test.ts
git commit -m "feat(cli): assemble providers and the daemon child entry"
```

---

### Task 3: Filesystem, pid and socket lifecycle primitives

**Files:**
- Create: `packages/cli/src/lifecycle.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/lifecycle.test.ts`

**Interfaces:**
- Produces: `socketPathFor(dataDir: string): string`; `ensureDataDir(dataDir: string): Promise<void>`; `PidRecord { pid: number; socketPath: string; startedAt: string }`; `readPidRecord(dataDir): Promise<PidRecord | undefined>`; `createPidRecord(dataDir, record): Promise<boolean>` (`false` on EEXIST); `removePidRecord(dataDir, pid: number): Promise<void>`; `isProcessAlive(pid: number): boolean`; `probeDaemon(socketPath: string, timeoutMs = 500): Promise<boolean>`; `waitForExit(pid, timeoutMs): Promise<boolean>`.

- [ ] **Step 1: Write the failing primitive tests**

Use real temp dirs plus `node:net` fake servers:

```ts
test("creates the pid record exclusively and removes it only for the recorded pid", async () => {
  const dir = await tempDir();
  expect(await createPidRecord(dir, { pid: 123, socketPath: join(dir, "run", "pisces.sock"), startedAt: "2026-11-09T00:00:00.000Z" })).toBe(true);
  expect(await createPidRecord(dir, { pid: 999, socketPath: join(dir, "run", "pisces.sock"), startedAt: "x" })).toBe(false);
  await removePidRecord(dir, 999);
  expect((await readPidRecord(dir))?.pid).toBe(123);
  await removePidRecord(dir, 123);
  expect(await readPidRecord(dir)).toBeUndefined();
});

test("probe succeeds only on a compatible hello", async () => {
  const socketPath = join(await tempDir(), "s.sock");
  const server = createServer((socket) => {
    socket.once("data", () => socket.write(`${JSON.stringify({ id: "h", result: { version: PROTOCOL_VERSION, compatible: true } })}\n`));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  expect(await probeDaemon(socketPath)).toBe(true);
  server.close();
  expect(await probeDaemon(socketPath)).toBe(false);
});
```

Also cover: `ensureDataDir` creates `0700` and rejects a group/world-writable or symlinked dir with `daemon.insecure_directory`; `readPidRecord` returns undefined on missing/malformed files; `removePidRecord` keeps a record whose pid differs; `socketPathFor` returns `<dataDir>/run/pisces.sock`; `isProcessAlive` true for `process.pid`, false for a reaped child; `waitForExit` returns promptly for a dead pid.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/cli/test/lifecycle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the primitives**

Use `node:fs/promises` (`mkdir`, `open`, `readFile`, `unlink`, `rename` not needed), `node:net`. Pid file name `daemon.pid`, JSON, written with `open(path, "wx", 0o600)` then `writeFile`/`close`; malformed or unreadable contents count as absent (and are removable by an explicit `removePidRecord`). `ensureDataDir` mirrors the daemon's checks: `mkdir(..., { recursive: true, mode: 0o700 })`, then `lstat`: must be a directory, not a symlink, owned by `process.geteuid()`, no group/world write; otherwise `PiscesError("daemon.insecure_directory", ...)`. `probeDaemon` connects, sends `{ id:"cli-probe", method:"protocol.hello", params:{ versions:[PROTOCOL_VERSION] } }` with `\n`, resolves `true` only when the parsed `result.compatible === true`, resolves `false` on timeout/error/close; always destroys the socket and clears the timer.

- [ ] **Step 4: Run tests and gate**

Run: `pnpm exec vitest run packages/cli/test/lifecycle.test.ts`, then gate G, then:

```bash
git add packages/cli/src/lifecycle.ts packages/cli/src/index.ts packages/cli/test/lifecycle.test.ts
git commit -m "feat(cli): add pid, data directory and handshake primitives"
```

---

### Task 4: `start` / `status` / `stop` commands and argv dispatch

**Files:**
- Create: `packages/cli/src/commands.ts`
- Create: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/commands.test.ts`
- Test: `packages/cli/test/main.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `type CommandDeps` (spawn, probe, isAlive, waitForExit, sleep, openLog, now); `startCommand(options, deps): Promise<number>`; `statusCommand(options, deps): Promise<number>`; `stopCommand(options, deps): Promise<number>`; `runCli(argv: string[], io): Promise<number>` from `main.ts`.

- [ ] **Step 1: Write the failing command tests with injected seams**

Cover, with fake `spawn` (returns `{ pid: 4242 }`), fake `probe`, fake `isAlive`/`waitForExit`, and a real temp dataDir:
- `start` with a successful probe: writes pid record with `child.pid`, returns 0, prints `running`.
- `start` when the socket already answers: returns 1 with `daemon.already_running`, never spawns.
- `start` when the pid is alive but the probe fails: returns 1 `daemon.unknown_owner`, never spawns, keeps the pid file.
- `start` when the child exits during readiness (fake `isAlive` false or `exitCode` set): kills the child, removes its pid record, returns 1 `daemon.start_failed`.
- `start` when `createPidRecord` loses the race: kills the child, returns 1 `daemon.already_running`, leaves the existing record intact.
- `status`: stopped/stale/running/unresponsive → exit 1/1/0/1 and correct one-line output; `--json` shape contains no key.
- `stop`: no record and no answering socket → 0; no record but the socket answers → 1 with `unmanaged daemon` and no signal; stale record → 0 and removed; alive+probe → `SIGTERM`, waits, removes record, 0; alive+no probe → 1 `daemon.unknown_owner`, record kept; timeout → 1 `daemon.stop_timeout`, record kept.
- `runCli`: unknown flag/missing value → 2; `--help`/`--version` → 0; `--data-dir` override reaches both `start` (spawn second argv) and the pid record.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm exec vitest run packages/cli/test/commands.test.ts packages/cli/test/main.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the commands**

`start`: load config, resolve dataDir (`--data-dir` wins), validate key env (`env[provider.apiKeyEnv]` non-empty for every provider; fixed message), `ensureDataDir`, open log (`"a"`, `0o600`), probe first (already running / stale cleanup / unknown owner), spawn detached with `[childEntry, configPath, dataDir]` (`childEntry` from `import.meta.url` → `daemon-child.js`), write pid record exclusively, then poll every 50 ms up to 10 s checking child exit + pid record pid + probe; on success print `running (pid N, socket S)`; on failure kill child with `SIGTERM` (ignore errors), remove own record, print log path. `status`: read record, `isProcessAlive`, probe; `--json` prints `{ state, pid?, socketPath?, dataDir }`. `stop`: read record; missing → `not running` 0; pid dead → remove, 0; pid alive + probe → `SIGTERM`, `waitForExit(10_000)`, remove, 0; alive + no probe → 1 unknown owner; timeout → 1, keep record.

`main.ts`: shebang, parse `start|status|stop` with `--config <path>`, `--data-dir <path>`, `status --json`, `--help`, `--version`; unknown command/flag or missing value exit 2 with usage. `runCli` returns the code; the module calls `process.exitCode = await runCli(process.argv.slice(2), io)` only when executed as the entry (compare `import.meta.url` with `process.argv[1]` resolved via `pathToFileURL`).

- [ ] **Step 4: Run tests and gate**

Run: `pnpm exec vitest run packages/cli/test/commands.test.ts packages/cli/test/main.test.ts`, then gate G, then:

```bash
git add packages/cli/src/commands.ts packages/cli/src/main.ts packages/cli/src/index.ts packages/cli/test/commands.test.ts packages/cli/test/main.test.ts
git commit -m "feat(cli): add start, status and stop commands"
```

---

### Task 5: Real-process acceptance, docs and final gate

**Files:**
- Create: `packages/cli/test/cli-lifecycle.test.ts`
- Create: `docs/cli.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` (§7.1, §7.2 note, §7.5/§8.6 as needed)
- Modify: `docs/1 High-Level Design/1 High-Level Design.md` (CLI status lines)

**Interfaces:**
- Consumes: everything above; the built `packages/cli/dist/main.js`.
- Produces: end-to-end evidence and user documentation.

- [ ] **Step 1: Write the real-process acceptance test**

Requires `pnpm exec tsc -b tsconfig.build.json` first (the test spawns `node packages/cli/dist/main.js`). Use a temp root; write `config.json` with `dataDir` under the root, one provider `{ id:"fake", baseUrl:"http://127.0.0.1:9/v1", apiKeyEnv:"PISCES_TEST_KEY", models:[{id:"m", contextWindow:1000, maxOutput:100, modalities:["text"]}] }`, and run the CLI with `PISCES_TEST_KEY=not-a-real-key` in the environment. Cases:
- `start` exits 0, output contains `running`, pid record exists with the child pid, socket answers `probeDaemon`.
- second `start` exits 1 with `daemon.already_running`.
- `status` exits 0 and `status --json` parses to `{ state: "running" }`.
- log file exists and does not contain the key value.
- `stop` exits 0, pid record is gone, socket no longer probes, and the child process is not alive.
- second `stop` exits 0.
- stale pid file (hand-written dead pid) is cleaned by `status`/`stop`.
- a hand-written pid record whose pid is `process.pid` (alive) while the socket is dead → `stop` exits 1 with `daemon.unknown_owner` and leaves the file.
- two concurrent `start` invocations: exactly one exits 0 and the other exits 1; only one pid record remains; the successful one's daemon answers.

Keep each child bounded (kill leftovers in `afterEach` using the pid record and `SIGKILL` as a test-only fallback); test timeout 30 s.

- [ ] **Step 2: Run it**

Run: `pnpm exec tsc -b tsconfig.build.json && pnpm exec vitest run packages/cli/test/cli-lifecycle.test.ts`
Expected: PASS (acceptance test; if it fails, fix the implementation, not the assertions).

- [ ] **Step 3: Write `docs/cli.md`**

Sections: install/build, config file with an OpenAI-compatible example, the `OPENAI_API_KEY` environment flow, `start`/`status`/`stop` examples with real output, exit codes, file locations (`dataDir`, pid, log), recovery for `daemon.unknown_owner` and stale pid files, Linux-only statement, what is not implemented (`run`, `sessions`, `providers check`, `config`, `auth`, `extensions`, templates), and the no-sandbox/key-trust caveats.

- [ ] **Step 4: Sync HLD/DDS**

HLD: CLI exists with `start`/`status`/`stop` over local process and protocol probe; management commands still out of scope. DDS §7.1: mark the locally implemented subset; §7.2: note `run` remains unimplemented; §7.5: record the CLI's pid/log/exit-code conventions and the `daemon.unknown_owner` recovery. Do not claim `run`, `sessions`, config/auth commands, or macOS support.

- [ ] **Step 5: Final gate and commit**

Run full gate G (including the dist build before the acceptance test), record actual counts and Node/platform, then:

```bash
git add packages/cli/test/cli-lifecycle.test.ts docs/cli.md "docs/1 High-Level Design/1 High-Level Design.md" "docs/2 Detailed Design Specification/2 Detailed Design Specification.md"
git commit -m "feat(cli): verify the daemon lifecycle and document the CLI"
```

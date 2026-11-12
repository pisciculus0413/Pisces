# ClientRegistry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让扩展清单的 `pisces.clients` 真正登记为客户端，并把 `client.list` / `client.start` 两个协议方法与 `pisces client list|start` 两个 CLI 子命令接通。

**Architecture:** 清单解析层新增 `discoverClients`（只读 `package.json`，不加载代码），服务层新增 `ClientRegistry`（每次调用重新发现，启动子进程后 `unref`，不跟踪不回收）；`Gateway` 按 `templates` 的既有模式把 registry 作为可选依赖注入并路由两个方法；`startDaemon` 用 `options.extensions` 的目录推出客户端源构造 registry，因此命令行启动的 daemon 永远装配。

**Tech Stack:** TypeScript + ESM、Node `node:child_process`、vitest、pnpm workspace（`@pisces/core` / `@pisces/protocol` / `@pisces/daemon` / cli）。

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §4.2、§5.4、§6.6、§6.7、§6.8；`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §3.3、§3.7.3、§3.9、§5.8.2、§5.9、§7.1；`docs/cli.md`。

## Global Constraints

- 运行时 Node `>=22.19.0`，ESM，只用 pnpm 工作区已有依赖；不新增 npm 依赖。
- 分层方向固定：`core` 不引用服务层；本次改动只落在 `daemon`、`cli` 与文档。
- 错误码只允许 `client.not_found`、`client.launch_failed`、`protocol.invalid_request`、`protocol.unknown_method`、`extensions.invalid`、`extensions.duplicate`（DDS §3.9、§5.8.2）。
- 固定安全文案：`client.not_found` → `Client is not registered`；`client.launch_failed` → `Client could not be started`。日志与输出不得含凭据、`apiKeyEnv`、配置值。
- 协议帧上限 8 MiB；`client.list` 结果与其他方法走同一 envelope 校验，不新增分页。
- 客户端子进程的 env 只有 `PATH`、`PISCES_SOCKET_PATH`、`PISCES_CLIENT_ID` 三个键，不继承 daemon 的 `process.env`。
- 客户端源只有内置扩展目录与 `<configDir>/extensions`；工作区扩展不贡献客户端。
- 门禁：`pnpm test`、`pnpm typecheck`、`npx tsc -b tsconfig.build.json`、`pnpm lint`（Biome）全绿才算完成。
- 不提交到 `main`；提交信息格式 `{feat,fix,docs}[(core,daemon,protocol)]: <message>`。

## Review Focus

1. `pisces.clients` 声明了 entry 但文件缺失，或 entry 写成 `../outside.mjs` 越出包目录 → 该客户端不注册，`client.start <id>` 得 `client.not_found`；daemon 绝不执行包外路径。（Task 1、Task 2 测试）
2. 两个包声明同一 `id` → 两方都不注册，`client.list` 不返回任何一方，`extensions.duplicate` 各记一条；用户不会看到“随机赢家”。（Task 1 测试）
3. `client.start` 的子进程启动失败（entry 存在但不可执行）→ 返回 `client.launch_failed`，daemon 不崩、不残留半启动状态。（Task 2 测试）
4. `client.start` 参数为 `{}`、`{id: 1}`、`{id: ""}` → `protocol.invalid_request`，且不调用 registry 的 `start`。（Task 3 测试）
5. daemon 的 API key 环境变量不出现在客户端子进程环境里；`PISCES_SOCKET_PATH` 与 `PISCES_CLIENT_ID` 必须正确。（Task 2、Task 4 测试）

---

### Task 1: 清单层 `discoverClients`

**Files:**
- Modify: `packages/daemon/src/extensions/types.ts`（新增 `ClientRegistration`）
- Modify: `packages/daemon/src/extensions/discovery.ts`（新增 `discoverClients`）
- Modify: `packages/daemon/src/index.ts`（导出）
- Test: `packages/daemon/test/extensions-clients-discovery.test.ts`

**Interfaces:**
- Consumes: `resolveConfigLocation(options)`、`listPackageRoots(dir, label)`、`parsePackageJson(text)`、`isScriptFile(name)`、`within(root, target)`、`pushIssue(issues, code, source, name?)`——全部已在 `discovery.ts` 内。
- Produces:
  ```ts
  // packages/daemon/src/extensions/types.ts
  export interface ClientRegistration {
    id: string;
    source: string; // 声明它的 package 名称
    entry: string;  // 解析后的绝对真实路径，必在包目录内
  }

  // packages/daemon/src/extensions/discovery.ts
  export interface ClientDiscoveryResult {
    clients: ClientRegistration[];
    issues: ExtensionIssue[];
  }
  export async function discoverClients(options: ExtensionsOptions): Promise<ClientDiscoveryResult>
  ```

规则（实现时照此写死，不要另加开关）：
- 源集合 = `[{ dir: options.builtinDir ?? defaultBuiltinDir(), origin: "builtin" }, { dir: join(configDir, "extensions"), origin: "config" }]`，`configDir` 取自 `resolveConfigLocation(options)`；**不读 workspace、不读配置文件内容**。
- 每个包根先 `realpath` + 去重（同 `discoverExtensions` 的 `seenRoots`），`package.json` 缺失则跳过，读取或解析失败记 `extensions.invalid`（`source = <package tag>`）。
- 每个 `manifest.clients[i]`：`logical = join(packageRoot, entry)`；`realpath` 失败、不是文件、`!within(packageRoot, canonical)`、或 `!isScriptFile(basename(logical))` → 记 `extensions.invalid`（`source = package name`）并跳过该客户端。
- `id` 全局唯一性：统计后丢弃所有重复 id，并对每个声明该 id 的包记一条 `extensions.duplicate`（`source = package name`、`name = id as EntryName`）。
- 结果按 `id` 字典序排序；空目录不存在时返回 `{ clients: [], issues: [] }`。

- [ ] **Step 1: 写失败测试** `packages/daemon/test/extensions-clients-discovery.test.ts`

用现有 `packages/daemon/test/extensions-fixtures.ts` 的临时目录风格（`mkdtemp` + root cleanup），至少五个用例：

```ts
test("reads clients from the builtin and config sources", ...)
// configDir/extensions/demo/package.json = { name: "@demo/x", pisces: { clients: [{ id: "repl", entry: "./client.mjs" }] } }
// 断言 clients === [{ id: "repl", source: "@demo/x", entry: <realpath of client.mjs> }]，issues 为空

test("skips a client whose entry is missing", ...)      // issues 含 { code: "extensions.invalid", source: "@demo/x" }，clients 为空
test("rejects an entry outside the package root", ...)  // entry: "../evil.mjs" 已存在于包外 → extensions.invalid，clients 为空
test("drops every package that reuses a client id", ...)// 两个包同 id → clients 为空，两条 extensions.duplicate
test("ignores a missing extension directory", ...)       // 只有 builtin 时（builtinDir 指向空目录）→ { clients: [], issues: [] }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/daemon/test/extensions-clients-discovery.test.ts`
Expected: FAIL，`discoverClients is not a function`（或导入失败）。

- [ ] **Step 3: 实现**

`types.ts` 加 `ClientRegistration`；`discovery.ts` 加 `discoverClients`（复用现有 helper，不复制目录遍历逻辑）并在文件末尾的 `export type { ... }` 里补 `ClientDiscoveryResult`；`index.ts` 的 `./extensions/discovery.js` 导出块补 `discoverClients`，`./extensions/types.js` 导出块补 `ClientRegistration`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/daemon/test/extensions-clients-discovery.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add packages/daemon/src/extensions/types.ts packages/daemon/src/extensions/discovery.ts packages/daemon/src/index.ts packages/daemon/test/extensions-clients-discovery.test.ts
git commit -m "feat(daemon): discover client contributions from extension manifests"
```

---

### Task 2: `ClientRegistry`

**Files:**
- Create: `packages/daemon/src/client-registry/registry.ts`
- Modify: `packages/daemon/src/index.ts`（导出 `createClientRegistry`、`ClientRegistry`、`ClientRegistryOptions`、`ClientSpawn`）
- Test: `packages/daemon/test/client-registry.test.ts`

**Interfaces:**
- Consumes: `discoverClients(options)`（Task 1）、`ExtensionsOptions`、`ClientRegistration`。
- Produces:
  ```ts
  // packages/daemon/src/client-registry/registry.ts
  export type ClientSpawn = (
    command: string,
    args: readonly string[],
    options: { stdio: ["ignore", "inherit", "inherit"]; env: NodeJS.ProcessEnv },
  ) => import("node:child_process").ChildProcess;

  export interface ClientRegistryOptions {
    /** Absent means no extension assembly: nothing can be registered. */
    extensions?: ExtensionsOptions;
    socketPath: string;
    env?: NodeJS.ProcessEnv;   // 只用来取 PATH；默认 process.env
    spawn?: ClientSpawn;       // 测试注入；默认 node:child_process 的 spawn
  }

  export interface ClientRegistry {
    list(): Promise<ClientRegistration[]>;
    start(id: string): Promise<{ pid: number }>;
  }

  export function createClientRegistry(options: ClientRegistryOptions): ClientRegistry;
  ```

行为：
- `list()` 每次都调用 `discoverClients(options.extensions)`，只返回 `clients`（issues 不外传，与 `Extensions` 的 issue 处理一致：本阶段不新增协议字段）。`options.extensions` 缺省时不扫描任何目录，`list()` 返回 `[]`，`start()` 一律 `client.not_found`。
- `start(id)` 先 `list()` 查 `id`；没有 → `new PiscesError("client.not_found", "Client is not registered")`。
- 启动：`spawn(process.execPath, [registration.entry], { stdio: ["ignore", "inherit", "inherit"], env })`，`env` 恰好是 `{ ...(PATH 存在时 { PATH }), PISCES_SOCKET_PATH: options.socketPath, PISCES_CLIENT_ID: id }`。
- `await` 一个 `child.once("spawn" | "error")` 的竞速：`error` → `new PiscesError("client.launch_failed", "Client could not be started")`；`spawn` 后 `child.unref()` 并返回 `{ pid: child.pid }`，`pid` 为 `undefined` 时同样抛 `client.launch_failed`。
- 不保存子进程引用、不监听 `exit`、不提供 stop。

- [ ] **Step 1: 写失败测试** `packages/daemon/test/client-registry.test.ts`

```ts
test("lists discovered clients", ...)                    // 用 temp configDir 写一个 clients 声明
test("rediscovers on every list call", ...)              // 第一次 list 为空，写入新包后第二次 list 返回它
test("spawns the entry with a whitelisted environment", ...)
// fake spawn 捕获 (command, args, options)；env 断言深等于
// { PATH: "/usr/bin:/bin", PISCES_SOCKET_PATH: "/tmp/x.sock", PISCES_CLIENT_ID: "repl" }
// 且不包含 options.env 里的 PISCES_TEST_KEY；command === process.execPath；args === [entry]
test("rejects an unknown client without spawning", ...)  // await expect(...).rejects.toMatchObject({ code: "client.not_found" })
test("maps a spawn failure to client.launch_failed", ...)// fake spawn 立刻 emit "error"
```

fake spawn 用一个 `EventEmitter` 子类即可：`once("spawn")` 在下一 tick `emit("spawn")`，`unref()` 空实现，`pid` 固定 4242；测试里把它 `as unknown as ChildProcess` 传给 `createClientRegistry`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/daemon/test/client-registry.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `registry.ts` 并从 `index.ts` 导出**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/daemon/test/client-registry.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add packages/daemon/src/client-registry/registry.ts packages/daemon/src/index.ts packages/daemon/test/client-registry.test.ts
git commit -m "feat(daemon): add client registry with whitelisted spawn"
```

---

### Task 3: `Gateway` 路由 `client.list` / `client.start`

**Files:**
- Modify: `packages/daemon/src/gateway/protocol.ts`（新增三个类型）
- Modify: `packages/daemon/src/gateway/gateway.ts`（`GatewayDeps.clients`、`clients()` 访问器、两个 handler）
- Modify: `packages/daemon/test/support/gateway-harness.ts`（`GatewayHarnessOptions.clients` 透传）
- Test: `packages/daemon/test/gateway-client.test.ts`

**Interfaces:**
- Consumes: `ClientRegistry`（Task 2）、`ClientRegistration`（Task 1）、既有 `invalidRequest()`。
- Produces:
  ```ts
  // gateway/protocol.ts
  export interface ClientListResult { clients: ClientRegistration[] }
  export interface ClientStartParams { id: string }
  export interface ClientStartResult { pid: number }

  // gateway/gateway.ts
  export interface GatewayDeps { /* ... */ clients?: ClientRegistry }
  ```

行为：
- 新增 `function clientRegistry(): ClientRegistry`，与 `templateStore()` 同构：`deps.clients === undefined` → `new PiscesError("protocol.unknown_method", "Unknown protocol method")`。
- `async "client.list"(): Promise<ClientListResult>` → `{ clients: await clientRegistry().list() }`。不校验会话。
- `async "client.start"(params): Promise<ClientStartResult>` → `typeof params.id !== "string" || params.id.length === 0` → `invalidRequest()`；否则 `await clientRegistry().start(params.id)`。不做 id 正则校验（id 由清单声明，注册表负责判定是否存在）。

- [ ] **Step 1: 写失败测试** `packages/daemon/test/gateway-client.test.ts`

用 `createGatewayHarness({ clients: fakeRegistry })`：

```ts
test("projects registered clients", ...)          // result 深等于 { clients: [{ id, source, entry }] }，无额外字段
test("starts a client by id", ...)                // registry.start 收到 "repl"，result { pid: 4242 }
test("rejects invalid client.start parameters", ...) // [{}, { id: 1 }, { id: "" }] → protocol.invalid_request，start 未被调用
test("keeps client methods unknown without a registry", ...) // 不注入 clients → 两个方法都 protocol.unknown_method
test("propagates registry errors", ...)           // start 抛 PiscesError("client.not_found") → Response.error 同码
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/daemon/test/gateway-client.test.ts`
Expected: FAIL，`protocol.unknown_method`（当前两个方法未路由）。

- [ ] **Step 3: 实现**

`protocol.ts` 加类型；`gateway.ts` 加 `clients?: ClientRegistry` 依赖、`clientRegistry()` 访问器（放在 `templateStore()` 旁边）与两个 handler（放在 `provider.list` 之后、`template.list` 之前）；harness 加 `clients` 选项并透传给 `bootstrapGateway`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/daemon/test/gateway-client.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add packages/daemon/src/gateway/protocol.ts packages/daemon/src/gateway/gateway.ts packages/daemon/test/support/gateway-harness.ts packages/daemon/test/gateway-client.test.ts
git commit -m "feat(daemon): route client.list and client.start"
```

---

### Task 4: `startDaemon` 装配与真实 socket 验证

**Files:**
- Modify: `packages/daemon/src/host/daemon-host.ts`（构造 registry 并传入 `bootstrapGateway`）
- Test: `packages/daemon/test/clients-socket.test.ts`

**Interfaces:**
- Consumes: `createClientRegistry({ extensions, socketPath })`（Task 2）、`paths.socketPath`（`prepareRuntimePaths` 已返回）、`options.extensions?: ExtensionsOptions`。
- Produces: 无新导出；`StartDaemonOptions` 不变。

行为：
- 在 `clearStaleSocket` 之后、`bootstrapGateway` 之前的同一段落里构造：
  ```ts
  const clientRegistry = createClientRegistry({
    ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    socketPath: paths.socketPath,
  });
  ```
  没有任何扩展源时 `client.list` 返回空数组而不是 `unknown_method`：命令行启动的 daemon 永远装配 registry（`options.extensions` 由 CLI `start` 恒定注入）。
- 通过 `bootstrapGateway({ ..., clients: clientRegistry })` 注入；registry 无生命周期，`stop()` 不变。

- [ ] **Step 1: 写失败测试** `packages/daemon/test/clients-socket.test.ts`

参考 `packages/daemon/test/templates-socket.test.ts`（同款真实 socket + 临时 dataDir + `startDaemon`，若沿用 `startDaemonWithSeams` 就用其原生 probe seam）。fixture：`<configDir>/extensions/demo/package.json` 声明 `{ clients: [{ id: "demo", entry: "./client.mjs" }] }`，`client.mjs` 内容为把 `process.env` 里两个 `PISCES_*` 写入同目录 `seen.json` 后立即退出（`mkdtemp` + `afterEach` 清理，测试等待 marker 出现，最多 5 s）。

```ts
test("lists and starts a discovered client over the socket", ...)
// client.list → { clients: [{ id: "demo", source: "@demo/x", entry: <abs> }] }
// client.start { id: "demo" } → pid 为正整数；随后 seen.json 含
// { PISCES_SOCKET_PATH: <daemon socket>, PISCES_CLIENT_ID: "demo" } 且不含 daemon 的 API key 环境变量值
test("returns an empty client list without extension sources", ...) // options 无 extensions → { clients: [] }
test("answers client.not_found for an unknown id", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/daemon/test/clients-socket.test.ts`
Expected: FAIL，`protocol.unknown_method`（registry 尚未装配）。

- [ ] **Step 3: 实现装配改动**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/daemon/test/clients-socket.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 提交**

```bash
git add packages/daemon/src/host/daemon-host.ts packages/daemon/test/clients-socket.test.ts
git commit -m "feat(daemon): assemble the client registry in the daemon host"
```

---

### Task 5: CLI `client list|start`

**Files:**
- Create: `packages/cli/src/client-commands.ts`
- Modify: `packages/cli/src/main.ts`（usage、`COMMANDS`、解析、dispatch、deps 注入）
- Modify: `packages/cli/src/index.ts`（导出新模块）
- Test: `packages/cli/test/client-command.test.ts`
- Test: `packages/cli/test/client-e2e.test.ts`

**Interfaces:**
- Consumes: `connectClient`（`packages/cli/src/client.ts`）、`ClientError`、`socketPathFor`（`./lifecycle.js`）、`loadConfig`、`CommandIo`/`processIo`、`defaultConfigPath`。
- Produces:
  ```ts
  export interface ClientCommandsClient {
    request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
    close(): void;
  }
  export interface ClientCommandsDeps {
    connect(socketPath: string, timeoutMs?: number): Promise<ClientCommandsClient>;
  }
  export const productionClientDeps: ClientCommandsDeps;
  export interface ClientOptions {
    configPath: string;
    dataDir?: string;
    io?: CommandIo;
    json?: boolean;
  }
  export async function clientList(options: ClientOptions, deps?: ClientCommandsDeps): Promise<number>
  export async function clientStart(
    options: ClientOptions & { id: string },
    deps?: ClientCommandsDeps,
  ): Promise<number>
  ```

行为：
- 两个命令都是“短连接 + 单请求”：连接 → `request("client.list", {})` / `request("client.start", { id })` → `close()`。
- 人类输出：`client list` 每行 `id  source`（两个空格分隔，与 `provider list` 一致），空列表不输出任何行；`client start` 输出 `started <id> (pid <pid>)`。
- `--json`：`client list` 原样 `out(JSON.stringify(result))`；`client start` 输出 `JSON.stringify({ pid })`。
- 结果结构校验：`clients` 必须是数组且每项 `id`/`source`/`entry` 为字符串，`pid` 必须是正整数；否则 `throw new ClientError("client.protocol", "Invalid response from daemon")`（退出 1）。
- 退出码：成功 `0`；连接失败 `daemon.unreachable`、协议错误、`client.not_found`、`client.launch_failed` 均 `1`；用法错误 `2`。
- `main.ts`：`COMMANDS` 增加 `"client"`，`CLIENT_SUBS = ["list", "start"]`；`parse` 中 `client list` 不带位置参数、`client start` 必须且只能带一个 id；usage 增加 `client     list or start a client` 一行与 `--json` 说明补 `client`；dispatch 在 `provider`/`models` 分支之后、`templates` 之前调用；`runCli` 增加 `clientDeps: ClientCommandsDeps = productionClientDeps` 参数。

- [ ] **Step 1: 写失败测试** `packages/cli/test/client-command.test.ts`

用 fake `io`（收集 `out`/`err`）与 fake deps（记录 `method`/`params`，返回预设 result）：

```ts
test("client list prints id and source", ...)          // 输出 "repl  @demo/x\n"，返回 0，method === "client.list"
test("client list --json echoes the response", ...)     // 输出单行 JSON
test("client list rejects a malformed response", ...)   // clients 缺 source → 退出 1，stderr 含 client.protocol
test("client start prints the pid", ...)                // params { id: "repl" }，输出 "started repl (pid 4242)\n"
test("client start maps protocol errors to exit 1", ...)// daemon 返回 client.not_found → 退出 1，stderr 含码与固定文案
test("client usage errors exit 2", ...)                 // `client`、`client bogus`、`client start`（缺 id）、`client start a b`
```

同时更新 `packages/cli/test/main.test.ts` 中列举“未知命令”的断言（`client` 不再是未知命令），若该测试按码表断言则一并改。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/cli/test/client-command.test.ts`
Expected: FAIL，模块不存在 / `client` 仍是 usage 错误。

- [ ] **Step 3: 实现 `client-commands.ts` 与 `main.ts` 接线**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/cli/test/client-command.test.ts packages/cli/test/main.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 e2e** `packages/cli/test/client-e2e.test.ts`

照 `packages/cli/test/extensions-e2e.test.ts` 的结构（`buildDaemonOptions` + `startDaemon` + 临时 configDir，`skipIf` 条件与既有 e2e 相同），断言：`clientList` 人类输出含 `demo`；`clientStart` 返回 `0` 且 marker 文件里 `PISCES_CLIENT_ID === "demo"`。

- [ ] **Step 6: 跑 e2e**

Run: `npx vitest run packages/cli/test/client-e2e.test.ts`
Expected: PASS（构建产物存在时；`dist` 缺失时按既有 `skipIf` 跳过并记录）。

- [ ] **Step 7: 提交**

```bash
git add packages/cli/src/client-commands.ts packages/cli/src/main.ts packages/cli/src/index.ts packages/cli/test/client-command.test.ts packages/cli/test/client-e2e.test.ts packages/cli/test/main.test.ts
git commit -m "feat(cli): add client list and client start"
```

---

### Task 6: 设计文档与状态清单

**Files:**
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`（§4.2 `ClientRegistry` 行、§5.4 扩展接入的“本阶段不装配 providers 与 clients”、§6.6 同句、§6.7、§6.8 的 `client` 命令与“实现状态”段、§8.1 装配描述）
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`（§3.3 方法表与已路由列表、§3.7.3、§5.8.2、§5.9、§6.1/§6.7 的“`client.*` 未来目标”措辞、§7.1 表格与实现状态段）
- Modify: `docs/cli.md`（新增 `client` 命令小节：用法、输出、退出码、env 白名单、不托管进程；§8 未交付清单删掉 `client list|start`；§6 退出码表补 `client.not_found`/`client.launch_failed`）
- Modify: `docs/extensions.md`（`pisces.clients` 不再是 `unsupported_contribution`：声明格式、entry 解析规则、id 冲突、只有内置与配置目录源）
- Modify: `docs/implementation-gaps.md`（删掉 `ClientRegistry`、`client list`、`client start` 三处缺口；§2 表格与 §6 优先级重排；更新“已实现基线”）

内容要求（逐条核对，避免与代码不符）：
1. 源范围：内置 + `<configDir>/extensions`；工作区扩展不贡献客户端。
2. 每次 `client.list`/`client.start` 重新发现，只读 `package.json`，不加载代码，装改扩展无需重启。
3. 启动：`node <entry>`，env 只有 `PATH`/`PISCES_SOCKET_PATH`/`PISCES_CLIENT_ID`，stdio 继承 → `daemon.log`，`unref`，daemon 不跟踪、不回收，`stop` 不连带终止。
4. 错误：`client.not_found`（未注册，含 entry 无效或 id 冲突被丢弃）、`client.launch_failed`（子进程启动失败）、`protocol.invalid_request`（参数非法）、无 registry 的嵌入模式 → `protocol.unknown_method`。
5. `providers` 贡献仍然不装配，`extensions.unsupported_contribution` 只剩它一项。

- [ ] **Step 1: 改文档**

- [ ] **Step 2: 逐条核对文档与代码一致**

Run: `npx rg -n "client\." docs | head -40`，确认没有残留“未实现/目标设计”表述，且三段（HLD/DDS/cli.md）对源范围与生命周期的描述完全一致。

- [ ] **Step 3: 跑全量门禁**

Run: `pnpm test && pnpm typecheck && npx tsc -b tsconfig.build.json && pnpm lint`
Expected: 全部通过；`pnpm lint` 不改动除本计划文件外的文件（若 Biome 重排了文档无关的代码，回退这些改动）。

- [ ] **Step 4: 提交**

```bash
git add docs/1\ High-Level\ Design/1\ High-Level\ Design.md "docs/2 Detailed Design Specification/2 Detailed Design Specification.md" docs/cli.md docs/extensions.md docs/implementation-gaps.md
git commit -m "docs: record client registry delivery and drop the client gap"
```

---

## 完成标准

- `client.list` / `client.start` 在命令行启动的 daemon 上真实可用（Task 4、Task 5 e2e 覆盖）。
- 无客户端扩展时 `client.list` 返回空数组、`client.start` 返回 `client.not_found`，daemon 不因坏清单拒绝服务。
- 三份设计文档与 `docs/implementation-gaps.md` 不再把 `client.*` 记为未实现，且描述与代码一致。
- 全量门禁绿；未新增依赖；未改动 `core`、`protocol` 包。

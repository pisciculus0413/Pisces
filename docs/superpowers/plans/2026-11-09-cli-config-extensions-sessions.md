# CLI 配置、扩展列表与会话列表：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一全局 `config.json` 的 CLI/扩展 schema，交付 `config list|get|set|unset`、`extensions list` 与 `session.list` + `sessions list`，让后续 `run`/`sessions` 可手工验收。

**Architecture:** 扩展子集的纯解析器留在 daemon 并导出；CLI 生命周期加载器接受并忽略扩展键，`config` 编辑时分别用两套解析器做草稿校验。`config` 命令直接原子读写本地文件；`extensions list` 复用 daemon 发现器（只读清单，不装载代码）；`sessions list` 经新增的 `session.list` 协议路由读取 `SessionStore.list()`。

**Tech Stack:** TypeScript ESM、Node >=22.19、pnpm、Vitest、现有 `connectClient` 协议客户端、`discoverExtensions`、`SessionStore`。

**Spec:** `docs/superpowers/specs/2026-11-09-cli-config-extensions-sessions-design.md`

## Global Constraints

- Branch `dev-pi`；不建 worktree、不向 `main` 提交、不 push/merge。
- Core 无文件/环境 I/O，不依赖 daemon/protocol；两个边界扫描必须保持 exit 1。
- 每任务门禁 G：`node packages/daemon/native/build.mjs`；`pnpm exec tsc -b tsconfig.build.json`；`pnpm exec vitest run`；`pnpm exec tsc -p tsconfig.json`；`pnpm exec tsc -b tsconfig.build.json`；`pnpm exec biome check .`；两个 `rg` 边界扫描（期望 exit 1）；`git diff --check`；`git status --short`。
- 只显式暂存本任务文件；子代理 `model="deepseek-flash"`；不嵌套派 agent。
- 精确值：全局键 `dataDir,providers,defaults,templatesDir,defaultWorkspace,extensions,entryConfig`；工作区键 `defaults,extensions,entryConfig`；旧键 `defaultProvider/defaultModel` 拒绝；`defaults` 成对、非空字符串；`defaultWorkspace` 绝对路径。
- 工作区文件 `<workspace>/.pisces/config.json`；全局路径 `--config` 或 `defaultConfigPath`；扩展目录 `dirname(configPath)/extensions`。
- 配置写入：父目录不存在则 `0700`；文件 tmp+rename，`0600`；拒绝符号链接目标。
- 退出码：`config.invalid`/`config.unknown_key`/`config.no_workspace`/`extensions` 配置错误 → 2；`config.key_not_found` → 1；`sessions list` 连接失败 → 1。
- 错误文案固定，不回显配置值；不读取/输出凭据值。
- `session.list` 只返回已落盘会话；顺序不构成协议契约。

## Review Focus

1. 统一 schema：两个加载器对同一文件都不再拒绝对方的键；旧 `defaultProvider/defaultModel` 在任何 scope 都被拒绝；工作区不允许 CLI 键与 `defaultWorkspace`。
2. 写安全：路径解析拒绝原型污染与空段；数组写入边界正确；原子写、0600、拒绝 symlink；草稿校验不会放过重复 id、悬空 defaults 或非法扩展键。
3. 只读性：`extensions list` 绝不执行工具/包装器/上下文代码；`sessions list` 只经协议，不读 `events.jsonl`，不返回临时会话。
4. 退出码与固定文案：每条失败路径映射到正确码，且不泄漏配置值/路径。
5. 回归：生命周期命令仍能启动，`status/stop` 不因扩展键格式错误失败。

---

### Task 1: 统一全局配置 schema 与两个加载器

**Files:**
- Modify: `packages/daemon/src/extensions/types.ts`
- Modify: `packages/daemon/src/extensions/config.ts`
- Modify: `packages/daemon/src/extensions/extensions.ts`（默认 provider/model 改读 `config.defaults`）
- Modify: `packages/daemon/src/index.ts`
- Modify: `packages/cli/src/config.ts`
- Test: `packages/daemon/test/extensions-config.test.ts`（新建或扩展既有）
- Test: `packages/cli/test/config.test.ts`

**Interfaces:**
- Produces（daemon）：`parseExtensionConfig(value: unknown, scope: ConfigScope): ExtensionConfig`、`parseExtensionConfigText(text: string, scope: ConfigScope): ExtensionConfig`；`ExtensionConfig { defaults?: {provider; model}; defaultWorkspace?; extensions?; entryConfig? }`。
- Produces（CLI）：`loadConfig` 接受并忽略 `defaultWorkspace`、`extensions`、`entryConfig`；CLI 组校验不变。

- [ ] **Step 1: 写失败测试**
  - 全局 union：同时含 `dataDir/providers/defaults/templatesDir/defaultWorkspace/extensions/entryConfig` 的文件，CLI `loadConfig` 成功，daemon `parseExtensionConfig(value,"global")` 成功。
  - `defaults` 成对；缺一个或空字符串 → `config.invalid`；旧 `defaultProvider/defaultModel` → `config.unknown_key`。
  - 工作区 scope：`defaultWorkspace`、`dataDir`、`providers`、`templatesDir` → `config.unknown_key`；`defaults/extensions/entryConfig` 接受。
  - CLI 生命周期忽略扩展键：malformed `extensions`（非数组）仍能 `loadConfig`（只校验 CLI 组）；`start` 不为它失败。
  - `entryConfig` 仍按扩展规则校验（entry 名称、JSON 对象）。

- [ ] **Step 2: 跑 RED**
  `pnpm exec vitest run packages/daemon/test/extensions-config.test.ts packages/cli/test/config.test.ts` → FAIL。

- [ ] **Step 3: 实现**
  - `ExtensionConfig` 的 `defaultProvider/defaultModel` 替换为 `defaults`；`parseLayer` 改为解析 `defaults`（成对）；全局 scope 白名单加入 CLI 键并跳过；工作区仍拒绝它们。
  - 抽出纯 `parseExtensionConfig(value, scope)`，`readConfigLayer` 读文本后调用 `parseExtensionConfigText`；导出到 `packages/daemon/src/index.ts`。
  - CLI `CONFIG_KEYS` 增加扩展键（仅允许、不校验）；`defaults` 仍按 CLI provider/model 引用校验。生命周期路径不 import daemon 解析器。
  - 更新现有使用 `defaultProvider/defaultModel` 的 daemon 测试与调用点（含 `extensions.ts` 的默认值、`gateway` 文档/测试夹具）。

- [ ] **Step 4: 跑 GREEN 并跑门禁 G，提交**
  `git add` 仅上述文件；`git commit -m "feat(config): unify global config schema across cli and extensions"`。

---

### Task 2: 点号路径、草稿校验与 `config` 命令

**Files:**
- Create: `packages/cli/src/config-path.ts`
- Create: `packages/cli/src/config-edit.ts`
- Create: `packages/cli/src/config-commands.ts`
- Modify: `packages/cli/src/config.ts`（导出校验辅助）
- Modify: `packages/cli/src/main.ts`（`config` 子命令）
- Test: `packages/cli/test/config-path.test.ts`
- Test: `packages/cli/test/config-commands.test.ts`

**Interfaces:**
- Produces：`parseConfigPath(input: string): (string | number)[]`；`getValue(root, path)`、`setValue(root, path, value)`、`unsetValue(root, path)`；`validateGlobalDraft(value)`、`validateWorkspaceDraft(value, globalProviders?)`；`writeConfigFile(path, value): Promise<void>`。
- Produces：`configList/configGet/configSet/configUnset(options, deps)`，`ConfigCommandOptions {configPath; scope: "global"|"workspace"; workspace?; io; json?}`。
- 命令：`config list|get|set|unset`，`--scope global|workspace`、`--workspace`、`--config`、`--json`（list/get）。

- [ ] **Step 1: 写路径与编辑测试**
  - 路径：`providers.0.models.1.maxOutput`、`entryConfig."@scope/pkg#tool".timeout`、`-` 追加、数组越界、空段、`__proto__`/`constructor`/`prototype` 拒绝。
  - `set` 创建缺失对象父级，不修改原对象；`unset` 缺失路径 → `config.key_not_found`。
  - 草稿：空文件合法；`providers` 重复 id/model → `config.invalid`；`defaults` 与 `providers` 同时存在时悬空 → `config.invalid`；全局缺 `dataDir` 仍合法；工作区含 `defaultWorkspace` → `config.unknown_key`；工作区 `defaults` 引用全局存在的 provider/model 通过，引用不存在 → `config.invalid`。
  - 原子写：内容正确、模式 `0600`、父目录 `0700`、临时文件清理、symlink 目标拒绝。

- [ ] **Step 2: 写命令测试**
  - `config list` 缺失文件 → `{}`；`--json` 输出同一对象；人类模式键排序。
  - `get` 存在/缺失（退出 1，`config.key_not_found`）；`set` 值必须是合法 JSON；`unset` 删除后仍校验。
  - `--scope workspace` 无 `--workspace` 且 cwd 不存在 → `config.no_workspace` 退出 2；`--workspace` 与 global 同用 → 2。
  - 写入后 `loadConfig` 可读；`set providers` 写坏形状 → 2 且文件不变。
  - 不读取/打印环境变量值；`apiKeyEnv` 原样显示。

- [ ] **Step 3: 跑 RED**
  `pnpm exec vitest run packages/cli/test/config-path.test.ts packages/cli/test/config-commands.test.ts` → FAIL。

- [ ] **Step 4: 实现**
  - `config-path.ts`：分段解析（裸段/JSON 引号段/数字段/`-`），只允许自有属性；`setValue` 深拷贝后写入。
  - `config-edit.ts`：读原始 JSON（缺失 `{}`，坏 JSON `config.invalid`）；`validateGlobalDraft` 逐键校验并用 daemon 导出的 `parseExtensionConfig` 校验扩展子集；`validateWorkspaceDraft` 同理，若全局可读且有 `providers` 则检查 `defaults`；`writeConfigFile` 原子写与权限。
  - `config-commands.ts`：读-改-写；`list/get` 只读；所有错误用 `PiscesError` 固定文案；人类输出稳定。
  - `main.ts`：新增 `config` 子命令解析；其它命令的 `--config/--data-dir/--json` 行为不变。

- [ ] **Step 5: 门禁 G，提交**
  `git commit -m "feat(cli): add config list/get/set/unset"`（只暂存本任务文件）。

---

### Task 3: `extensions list`

**Files:**
- Modify: `packages/daemon/src/extensions/types.ts`（`DiscoveredEntry.origin`）
- Modify: `packages/daemon/src/extensions/discovery.ts`（origin、可选 workspace）
- Modify: `packages/daemon/src/extensions/config.ts` / `index.ts`（导出读层与发现）
- Create: `packages/cli/src/extensions.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/daemon/test/extensions-discovery.test.ts`（扩展）
- Test: `packages/cli/test/extensions-command.test.ts`

**Interfaces:**
- `DiscoveredEntry.origin: "builtin" | "config" | "workspace"`；`discoverExtensions(options, workspace: string | undefined, config)`：workspace 为 `undefined` 时跳过第三来源。
- `listExtensions({configDir, builtinDir?, workspace?}): Promise<{entries: {name; type; origin; description?}[]; issues: ExtensionIssue[]}>`（daemon 导出；内部读全局/工作区配置并调用发现器）。
- CLI `extensions list [--workspace <dir>] [--config <path>] [--json]`。

- [ ] **Step 1: 测试**
  - daemon：三类来源的 origin 正确；无 workspace 时不读 `<undefined>/.pisces`；workspace 缺省不影响前两类；现有 discovery 测试的调用点更新。
  - CLI：夹具目录含 builtin/global/workspace 包，输出 `package#name type origin`，`--json` 形状；不带 `--workspace` 不出现 workspace 条目；含一个会写副作用文件的工具入口，断言文件不存在（未执行代码）；坏 `entryConfig` → `config.invalid` 退出 2；空结果 `no extensions` 退出 0；issue 打印固定 stderr 但不改退出码。

- [ ] **Step 2: RED → 实现**
  - discovery 循环按来源下标设置 `origin`；`sources` 仅在传入 workspace 时包含第三项。
  - `listExtensions` 用 `readGlobalConfig`/`readWorkspaceConfig`，把 `EntryInfo` 投影成 `{name,type,origin,description?}`；不调用 loader/tools。
  - CLI 读取 `configDir = dirname(configPath)`；workspace 绝对化；解析失败固定 `config.invalid`。
  - 提交：`feat(cli): list extensions without loading them`。

- [ ] **Step 3: 门禁 G。**

---

### Task 4: `session.list` 协议与 `sessions list`

**Files:**
- Modify: `packages/daemon/src/gateway/protocol.ts`
- Modify: `packages/daemon/src/gateway/gateway.ts`
- Create: `packages/cli/src/sessions.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/daemon/test/gateway-session-list.test.ts`
- Test: `packages/cli/test/sessions-command.test.ts`

**Interfaces:**
- `SessionListResult { sessions: SessionMeta[] }`；Gateway `session.list` 无参数，返回 `{ sessions: await deps.store.list() }`。
- CLI `sessions list [--data-dir <dir>] [--config <path>] [--json]`：`connectClient(socketPathFor(dataDir))`，排序 `createdAt` 降序；人类输出 `id provider/model workspace createdAt`。

- [ ] **Step 1: 测试**
  - 协议：无会话返回 `[]`；`session.create` 的临时会话不出现；`turn.start` 落盘后出现；带参数仍接受（方法忽略参数）或按现有风格校验为空对象——选定：忽略未知参数，与 `provider.list` 一致。
  - CLI：fake client 返回两条会话，验证排序与 `--json`；连接失败 → 1 + `daemon.unreachable`；`--data-dir` 覆盖 socket 路径；不读取会话文件。
  - 真实 socket（可选放 Task 5）：临时会话不可见、落盘后可见。

- [ ] **Step 2: RED → 实现**
  - `protocol.ts` 增加结果类型；`gateway.ts` 的 handlers 增加 `session.list`；确认无会话锁需求（只读 store）。
  - CLI 复用 `connectClient`（默认 5 s）；错误码透传；固定 `daemon.unreachable`。
  - 提交：`feat(sessions): list persisted sessions over the protocol`。

- [ ] **Step 3: 门禁 G。**

---

### Task 5: 真实 socket 验收、文档与最终门禁

**Files:**
- Create: `packages/daemon/test/sessions-list-socket.test.ts`
- Create/Modify: `packages/cli/test/config-extensions-sessions-e2e.test.ts`
- Modify: `docs/cli.md`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`
- Modify: `docs/templates.md`（若引用旧默认键）

**Interfaces:** 复用 Tasks 1-4。

- [ ] **Step 1: 验收用例**
  - 统一配置：一份含 CLI + 扩展键的全局文件，`start` 成功、`config list` 原样、daemon 扩展读取成功（用 `parseExtensionConfig` 或真实 startDaemon）。
  - `config set providers` 后用该文件启动 daemon，`status` 正常；`config unset defaults` 后 `start` 仍成功但 `session.create` 按预期报 `session.model_required`（真实 socket）。
  - `extensions list` 对真实目录输出三类来源，副作用文件不存在；坏 `entryConfig` 退出 2。
  - 真实 daemon：`session.create` 后 `sessions list` 为空（临时会话）；`turn.start` 落盘后出现且字段正确；`--json`。
  - CLI 进程验收：`config get/set`、`extensions list`、`sessions list` 对真实二进制/daemon 的输出与退出码；daemon 停止 → `sessions list` 退出 1。
- [ ] **Step 2: 跑验收并修真实缺陷**（保留回归测试）。
- [ ] **Step 3: 文档**
  - `docs/cli.md`：三组命令、`--scope`、路径语法、退出码、示例、统一 schema 说明、旧键移除。
  - HLD §6/§7 与 DDS §3.4.2、§5.5.3、§7.1/§7.2：`session.list` 已路由、`config`/`extensions`/`sessions` 已实现、`defaults` 键、CLI 接受扩展键但只校验 CLI 子集。
  - 删除 `docs/cli.md` §8 中已交付项；保留仍未交付项。
- [ ] **Step 4: 最终门禁 G，记录实际计数、Node/平台；声明远端 CI 未运行。**
  `git commit -m "feat(cli): verify config, extensions and sessions commands"`。

## 验证矩阵

| 能力 | 单测 | 协议 | 真实 socket / 进程 |
| --- | --- | --- | --- |
| 统一 schema | 两加载器并集/旧键/工作区禁用 | - | 含扩展键的全局文件可启动 |
| `config` | 路径/草稿/原子写/权限 | - | set→start→status；unset→行为符合 |
| `extensions list` | origin/无代码执行 | - | 真实目录三类来源 |
| `session.list` | - | 临时不出现/落盘出现 | CLI `sessions list` |
| 退出码/文案 | 每条错误路径 | 错误透传 | 真实进程 |

# CLI 配置、扩展列表与会话列表：设计

**状态：待用户批准。**

## 1. 意图与原因

下一阶段要实现 `run` 与 `sessions`，需要先能手工准备和检查环境：配置 provider/model（全局与工作区）、查看扩展清点、列出已落盘会话。DDS §7.1 把 `config list/get/set/unset`、`extensions list`、`sessions list` 列为目标设计，均未实现。当前直接障碍是全局 `<configDir>/config.json` 被两套严格格式占用：CLI 只认 `dataDir/providers/defaults/templatesDir`，daemon 扩展层只认 `defaultWorkspace/defaultProvider/defaultModel/extensions/entryConfig`，任何一边写入都会让另一边拒绝启动。本阶段统一该文件并交付三组命令。

## 2. 目标 / 非目标 / 反目标

**目标**

- 统一全局 `config.json`：顶层同时接受 CLI 组与扩展组；两个加载器都不再拒绝另一组。
- `defaults: {provider, model}` 成为唯一默认 provider/model 键；扩展层旧键 `defaultProvider`/`defaultModel` 移除。
- `config list|get|set|unset` 管理全局与工作区 `.pisces/config.json`，点号路径，原子写入。
- `extensions list` 经本地发现列出 builtin、全局、工作区条目，不加载扩展代码。
- `session.list` 协议路由 + `sessions list` CLI；只列已落盘会话。
- 为 `run`/`sessions` 后续验收提供可脚本化的前置步骤。

**非目标**

- 不做 `run`、`sessions export/cancel`、`client.*`、`models list`、`providers check`、`auth`。
- 不做交互式配置编辑器、模板变量、配置迁移工具。
- 不改变 CLI `start/status/stop/templates` 行为（除接受统一后的全局文件）。
- 不在本阶段让 CLI 启动的 daemon 装配扩展配置（仍只传 `templatesDir`）。
- 不写 `~/.config/pisces/credentials`；`config` 不读取或输出凭据值。

**反目标（能跑也算失败）**

- `config set` 写出的文件让 `start` 或扩展加载必然失败（未知键、重复 id、悬空 defaults）。
- 工作区 scope 接受 `defaultWorkspace` 或 `dataDir`/`providers`。
- `extensions list` 执行扩展代码或读取凭据。
- `sessions list` 返回临时会话，或读取 `events.jsonl` 绕过服务层。
- 配置写入非原子、权限放宽、或把 api key 写进文件。

## 3. 约束

- 继续 `dev-pi`；不建 worktree、不 push/merge；每任务跑门禁 G。
- CLI 只依赖 `@pisces/core`/`@pisces/daemon`/`@pisces/protocol`；配置解析纯函数可放在 core 或“CLI 读、daemon 导出纯解析器”的形式，核心层仍无文件 I/O。
- 凭据只以 `apiKeyEnv` 形式存在；`config list/get` 可以显示 `apiKeyEnv`，绝不显示环境变量值。
- 全局配置路径沿用现有 `--config` 解析（**不新增 `PISCES_CONFIG`**）；工作区配置固定为 `<workspace>/.pisces/config.json`。
- 错误码沿用既有 `config.invalid`、`config.unknown_key`；新增 CLI 本地码 `config.key_not_found`、`config.no_workspace`。退出码：配置/用法错误（`config.*`、`config.no_workspace`）为 2；查询未命中（`config.key_not_found`）为 1；`sessions list` 连接失败为 1。固定文案，不回显配置值。
- 协议严格：`session.list` 无参数，返回 `{ sessions: SessionMeta[] }`，顺序不构成契约。

## 4. 方案

- **A. 统一全局 schema，两侧加载器接受并集（选定）**：一个文件容纳 CLI 与扩展键；`defaults` 统一默认 provider/model；工作区只允许扩展子集；`config` 用点号路径读写。符合 HLD「一个 config.json」，`run` 阶段可直接复用。
- **B. 拆成 `config.json` 与 `extensions.json`**：实现最小、schema 隔离，但偏离 HLD，需改 daemon 路径与迁移，且工作区仍是第二份文件。
- **C. 原始 JSON 编辑器，不做 schema 校验**：最快，但解决不了文件被一侧拒绝的根因，写坏配置只能到启动时才发现。

## 5. 设计

### 5.1 统一配置 schema

全局 `<configDir>/config.json`：

```json
{
  "dataDir": "/home/u/.local/state/pisces",
  "providers": [
    {
      "id": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": [{ "id": "gpt-4o-mini", "contextWindow": 128000, "maxOutput": 16384, "modalities": ["text"] }]
    }
  ],
  "defaults": { "provider": "openai", "model": "gpt-4o-mini" },
  "templatesDir": "/home/u/.config/pisces/templates",
  "defaultWorkspace": "/home/u/projects/notes",
  "extensions": ["@pisces/builtin-shell#shell"],
  "entryConfig": { "@scope/pkg#wrapper": { "timeoutMs": 5000 } }
}
```

工作区 `<workspace>/.pisces/config.json`：只允许 `defaults`、`extensions`、`entryConfig`。

- 键归属：CLI 组 `dataDir`、`providers`、`defaults`、`templatesDir`；扩展组 `defaults`、`defaultWorkspace`、`extensions`、`entryConfig`。`defaults` 为共用键。
- 扩展层删除 `defaultProvider`/`defaultModel`；`defaults` 必须成对出现，非空字符串。无部署迁移，文档标注 pre-release 变更。
- 全局 `defaultWorkspace` 绝对路径；工作区出现按 `config.unknown_key`。
- 工作区不允许 `dataDir`、`providers`、`templatesDir`、`defaultWorkspace`。
- 两个加载器共享扩展子集的纯解析器（daemon 导出，CLI 复用）；CLI 加载器只校验 CLI 子集并**忽略**扩展键（不校验）；扩展解析器忽略 CLI 键；daemon 扩展加载器忽略 CLI 键。生命周期命令不因扩展键格式错误而失败；`config` 命令同时跑两者，保证写入的文件对两侧都合法。

### 5.2 `config` 命令

```
pisces config list [--scope global|workspace] [--workspace <dir>] [--json]
pisces config get <path> [--scope ...] [--workspace <dir>] [--json]
pisces config set <path> <json-value> [--scope ...] [--workspace <dir>]
pisces config unset <path> [--scope ...] [--workspace <dir>]
```

- 默认 `--scope global`。`--scope workspace` 需要 `--workspace` 或当前目录；解析到绝对路径且必须存在，否则 `config.no_workspace`（退出 2）。`--workspace` 与 global 同用视为用法错误（退出 2）。
- `--config` 被所有新命令接受：全局层就是该文件，扩展目录取 `dirname(configPath)/extensions`；默认路径同现有生命周期命令。
- 路径语法：点号分段；数组用数字段（`providers.0.models.1.maxOutput`）；键含 `.` 时用 JSON 引号段（`entryConfig."@scope/pkg#tool".timeout`）。拒绝空段、`__proto__`/`constructor`/`prototype`。
- `list`：输出目标层原始 JSON（缺失文件为 `{}`）；人类模式按键排序、缩进；`--json` 原样。
- `get`：按路径取值；缺失 → `config.key_not_found`。`--json` 输出该值本身。
- `set`：值按 JSON 解析（字符串必须带引号）；对象父级缺失时创建空对象，数组只接受已存在索引或 `-`（追加）；写入前校验。
- `unset`：删除路径；删除后仍执行校验。
- 校验分“草稿”与“严格”：`config` 用草稿校验——每个出现的顶层键都必须合法、`providers` 内 id/model 唯一、`defaults` 若与 `providers` 同时存在则必须指向存在的 provider/model、扩展键按 §5.1 校验；允许缺少 `dataDir`/`providers`（便于从空文件初始化）。工作区 `defaults` 若全局文件可读且含 `providers`，也按全局 provider/model 校验；全局文件缺失时不跨层校验，只校验格式（悬空引用由 `session.create` 的 `session.invalid_model` 兜底）。`start`/`stop`/`status` 继续用严格校验（`dataDir` 默认值、`providers` 非空），且不校验扩展键。
- 写入：目标文件取 `--config` 或默认路径；父目录不存在则创建 `0700`；文件 `tmp` + `rename`，模式 `0600`；拒绝符号链接目标；失败 `config.invalid`/`storage.io` 固定文案。
- 允许 `providers` 含 `headers` 与 `apiKeyEnv`，不读取环境变量值；`config list/get` 不展开 `~`（读写原始值，`start` 时才展开）。

### 5.3 `extensions list`

```
pisces extensions list [--workspace <dir>] [--json]
```

- 来源：内置 `extensions/builtin`、`<configDir>/extensions/`、`<workspace>/.pisces/extensions/`（给了 workspace 才含第三项）。`<configDir>` 即 `dirname(--config 或默认 configPath)`。
- 复用 daemon 的 `discoverExtensions`：给 `DiscoveredEntry` 增加内部 `origin: "builtin" | "config" | "workspace"`（`EntryInfo.source` 仍是包名），并让 workspace 来源可选；只读清单/sidecar/技能正文，不导入工具/包装器/上下文代码，不读取凭据。
- 配置输入：全局配置的扩展子集 + 工作区配置（若 workspace 给出）；解析失败 `config.invalid`。
- 输出每条：`name`（`package#entry`）、`type`（tool/wrapper/skill/context）、`origin`（builtin/config/workspace），人类模式列对齐，`--json` 为 `{ entries: { name, type, origin, description? }[] }`；发现 issue 不影响退出码，stderr 打印 `extensions.invalid: <source>`（固定、不含路径）。`entryConfig` 无效使发现抛 `config.invalid` 时，命令整体失败、退出 2，不输出半份列表。
- 空结果打印 `no extensions`，退出 0。

### 5.4 `session.list` 与 `sessions list`

- Gateway 新增 `session.list`：无参数，`deps.store.list()`，返回 `{ sessions: SessionMeta[] }`；只含已落盘会话，临时会话不在内；顺序不承诺。
- CLI `sessions list [--data-dir <dir>] [--json]`：短连接 `session.list`，按 `createdAt` 降序（客户端排序），人类模式每行 `id provider/model workspace createdAt`；`--json` 输出原始结果。`--data-dir` 与生命周期命令同义（覆盖配置里的 dataDir）。daemon 未运行 → `daemon.unreachable` 退出 1。
- 无分页（会话量小），不做过滤。

### 5.5 加载器与文档

- `packages/cli/src/config.ts`：CLI 组校验保持不变；接受并忽略扩展键（不在生命周期路径校验）；`loadConfig` 仍要求严格组（`dataDir` 默认、`providers` 非空）。
- `packages/daemon/src/extensions/config.ts`：接受 CLI 键；`defaults` 取代旧键；导出纯 `parseExtensionConfig(value, scope)` 供 CLI 复用；合并逻辑不变。
- 文档：`docs/cli.md` 增加三组命令与退出码；HLD §6/§7 与 DDS §3.4.2、§5.5.3、§7.1 更新实现状态与 `defaults` 键；`docs/templates.md` 若引用旧键一并改。

### 5.6 验证

- 单测：统一 schema（并集、工作区禁用键、`defaults` 成对、旧键拒绝）；点号路径（数组、引号键、`-` 追加、原型污染拒绝、缺失路径）；草稿校验允许空文件但拒绝悬空 defaults/重复 id；原子写与 0600、符号链接拒绝；`config get` 缺失码。
- 协议：`session.list` 无 store 会话时 `[]`；落盘后返回 meta；临时会话不出现；无参数校验。
- CLI：三组命令对临时 HOME/config 的输出与退出码；`--scope workspace` 无 workspace 退出 2/码；`extensions list` 用夹具扩展目录验证三类来源且不执行代码；`sessions list` 对真实 daemon 输出、`--json`、daemon 停止 → 1。
- 真实 socket：创建会话、`turn.start` 落盘后 `sessions list` 可见；未落盘的临时会话不可见。
- 门禁 G；远端 CI 未运行需注明。

## 6. 留给实施者

- 共享扩展解析器的导出位置（daemon `extensions/config.ts`）与 CLI 导入方式。
- `config` 草稿校验中“同时存在”的精确判定（顶层键是否出现，还是解析后是否非空）。
- 点号路径解析器与引号段的精确语法；`set` 创建父对象的边界。
- `config list` 人类模式的具体排版；`extensions list` 列宽与 issue 文案。
- 草稿校验的复用方式（按顶层键逐个跑现有解析函数，或新增 partial 模式）。
- `sessions list` 输出中 provider/model 的连接符与时间格式（ISO 原样即可）。

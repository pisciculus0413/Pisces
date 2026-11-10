# 默认工作区与 `run --workspace`：设计

**状态：已获用户同意（建议 2 + 可选 `--workspace`）。**

## 意图

让全局 `defaultWorkspace` 真正成为新会话默认工作区，并允许 `pisces run --workspace <dir>` 为新建会话显式指定工作区。当前 CLI 启动的 daemon 忽略该键，导致 `run` 在只有 `defaultWorkspace` 时仍报 `session.workspace_required`。

## 行为

### 配置与 daemon 启动

- `CliConfig` 增加 `defaultWorkspace?: string`；全局加载器解析并校验为绝对路径（与扩展解析器一致），保留现有未知键/工作区层限制。
- `buildDaemonOptions` 把 `defaultWorkspace` 合并进 daemon `defaults.workspace`：
  - 有 `defaults` 时合并，不丢 provider/model；
  - 只有 `defaultWorkspace` 时也传 `defaults: {workspace}`；
  - 都没有时不传 `defaults`。
- 启动时不检查目录存在性/可写性；由 `session.create` 在创建时校验（`session.invalid_workspace`）。
- 已在运行的 daemon 需重启后才能读取新默认值（`config` 只影响此后启动/创建的会话）。

### `run --workspace <dir>`

- 仅用于新建会话（`--new`、无选择器、`--session --create` 且会话不存在）。
- 新会话 `session.create {workspace}` 显式传入，优先于 daemon 默认。
- 与既有会话同用（`--session` 已存在）→ 本地 `run.workspace_unsupported`（`Workspace can only be set for a new session`），退出 1，不修改会话。
- 值须为绝对路径；相对/空值 → 用法错误 2。
- 未给 `--workspace` 时沿用 daemon 默认；仍无默认则保持 `session.workspace_required`。

## 非目标

- 不改变既有会话的工作区（`session.configure` 不支持）。
- 不新增协议方法；不改变 daemon 的 workspace 校验规则。
- 不把 `defaultWorkspace` 加入工作区层（仍只允许全局）。

## 验证

- 配置：解析/拒绝相对 `defaultWorkspace`；`config list --json` 显示该键；未知键规则不变。
- assembly：默认合并（仅 workspace、workspace+defaults、都无）与不丢字段。
- run：新会话传 `--workspace`；既有会话报本地错误；相对路径用法错误；默认路径仍由 daemon 解析。
- 真实 socket：用临时 config 启动 daemon（带 `defaultWorkspace`），`run` 无 `--workspace` 成功；`--workspace` 覆盖默认；重启后生效。
- 文档：`docs/cli.md` 配置表/`run` 段、HLD、DDS；门禁 G。

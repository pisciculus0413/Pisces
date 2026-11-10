# 模板：格式、预览与应用

本文件描述当前已实现的模板契约：模板文件格式、路径与脚本规则、`template.list/preview/apply`、
`session.create {templateId}`、`projects.json`、CLI 命令、错误码与已知限制。它已被真实 Unix socket
与真实进程验收覆盖（`packages/daemon/test/templates-socket.test.ts`、
`packages/cli/test/templates-e2e.test.ts`）。权威设计见
`docs/1 High-Level Design/1 High-Level Design.md` §5.5、§6.9 与
`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §3.7.2、§5.8.1、§6.6。

## 1. 支持范围

- 模板是声明式 JSON：目录、文件内容、可选初始化脚本、可选会话初始配置；没有模板继承、条件步骤或
  变量插值。
- daemon 侧入口：`startDaemon({ templates: { configDir } })`；未提供时 `template.*` 一律
  `protocol.unknown_method`，`session.create` 出现 `templateId` 一律 `protocol.invalid_request`。
- CLI 侧入口：`pisces templates list|preview|apply`。`start` 把配置中的 `templatesDir` 作为第三个
  argv 传给子进程，子进程转成 `templates: { configDir }`。
- `template.preview` 无副作用；`template.apply` 必须显式确认；文件写入经 `WorkspaceAccess`，脚本
  经 `ExecHost`，不经 shell。
- 项目记录写入 `<dataDir>/projects.json`（原子追加，`0600`）。

## 2. 模板来源与布局

```
<configDir>/templates/<id>.json      # 每个模板一个文件，文件名去掉 .json 必须等于 id
```

- `configDir` 是软件配置目录；CLI 的 `config.json` 用 `templatesDir`（绝对路径，支持 `~/`）指向
  模板目录。目录不存在时模板列表为空，不报错。
- 每次 `template.list` 重新扫描目录，按 `id` 排序，不做陈旧缓存。
- 单个模板 JSON 上限 1 MiB；超限、JSON 错误、未知键或校验失败的模板不会出现在列表里，按 id 访问
  时返回 `template.invalid`；未知 id 返回 `template.not_found`。被拒绝的模板记录在
  `TemplateStore.issues()`（按 id 排序，只含 `id` 与安全错误码 `template.invalid`，不含路径或内容）。
  错误信息不回显模板内容。

## 3. 模板格式

```json
{
  "id": "notes",
  "name": "Notes project",
  "description": "Markdown notes with a scaffold script",
  "directories": ["docs", "docs/archive"],
  "files": [
    { "path": "README.md", "content": "# Notes\n" },
    { "path": "docs/.gitkeep", "content": "" }
  ],
  "initScript": { "command": "/usr/bin/git", "args": ["init"], "timeoutMs": 60000 },
  "config": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "extensions": [],
    "systemPromptFile": "README.md"
  }
}
```

| 键 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 非空字符串，必须等于文件名（去掉 `.json`） |
| `name` | 是 | 非空字符串，仅用于展示 |
| `description` | 否 | 字符串，仅用于展示 |
| `directories` | 否 | 相对路径数组，去重；每项都按 §3.1 规则校验 |
| `files` | 否 | `{ path, content }` 数组；`content` 为字符串，路径去重 |
| `initScript` | 否 | `{ command, args?, timeoutMs? }`，见 §3.2 |
| `config` | 否 | 会话初始值，严格键集合，见 §3.3 |

严格键集合：出现表外键、类型不符、重复 `id`、缺少 `id`/`name` 的模板整体无效。

### 3.1 路径规则

- 相对路径、非空、不含 NUL；按 `/` 分段，禁止空段、`.`、`..`、绝对路径和尾随 `/`。
- 目录与文件路径各自去重；文件路径不得与已声明的目录同名，也不得把文件当作另一路径的父目录
  （例如同时声明文件 `a` 与 `a/b`）。
- 写入前每个路径都经 `WorkspaceAccess.resolve` 校验仍在工作区内；越界按 `template.invalid` 拒绝。

### 3.2 初始化脚本

- `command` 必须是绝对路径；`args` 全部为字符串且不含 NUL；执行时直接 `spawn(command, args)`，
  不经过 shell，argv 原样传递。
- `timeoutMs` 可选，必须为整数，范围 `1..600000`；省略时为 `60000`。越界按模板无效处理，不会被
  静默截断。
- 执行目录（`cwd`）是解析后的工作区根目录；环境变量是 `ExecHost` 的白名单（基础 `PATH`），不继承
  daemon 的完整环境。
- 该超时是模板脚本的单次上限，daemon 不额外设置全局模板超时。脚本以 **daemon 用户**身份运行，没有
  沙箱，可访问工作区外文件与网络。
- 非零退出、超时或被信号终止都返回 `template.init_failed`。

### 3.3 会话初始配置（`config`）

| 键 | 说明 |
|---|---|
| `provider` / `model` | 作为新会话的默认 provider/model；显式请求值优先 |
| `extensions` | `package#name` 字符串数组，替换默认选择；无扩展模式下模板声明非空列表会在写盘前被拒绝 |
| `systemPromptFile` | 必须是模板 `files` 中声明的路径；文件内容以 `role=system`、`source="template"` 入队 |

模板配置不内嵌凭据。provider/model 必须已在 daemon 注册，否则写盘前返回 `session.invalid_model`；
既无模板配置也无 daemon 默认值时返回 `session.model_required`。

## 4. 预览：`template.preview`

请求 `{ templateId, workspace }`，返回：

```ts
interface TemplatePreview {
  directories: string[];
  files: { path: string; content: string }[];
  conflicts: string[];
  initScript?: { command: string; args: string[]; timeoutMs: number };
}
```

- 只解析与检查，**不创建目录、不写文件、不执行脚本、不写 `projects.json`**。
- `conflicts` 列出工作区中已存在、会被模板覆盖的文件路径。
- 脚本的完整 argv 与 `timeoutMs` 一并展示，用户可在确认前审阅。
- 预览不要求工作区存在（不创建根目录，也不报错）；工作区不存在时 `conflicts` 为空，`apply` 才以
  `session.invalid_workspace` 拒绝。

## 5. 应用：`template.apply`

请求 `{ templateId, workspace, confirmed: true, overwrite? }`。

- `confirmed` 不是字面量 `true`（含缺失）时返回 `protocol.invalid_request`，且在读写之前。
- 工作区必须已存在且可写；否则在任何写盘之前返回 `session.invalid_workspace`（不自动创建根目录）。
- 存在冲突且未带 `overwrite: true` 时返回 `template.workspace_conflict`。
- 执行顺序：
  1. 解析模板、校验路径并计算冲突（只读预检）；
  2. 校验会话配置（工作区、provider/model、extensions）：这些失败都发生在任何写盘之前，且每次
     `apply` 只校验一次；
  3. 经 `WorkspaceAccess` 创建目录与文件；
  4. 有 `initScript` 时经 `ExecHost` 执行，失败返回 `template.init_failed`；
  5. 读取 `systemPromptFile` 的内容；
  6. 原子追加一条 `ProjectRef` 到 `projects.json`；
  7. 由 `Gateway` 用第 2 步预检通过的会话创建临时会话（与 `session.create` 同一条内部路径）；
     provider/model/extensions/binding 都来自预检，只有提示词取第 5 步的结果，因此写盘之后
     不再重跑会话校验。
- 返回 `{ projectId, sessionId }`。临时会话在首次 `turn.start` 之前不落盘：`session.read` 可见队列
  与 `meta`，但没有节点记录，磁盘上也没有会话目录。
- `overwrite: true` 只影响已存在的文件（后写覆盖前写），不会删除模板未声明的文件。
- 预检通过后若写盘或脚本失败，已创建的文件与目录保留，不自动回滚；`ProjectRef` 只在脚本成功之后
  才写入，因此失败不会留下项目记录，也不会创建会话。

## 6. `session.create { templateId }`

- 只把模板 `config` 作为默认值：`provider`/`model`/`extensions`/`systemPromptFile`；显式请求字段优先，
  显式 `systemPrompt` 存在时抑制模板提示词。
- **不创建目录、不写文件、不执行脚本**；模板物化只能经 `template.preview`/`template.apply`。
- 模板提示词以 `role=system`、`source="template"` 入队，不直接写入供应商请求体，仍须经首次
  `turn.start` 的确认与落盘流程。
- 未知 `templateId` 返回 `template.not_found`；`systemPromptFile` 不可读返回 `template.invalid`；
  未装配模板的 daemon 返回 `protocol.invalid_request`。

## 7. 项目记录：`projects.json`

- 位置：`<dataDir>/projects.json`；内容为 `ProjectRef` 数组：

```json
[
  {
    "id": "1d1b1c8e-...",
    "templateId": "notes",
    "workspace": "/home/user/notes",
    "createdAt": "2026-11-09T08:00:00.000Z"
  }
]
```

- 追加方式：写 `projects.json.<pid>.tmp`（`0600`，`fsync`）后 `rename`；文件是符号链接或读取失败时
  拒绝写入。
- 文件损坏或结构不符：`storage.corrupt`，不写入；写入失败：`storage.io`，已创建的文件保留。
- 一次成功 `apply` 只追加一条记录；脚本失败则不追加。

## 8. 错误码

| 码 | 场景 |
|---|---|
| `protocol.invalid_request` | `template.apply` 缺少 `confirmed: true`；参数类型错误；未装配模板时的 `session.create {templateId}` |
| `protocol.unknown_method` | daemon 未装配模板时的 `template.*` |
| `template.not_found` | 未知模板 id |
| `template.invalid` | 模板 JSON 校验失败、按 id 访问一个校验失败的模板、路径越界、提示词文件不可读 |
| `template.workspace_conflict` | 存在冲突文件且未带 `overwrite: true` |
| `template.init_failed` | 脚本非零退出、超时、启动失败 |
| `session.workspace_required` / `session.invalid_workspace` | 工作区缺失、缺失默认值、不是目录或不可写 |
| `session.model_required` / `session.invalid_model` | 模板与默认值都没有 provider/model，或组合未注册 |
| `queue.invalid_control` / `queue.duplicate_name` | 模板 `extensions` 在无扩展模式下非空，或名称非法/重复 |
| `storage.corrupt` / `storage.io` | `projects.json` 损坏或写入失败 |

错误信息不含模板文件内容；CLI `apply` 失败不复述预览内容。

## 9. CLI

```bash
# 列出模板（id、名称与描述）
pisces templates list [--json]

# 预览：目录、文件路径、冲突、脚本 argv 与超时
pisces templates preview notes --workspace ~/notes [--json]

# 应用：必须显式 --confirm；--overwrite 覆盖已存在文件
pisces templates apply notes --workspace ~/notes --confirm [--overwrite] [--json]

# 自定义配置或数据目录
pisces templates apply notes --workspace ~/notes --confirm \
  --config ~/.config/pisces/config.json --data-dir ~/.local/state/pisces
```

- 配置：`config.json` 增加可选 `templatesDir`（绝对路径，支持 `~/`）；`start` 把它传给 daemon 子进程。
- 退出码：成功 `0`；用法错误（含缺少 `--confirm`）`2`，且不读配置、不连接 socket、不写任何文件；
  协议错误与 `daemon.unreachable` `1`。
- `apply` 成功输出一行：`project <projectId> session <sessionId>`。
- `preview` 人类输出列出 `directories:`、`files:`（只输出路径，不输出内容）、`conflicts:`，以及
  `script:`/`timeout:`。
- daemon 未运行：`error: daemon.unreachable: Daemon is not reachable`，退出 1。
- 请求预算：普通请求 5 s；`template.apply` 单独使用 660 s（600 s 脚本上限 + 60 s I/O）。超时打印
  `error: client.timeout: Daemon did not respond`，退出 1。

## 10. 已知限制

- **没有回滚**：写盘或脚本失败后已创建的文件保留，由用户处置。
- **脚本不是沙箱**：以 daemon 用户身份运行，可访问工作区外文件与网络，且只杀直接子进程，孙进程可能
  存活。
- **`apply` 可能拖延 `stop`**：长脚本期间 `stop` 需等待已准入请求；超过关闭预算时返回
  `daemon.stop_incomplete`。本阶段没有取消 seam。
- **客户端超时不代表 daemon 停止**：660 s 预算耗尽只说明没收到响应，daemon 可能仍在写盘或跑脚本；
  重试前先用 `pisces status` 与工作区检查。
- **CLI 启动的 daemon 不能选择扩展**：该路径仍是手动模式（无扩展），模板 `config.extensions` 非空会在
  写盘前以 `queue.invalid_control` 拒绝；扩展只能经直接 `startDaemon({ extensions })` 的宿主生效。
- 没有模板编辑界面、远程仓库、版本/升级、导入导出、继承或变量插值。
- 模板 JSON 与文件内容大小没有独立的每文件上限（模板 JSON 上限 1 MiB）。

## 11. 验证状态

- `packages/daemon/test/templates-socket.test.ts`：真实 daemon 与真实 Unix socket 覆盖列表、无副作用
  预览（含 `initScript.timeoutMs`）、缺 `confirmed`、冲突、成功应用（真实可执行脚本写标记、一条
  `projects.json`、`session.read` 可见 `source="template"` 的提示词、`turn.start` 前不落盘）、脚本
  失败、未知模板、`session.create {templateId}`，以及未装配模板的负向对照。
- `packages/cli/test/templates-e2e.test.ts`：构建后的 CLI 与它自己启动的 daemon 覆盖
  `templates list/preview/apply`；无 `--confirm` 退出 2 且不写文件；`--confirm` 输出
  `project ... session ...`；daemon 停止后退出 1 且为 `daemon.unreachable`。
- 本地只在 Node 26.13.0 / Linux x64 上验证；远端 CI 未运行。

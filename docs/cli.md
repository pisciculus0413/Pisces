# CLI：本地 daemon 生命周期

本文件描述当前已实现、并在真实 socket 与真实进程上验收覆盖的 CLI 子集：`start`、`status`、`stop`、
`templates`、`config`、`extensions list`、`sessions list|export|cancel`、`run`、`provider list` 与
`models list`，以及配置文件、凭据来源、退出码、文件位置与失败恢复。生命周期命令（`start`/`status`/
`stop`）由真实后台 daemon 与构建后的 `dist/main.js` 验收；`run` 由进程内真实 daemon 加构建后的 CLI
验收（见 §10）。
**未交付**的命令与平台在 §8 明确列出。权威契约见
`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §7.1、§7.2、§7.5、§8.6，
daemon 侧的安全边界见 `docs/daemon-linux.md`。

## 1. 支持范围

- 仅 Linux x64；Node.js `>=22.19.0`，ESM。
- 命令：`start`、`status`、`stop`、`templates list|preview|apply`、`config list|get|set|unset`、
  `extensions list`、`sessions list|export|cancel`、`run`、`provider list`、`models list`（模板细节见
  `docs/templates.md`，扩展配置见 `docs/extensions.md`）。没有 `client`、`providers check`、
  `auth`（见 §8）。`run` 只执行单个非交互 turn，不读取 stdin、不循环。
- 本地只在 Node 26.13.0 x64 上验证。CI 配置了 Node 22.19.0 / 24 / 26 x64，但本阶段未 push，
  远端矩阵结果**未验证**。
- macOS 与 Windows 不是当前实现；daemon 在绑定 socket 前以 `daemon.unsupported_platform` 失败，
  `start` 因此以 `daemon.start_failed` 退出 1 并给出日志路径。

## 2. 构建与调用

原生插件不会在安装时自动编译，必须先按当前 Node ABI 构建，再编译 TypeScript：

```bash
pnpm install --frozen-lockfile
node packages/daemon/native/build.mjs        # 生成 packages/daemon/native/peercred.node
pnpm exec tsc -b tsconfig.build.json         # 生成各包 dist/，含 packages/cli/dist/main.js
```

- `packages/cli/package.json` 的 `bin.pisces` 指向 `dist/main.js`。仓库内该文件没有可执行位，
  本地直接调用：

```bash
node packages/cli/dist/main.js --version
# pisces 0.0.1
```

- 包管理器安装 `pisces` 时会创建 symlink/shim；entry 判定经 `realpath` 解析两侧，因此 symlink
  调用可用（已由验收测试与单测覆盖）。
- 切换 Node 版本后必须重新构建原生插件，否则 `start` 以 `daemon.start_failed` 失败（日志内为
  `error: daemon.native_unavailable`）。

## 3. 配置文件

默认路径：`$XDG_CONFIG_HOME/pisces/config.json`；未设置时为 `~/.config/pisces/config.json`。
`--config <path>` 覆盖该路径。`status`/`stop` 也需要可读的配置（用于解析 `dataDir`）；配置文件
不可读或不合法时一律 `error: config.invalid: Invalid configuration`，退出 2。

OpenAI 兼容示例：

```json
{
  "dataDir": "~/.local/state/pisces",
  "providers": [
    {
      "id": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": [
        {
          "id": "gpt-5",
          "contextWindow": 400000,
          "maxOutput": 128000,
          "modalities": ["text", "image"]
        }
      ]
    }
  ]
}
```

字段：

| 键 | 必填 | 说明 |
|---|---|---|
| `dataDir` | 否 | 数据目录；必须是绝对路径（支持 `~/`），默认 `$XDG_STATE_HOME/pisces`，未设置时为 `~/.local/state/pisces` |
| `providers` | 是 | 非空数组，`id` 唯一 |
| `providers[].id` | 是 | 非空字符串 |
| `providers[].baseUrl` | 是 | `http:` 或 `https:`；禁止 userinfo、query 与 fragment |
| `providers[].apiKeyEnv` | 是 | 环境变量名（`[A-Za-z_][A-Za-z0-9_]*`），不保存密钥本身 |
| `providers[].headers` | 否 | 附加请求头；键值不得含控制字符 |
| `providers[].models` | 是 | 非空数组，`id` 唯一 |
| `models[].contextWindow` / `maxOutput` | 是 | 正整数 |
| `models[].modalities` | 是 | 非空，元素为 `text`、`image`、`audio` |
| `defaults` | 否 | `{ "provider": ..., "model": ... }`，必须指向已声明的组合 |
| `templatesDir` | 否 | 模板目录；绝对路径（支持 `~/`），`start` 启动时传给 daemon，修改需重启 |
| `defaultWorkspace` | 否 | 新会话的默认工作区；必须是绝对路径（不做 `~` 展开），由 daemon 在 `session.create` 时从配置读取 |

- `defaults` 是 CLI 与扩展层共用的唯一默认 provider/model 键；旧的 `defaultProvider`/`defaultModel`
  已移除（pre-release 变更，无迁移）：出现时按未知键退出 2。
- 全局文件还允许扩展组的 `defaultWorkspace`、`extensions`、`entryConfig`。`start` 启动的 daemon
  始终进入目录驱动扩展模式：CLI 只把命令行给出的 `--config` 路径原样交给 daemon 子进程，由子进程
  在传入 `extensions: { configPath }` 前把它解析为绝对路径（继承子进程启动时的 cwd）；CLI 不再合并
  `defaults` 或 `defaultWorkspace`；daemon 在每次 `session.create` 时读取该文件
  与 `<workspace>/.pisces/config.json`，并扫描 `dirname(configPath)/extensions` 与
  `<workspace>/.pisces/extensions`。daemon 的扩展加载器忽略 CLI 键；`config` 命令同时按两侧规则
  校验，因此它写出的全局文件对两个加载器都合法。
- `defaults`、`defaultWorkspace`、`extensions`、`entryConfig` 都在 `session.create` 时读取：改写配置后，
  之后**新建**的会话立即使用新值，无需重启 daemon；已创建的会话保持其冻结绑定与选择。
  `providers` 与 `templatesDir` 仍是启动绑定，修改后需要 `stop` 再 `start`。
- `--config <path>` 既精确决定全局配置文件名，也决定扩展根目录 `dirname(<path>)/extensions`；
  默认路径即 `<configDir>/config.json` 与 `<configDir>/extensions`。
- `defaultWorkspace` 必须是绝对路径；存在性与可写性在 `session.create` 时检查。省略 `--workspace`
  时，daemon 使用配置中的默认工作区；未配置返回 `session.workspace_required`，不可用返回
  `session.invalid_workspace`。
- 工作区 `<workspace>/.pisces/config.json` 只允许 `defaults`、`extensions`、`entryConfig`；出现
  `dataDir`、`providers`、`templatesDir` 或 `defaultWorkspace` 按未知键处理。
- 工作区 `defaults` 在全局文件可读且含 `providers` 时也校验其指向；全局文件缺失时只校验格式。
- 扩展键的语义见 `docs/extensions.md`。

- 未知键、类型错误、重复 `id`、相对 `dataDir` 或相对 `defaultWorkspace` 均视为不合法，退出 2。
- CLI 只暴露一种方言 `openai-chat`；`baseUrl` 必须能提供 OpenAI Chat Completions 兼容接口。
- `dataDir` 也可以用 `--data-dir <path>` 临时覆盖（必须是绝对路径；相对路径在 `start` 时以
  `daemon.insecure_directory` 退出 2）。

## 4. 凭据：只来自环境变量

- `start` 会逐个检查配置中每个 provider 的 `apiKeyEnv` 在当前环境中非空；缺任何一个就
  `error: config.missing_api_key: Missing API key environment variable`，退出 2，且不启动、
  不打印变量名。
- 密钥只在运行时从环境读取，交给后台 daemon 进程；不写入配置、argv、pid 文件、日志或
  `status --json`。后台进程继承 `start` 的完整环境。
- 本阶段没有凭据文件、没有 `auth` 命令；轮换密钥等于修改环境变量并 `stop`/`start`。

```bash
export OPENAI_API_KEY=sk-...
node packages/cli/dist/main.js start
```

## 5. 命令与真实输出

以下输出取自 Linux x64、Node 26.13.0 的真实运行（socket/pid 因机器而异）。

### `start`

```console
$ pisces start
running (pid 187181, socket /home/me/.local/state/pisces/run/pisces.sock)
```

`start` 把 daemon 作为 detached 子进程启动，写 pid 记录与 `daemon.log`，然后每 50 ms 轮询，直到
子进程存活、pid 记录仍指向该子进程、且本 dataDir 的 socket 完成协议握手；总预算 10 s。只有三者
同时成立才打印 `running` 并退出 0。重复启动：

```console
$ pisces start
error: daemon.already_running: A daemon is already running
$ echo $?
1
```

### `status`

```console
$ pisces status
running (pid 187181, socket /home/me/.local/state/pisces/run/pisces.sock)
sessions: s-1, s-2
```

```console
$ pisces status --json
{"state":"running","pid":187181,"socketPath":"/home/me/.local/state/pisces/run/pisces.sock","dataDir":"/home/me/.local/state/pisces","sessions":["s-1","s-2"]}
```

状态取值与退出码：

| 状态 | 文本 | JSON `state` | 退出码 |
|---|---|---|---|
| 运行中 | `running (pid N, socket S)` | `running` | 0 |
| 未运行 | `stopped` | `stopped` | 1 |
| pid 记录指向已退出进程 | `stopped (stale pid file)`，并删除该记录 | `stale` | 1 |
| 进程存活但 socket 不应答 | `unresponsive (pid N)`，保留记录 | `unresponsive` | 1 |
| socket 应答但无 pid 记录 | `unmanaged (socket S)` | `unmanaged` | 1 |

`status` 里的 `S` 与 JSON 的 `socketPath` 始终是由 dataDir 推导的 `<dataDir>/run/pisces.sock`；
pid 记录里的 `socketPath` 与它不一致时，按 `daemon.unknown_owner` 退出 1，不删记录。

只有 `running` 与 `unmanaged`（本 dataDir 的 socket 有应答）才会用一次短连接调用 `turn.list`，
把活跃 turn 的 `sessionId` 按出现顺序去重后输出。握手与该请求各自使用 500 ms 预算（与探测相同），
因此 socket 在探测后卡住也不会让 `status` 无限等待：

- 有活跃 turn：状态行之后追加 `sessions: <id1>, <id2>`；
- 无活跃 turn：`sessions: none`；
- 查询失败（连接、协议或 `turn.list` 结果不合法）：`sessions: unavailable`。

`--json` 只在查询成功时增加 `sessions`（无活跃 turn 时为 `[]`）；查询失败、`stopped`/`stale`/
`unresponsive` 以及 `daemon.unknown_owner` 早退时省略该键。新增输出只含 `sessionId`，不含 turnId、
时间戳或错误原文；查询失败不改变退出码，也不写 stderr。

JSON 只含 `state`、`pid`（仅进程存活的记录）、`socketPath`、`dataDir` 与查询成功时的 `sessions`；不含
密钥、变量名或 provider 配置。

### `stop`

```console
$ pisces stop
stopped (pid 187181, socket /home/me/.local/state/pisces/run/pisces.sock)
$ echo $?
0
$ pisces stop
not running
$ echo $?
0
```

`stop` 只在同一个 pid 仍存活、且由本 dataDir 推导出的 socket（`<dataDir>/run/pisces.sock`）完成
握手后，才向该 pid 发送 `SIGTERM`；随后最多等待 10 s 退出，成功才删除 pid 记录。pid 记录里
写的 `socketPath` 与推导路径不一致时，按未知属主处理（退出 1，不发信号，保留文件）。已停止时重复
`stop` 是幂等的，退出 0。

### `config list|get|set|unset`

```bash
pisces config list  [--scope global|workspace] [--workspace <dir>] [--json]
pisces config get   <path> [--scope ...] [--workspace <dir>] [--json]
pisces config set   <path> <json-value> [--scope ...] [--workspace <dir>]
pisces config unset <path> [--scope ...] [--workspace <dir>]
```

- 默认 `--scope global`，读写 `--config` 指定的全局文件；`--scope workspace` 读写
  `<workspace>/.pisces/config.json`。工作区取 `--workspace`，缺省为当前目录，且必须是已存在的目录。
- `--config` 被所有 `config` 子命令接受，并**精确**读写该文件（默认
  `$XDG_CONFIG_HOME/pisces/config.json`，即 `~/.config/pisces/config.json`）。扩展目录取
  `dirname(configPath)/extensions`，与 `config` 层读取的文件名无关。
- 路径语法：点号分段；数组用数字段（`providers.0.models.1.maxOutput`）；键含 `.` 时用 JSON 引号段
  （`entryConfig."@scope/pkg#tool".timeout`）。空段、`__proto__`、`constructor`、`prototype` 一律拒绝。
- `list` 输出目标层原始 JSON；文件缺失视为 `{}`。人类模式按键排序并缩进，`--json` 原样输出。
- `get` 按路径取值；不存在时 `config.key_not_found`，退出 1。
- `set` 的取值按 JSON 解析（字符串必须带引号）；对象父级缺失时创建空对象，数组只接受已有索引或
  `-`（追加）。`unset` 删除路径。写入前都按当前 scope 校验草稿；失败不修改文件。
- 写入使用 `tmp` + `rename`，文件模式 `0600`，缺失的父目录以 `0700` 创建；拒绝符号链接目标。

示例：

```console
$ pisces config set dataDir '"/home/me/.local/state/pisces"'
$ pisces config set providers '<providers-json>'
$ pisces config set defaults '{"provider":"openai","model":"gpt-5"}'
$ pisces config get defaults.model
gpt-5
$ pisces config get defaults.provider --json
"openai"
$ pisces config unset defaults
$ pisces config get defaults
error: config.key_not_found: Configuration key not found
$ echo $?
1
```

退出码：成功 0；`config.key_not_found` 为 1；`config.invalid`、`config.unknown_key`、
`config.no_workspace`、`storage.io`（写入失败）与用法错误为 2。错误只输出固定文案，不回显配置值。

`dataDir` 与 `templatesDir` 允许以 `~` 或 `~/...` 开头：草稿校验会像加载器一样展开为 `$HOME`
后再判断是否绝对路径，但写入文件时保留原样的 `~`（`HOME` 缺失时按 `config.invalid` 失败）。

### `extensions list`

```bash
pisces extensions list [--config <path>] [--workspace <dir>] [--json]
```

- 来源：内置 `extensions/builtin`、`<configDir>/extensions/`、`<workspace>/.pisces/extensions/`
  （只有给出 `--workspace` 才含第三项）。`<configDir>` 始终是 `dirname(--config <path> 或默认
  全局配置路径)`，**不是** XDG 配置主目录本身。扩展配置层读取的就是解析后的那个 `--config` 文件
  （默认 `<configDir>/config.json`），所以 `--config /path/alt.json` 会读 `alt.json` 而不是
  `/path/config.json`；`<configDir>/extensions/` 仍由同一个目录定位。
- 只读清单、sidecar 与技能正文；**不导入**工具/包装器/上下文代码，不读取凭据。
- 每行 `name type origin`，`origin` 为 `builtin`、`config` 或 `workspace`；`--json` 输出
  `{ "entries": [{ "name", "type", "origin", "description?" }] }`。
- 发现 issue 时只向 stderr 打印 `extensions.invalid: <source>`，不改变退出码。
- 空结果：人类模式打印 `no extensions`；`--json` 输出 `{"entries":[]}`；两者都退出 0。
  `entryConfig` 无效使发现失败时，整条命令退出 2，不输出半份列表。

```console
$ pisces extensions list --workspace /home/me/project
@pisces/builtin-shell#shell tool  builtin Runs a shell command in the workspace...
config-pkg#c                tool  config
workspace-pkg#helper        skill workspace
```

### `sessions list`

```bash
pisces sessions list [--config <path>] [--data-dir <dir>] [--json]
```

- 打开一个短连接调用 `session.list`；只列出已落盘会话，临时会话不出现。
- 人类模式按 `createdAt` 降序，每行 `id provider/model workspace createdAt`；`--json` 输出 daemon
  原始结果。
- 没有已落盘会话时，人类模式不打印任何行（stdout 为空）、退出 0；`--json` 输出
  `{"sessions":[]}`。
- `--data-dir` 与生命周期命令同义，覆盖配置里的 `dataDir`。
- 配置不合法退出 2；daemon 未运行或握手失败输出 `error: daemon.unreachable: Daemon is not reachable`，
  退出 1。

```console
$ pisces sessions list
s-1 openai/gpt-5 /home/me/project 2026-01-02T03:04:05.000Z
$ pisces sessions list --json
{"sessions":[{"id":"s-1","provider":"openai","model":"gpt-5","workspace":"/home/me/project","createdAt":"2026-01-02T03:04:05.000Z","schemaVersion":1}]}
```

### `sessions export`

```bash
pisces sessions export <session-id> [--node <node-id>] [--config <path>] [--data-dir <dir>]
```

- 只经协议：打开一个短连接调用 `session.read`，按响应的 `nextCursor` 自动分页直到末页；不直接读
  `events.jsonl` 或任何会话文件。
- 每行输出一个 `SessionNode` 的 JSON，**不额外包装**、不裁剪字段（可选字段如 `synthetic` 原样
  保留）；不输出队列、选择状态或 `meta`。整份输出可逐行 `JSON.parse`，行数即节点数。
- 无 `--node`：导出整棵会话树，顺序为 `session.read` 的追加顺序。`--node <node-id>`：只导出从根到
  该节点的线性分支（祖先链）；节点必须在同一会话内。
- 只写 stdout；没有节点时 stdout 为空、退出 0。不提供 `--output`，需要文件时用 shell 重定向。
- `--node` 仅本命令接受；`--json` 不适用于本命令。两者用错时均按用法错误退出 2。
- 未知会话由协议返回 `session.not_found`，未知节点返回 `session.node_not_found`，两者及分页/记录
  响应不合法（`client.protocol`）都退出 1；配置不合法退出 2；daemon 未运行或握手失败输出
  `error: daemon.unreachable: Daemon is not reachable`，退出 1。失败时不打印半行：分页中途失败时
  此前已输出的完整行仍保留在 stdout，命令以非零退出。

```console
$ pisces sessions export s-1
{"id":"n-1","parentId":"n-1","kind":"agent","role":"user",...}
{"id":"n-2","parentId":"n-1","kind":"agent","role":"assistant",...}
$ pisces sessions export s-1 --node n-2
{"id":"n-1","parentId":"n-1","kind":"agent","role":"user",...}
{"id":"n-2","parentId":"n-1","kind":"agent","role":"assistant",...}
```

### `sessions cancel`

```bash
pisces sessions cancel <session-id> [--config <path>] [--data-dir <dir>]
```

- 先 `turn.list`，只选择 `sessionId` 与参数相等的活跃 turn（保持 daemon 顺序），再逐个
  `turn.cancel { turnId }`。
- 成功时每个 turn 打印一行 `cancelled <turnId>`，退出 0。取消中止供应商流；已产生的节点仍写入
  会话。
- 没有匹配的活跃 turn 时打印 `no active turn`，退出 0；此时不调用 `turn.cancel`。取消进入收尾阶段后，
  turn 在从 `turn.list` 消失前仍可能被列出：紧接着重复取消可能因 `turn.cancel` 返回
  `{cancelled:false}` 而以 `turn.cancel_failed` 退出 1，待该 turn 消失后重复取消才是稳定的
  `no active turn`。
- 任一 `turn.cancel` 返回 `{cancelled:false}`（竞态或收尾中）时向 stderr 打印
  `error: turn.cancel_failed: Cancel request was not accepted`，退出 1；此前已成功取消的 turn 仍保留
  其 `cancelled` 行。`turn.cancel_failed` 由 CLI 本地产生。
- 配置不合法退出 2；daemon 未运行或握手失败输出
  `error: daemon.unreachable: Daemon is not reachable`，退出 1；`turn.list`/`turn.cancel` 响应不合法
  时输出 `error: client.protocol: Invalid response from daemon`，退出 1。

```console
$ pisces sessions cancel s-1
cancelled t-1
$ pisces sessions cancel s-1
no active turn
```

### `run`

```bash
pisces run [prompt] [--new | --continue | --session <id> [--create]]
           [--workspace <dir>] [--model <id>] [--provider <id>]
           [--system-prompt <text> | --use-default-system-prompt]
           [--enable <package#name>]... [--disable <package#name>]...
           [--print | --json]
           [--config <path>] [--data-dir <dir>]
```

- 非交互：只创建一个 turn 并等待它结束；不读取 stdin、不保留进程、不做多轮输入。`[prompt]` 必填
  且去空白后非空；位置参数可出现在任意选项前后，多余的位置参数是用法错误。
- 会话选择（`--new`、`--continue`、`--session` 互斥；缺省等同 `--new`）：
  - `--new`：调用 `session.create` 新建会话。新会话在 `turn.start` 后首次提交时才落盘。
  - `--continue`：调用 `session.list`，取 `createdAt` 最大的已落盘会话；并列时取 daemon 返回顺序中的
    第一个。没有已落盘会话时按 `session.not_found` 退出 1。
  - `--session <id>`：先用一次有界 `session.read`（`limit: 1`）确认会话存在，之后的操作都使用该 id。id 必须匹配
    `[A-Za-z0-9_-]+`，否则是用法错误。会话不存在且带 `--create` 时新建（服务端生成新 id）；不带
    `--create` 时按 `session.not_found` 退出 1。`--create` 只能与 `--session` 同用。
- 会话选项：
  - `--workspace <dir>`：只为本次新建的会话指定工作区，必须是绝对路径，优先于配置文件中的默认
    工作区（daemon 在 `session.create` 时读取）；只传给 `session.create`（`--new`、缺省选择器、或
    `--session --create` 且会话不存在）。
    与既有会话同用（`--session` 命中或 `--continue`）时本地返回
    `error: run.workspace_unsupported: Workspace can only be set for a new session`，退出 1，且不修改
    会话、不入队、不启动 turn；该拒绝只在确有已落盘会话时发生，`--continue --workspace` 在没有会话时
    仍先以 `session.not_found` 退出 1。省略时沿用 daemon 的默认工作区：未配置默认值时 daemon 返回
    `session.workspace_required`，已配置的默认工作区不可用（不存在、不是目录或不可写）时返回
    `session.invalid_workspace`，两者都由 CLI 原样转发并退出 1（不是 2）。相对或空值是用法错误
    （退出 2）。
  - `--model` / `--provider`：新会话交给 `session.create`；既有会话交给 `session.configure`。两者对既有
    会话必须成对给出，只给一个时 daemon 返回 `session.model_required`（退出 1）。
  - `--system-prompt <text>`：新会话走 `session.create.systemPrompt`；既有会话走
    `session.configure.systemPrompt`（改写队列中尚未确认的 `instruction` 系统提示，没有则入队）。与
    `--use-default-system-prompt` 互斥。
  - `--use-default-system-prompt`：只对新会话有效，不写入任何提示。对既有会话本地返回
    `error: run.default_system_prompt_unsupported: Default system prompt applies only to new sessions`，
    退出 1，而不是静默 no-op。
  - `--enable` / `--disable`：可重复，值为 `package#name`（两段非空、不含空白、恰好一个 `#`；同一名字
    重复出现是用法错误）。run 先做一次有界 `session.read`（`limit: 1`），同时取回已提交的 `selection`
    与整个队列；在已提交选择上按队列顺序重放未确认的 `control`/`declaration` toggle（配置层的待生效
    默认值），再按参数顺序求差集：先按 `--enable` 顺序补入未选中的名字，再按 `--disable` 顺序移除已选中的
    名字。只有实际变化才生成一条 `{kind:"control",role:"declaration",source:"run"}` 条目，`content`
    为 `[{"toggle":[names]}]`；它与提示词在同一 `queue.enqueue` 批次中提交（控制条目在前）。没有变化时
    不发控制条目。非扩展装配的嵌入 daemon（不经 CLI 启动的手动模式）会以 `queue.invalid_control`
    拒绝该条目；CLI 启动的 daemon 始终装配扩展。
- 所有输入先入队：提示词作为 `{kind:"agent",role:"user",source:"run"}` 经 `queue.enqueue` 提交，随后
  `turn.start`；提示词从不写入请求体。`session.subscribe` 在入队前建立，事件不会漏收。
- 同一会话已有其他客户端正在运行的 turn 时，daemon 可能让 `turn.start` 返回 `mode:"steer"`；run 不对
  该模式做特殊处理（只报告那一个 turn 的结局），因此不要在同一会话上并发执行 run。
- 输出模式：
  - 默认：`turn.delta` 的文本增量直接写 stdout，结束时补一个换行。
  - `--print`：不写增量，结束后只写累积的最终文本加换行；失败的 turn 写累积文本（通常为空，即只输出一个换行）。
  - `--json`：结束后写**一行** JSON `{sessionId,turnId,reason,text,error?}`，`reason` 为
    `completed`/`cancelled`/`failed`，`error` 只在 `failed` 时出现且为 daemon 投影的
    `{code,message}`；stdout 没有其他内容。`--print` 与 `--json` 互斥。
- 退出码：
  - `0`：turn `completed`。
  - `1`：运行时/协议/会话失败，包括 `failed` turn、`daemon.unreachable`、`client.protocol` 与
    `queue.invalid_control` 等协议错误。人类模式把 failed 的 `error: <code>: <message>` 写 stderr；
    failed turn 在 `--json` 下只写对象、不写 stderr（协议错误与运行中途断连仍写 stderr，见下）。
  - `2`：用法错误或 `config.invalid`。这两类错误一律只写 stderr，**不产生 JSON 对象**。
  - `130`：turn 被取消（`reason=cancelled`）。Ctrl-C 只发送一次 `turn.cancel` 并等待 `turn.ended`；
    在另一个终端执行 `pisces sessions cancel <id>` 造成的取消同样以 130 退出，CLI 无法区分取消来源。
  - 运行中途连接断开时按 1 退出并写 stderr；即使开了 `--json` 也不会产生半份对象。
- 失败 turn 的错误码由 daemon 的 `turn.ended` 投影决定：目前只有 `turn.empty` 保留原码，其他失败
  （含供应商解析/请求错误）一律为 `internal.error: Turn failed`；CLI 不回显供应商、适配器或异常原文。

输出形态示例（文本内容取决于供应商与 daemon 默认）：

```console
$ pisces run "explain this repo" --print
final answer text
$ pisces run --continue --json
{"sessionId":"s-1","turnId":"t-2","reason":"completed","text":"final answer text"}
$ pisces run "hello" --enable pkg#tool --print
error: queue.invalid_control: Invalid queue entry
$ echo $?
1
```

`--json` 下的失败示例（stdout 一行，stderr 为空，退出 1）：

```console
$ pisces run "hello" --json
{"sessionId":"s-1","turnId":"t-1","reason":"failed","text":"","error":{"code":"internal.error","message":"Turn failed"}}
```

### `provider list`

```bash
pisces provider list [--config <path>] [--data-dir <dir>] [--json]
```

- 只读：打开一个短连接调用 `provider.list`，数据来自 daemon；本地配置里的 provider 定义不参与
  该输出（配置文件只用于解析 `dataDir`）。
- 列出 daemon 已知的**全部** provider，不按 `ready` 过滤：`ready` 只表示该 provider 的凭据当前
  可用。人类模式每行 `id  ready|unready  models=<n>`，顺序为 daemon 返回顺序，CLI 不另行排序。
- 模型清单为空的 provider 同样列出（`models=0`），daemon 对其恒返回 `ready=false`。
  该状态只可能来自以编程方式装配的 daemon（协议允许空模型清单）：CLI 配置要求每个 provider 的模型
  非空，所以由 `pisces start` 起的 daemon 不会出现 `models=0`。
- `--json` 输出 daemon 原始结果 `{ "providers": [{ "id", "ready", "models": [...] }] }`：
  原样转发、不做结构校验（与 `models list --json` 不同，后者会校验并展平）。`pricing` 只可能出现在
  这里的 `models[]` 里（若 daemon 提供了定价）。
- 不输出 `dialect`、`baseUrl`、`headers` 或任何凭据值。
- 配置不合法退出 2；daemon 未运行或握手失败输出
  `error: daemon.unreachable: Daemon is not reachable`，退出 1。

```console
$ pisces provider list
alpha  ready  models=2
beta  unready  models=0
$ pisces provider list --json
{"providers":[{"id":"alpha","ready":true,"models":[{"id":"one","contextWindow":8000,"maxOutput":1000,"modalities":["text"]},{"id":"two","contextWindow":16000,"maxOutput":2000,"modalities":["text","image"],"pricing":{"input":1.5,"output":2.5,"currency":"USD"}}]},{"id":"beta","ready":false,"models":[]}]}
```

以上示例取自验收测试中直接注册了 `alpha`（2 个模型，其中一个带 `pricing`）与 `beta`（0 个模型）
的 daemon；CLI 配置文件不接受 `pricing`，所以由 `pisces start` 起的 daemon 不会返回该字段。

### `models list`

```bash
pisces models list [--provider <id>] [--config <path>] [--data-dir <dir>] [--json]
```

- 只读：同样只调用 `provider.list`，在 CLI 侧展平为 `{ provider: <provider.id>, ...model }`。
- 默认列出**所有** provider 的模型：不按 `ready` 过滤，空模型清单的 provider 不贡献任何行。
  provider 按 `id` 字典序，provider 内的模型保持 daemon 顺序。
- 人类模式每行 `provider/model  context=<n>  maxOutput=<n>  modalities=text,image`；
  `pricing` 只出现在 `--json`。
- `--provider <id>` 只保留该 provider。id 不存在时打印
  `error: provider.not_found: Unknown provider`，退出 1，stdout 为空。合法的空结果（例如该 provider
  没有模型）人类模式打印 `no models`，退出 0。与 `models=0` 一样，这样的 provider 只会出现在以编程
  方式装配的 daemon 里，经 CLI 配置启动的 daemon 不会产生该空结果。
- `--json` 输出
  `{ "models": [{ "provider", "id", "contextWindow", "maxOutput", "modalities", "pricing"? }] }`。
- 配置不合法退出 2；daemon 未运行或握手失败退出 1（`daemon.unreachable`）。

```console
$ pisces models list
alpha/one  context=8000  maxOutput=1000  modalities=text
alpha/two  context=16000  maxOutput=2000  modalities=text,image
$ pisces models list --provider beta
no models
$ pisces models list --provider missing
error: provider.not_found: Unknown provider
$ pisces models list --json
{"models":[{"provider":"alpha","id":"one","contextWindow":8000,"maxOutput":1000,"modalities":["text"]},{"provider":"alpha","id":"two","contextWindow":16000,"maxOutput":2000,"modalities":["text","image"],"pricing":{"input":1.5,"output":2.5,"currency":"USD"}}]}
```

| 命令 | 退出码 |
|---|---|
| 全部命令成功 | 0 |
| `run` 完成 turn（`completed`） | 0 |
| `config get` / `config unset` 未命中（`config.key_not_found`）；`sessions list|export|cancel` / `run` / `provider list` / `models list` 连接失败（`daemon.unreachable`）；`run` 的失败 turn、`client.protocol`、`queue.invalid_control` 等协议/会话/供应商错误；`run --workspace` 用于既有会话（`run.workspace_unsupported`）；`sessions export|cancel`、`provider list`、`models list` 与人类模式的 `sessions list` 协议响应不合法（`client.protocol`；`sessions list --json` 与 `provider list --json` 原样透传、不做结构校验，但协议层/传输失败仍退出 1）；`sessions export` 的 `session.not_found` / `session.node_not_found`；`sessions cancel` 被拒绝（`turn.cancel_failed`）；`models list --provider` 未知 id（`provider.not_found`） | 1 |
| 已在运行 / 未知属主 / 启动失败 / 停止超时 / socket 无属主 / pid 记录写入或清除失败 | 1 |
| `run` 的 turn 被取消（Ctrl-C 或外部 `sessions cancel`） | 130 |
| 用法错误、配置不合法、配置键未知、本地工作区不可用（仅指 `config`/`extensions`/`templates` 的本地解析，如 `config --scope workspace` 的 `config.no_workspace`、缺少必需 `--workspace` 的用法错误；`run` 的工作区缺失/不可用由 daemon 以 `session.workspace_required`/`session.invalid_workspace` 返回，计入上一行 1）、缺少密钥、数据目录不可用 | 2 |

选项：

| 选项 | 说明 |
|---|---|
| `--config <path>` | 配置文件路径（所有命令接受） |
| `--data-dir <path>` | 覆盖 `dataDir`（生命周期、`templates`、`sessions list|export|cancel`、`run`、`provider list`、`models list`） |
| `--node <id>` | 只导出该节点的分支（仅 `sessions export`） |
| `--provider <id>` | 只列出该 provider 的模型（仅 `models list`）；指定会话的供应商（仅 `run`） |
| `--new` / `--continue` / `--session <id>` / `--create` | 会话选择（仅 `run`；前三者互斥，`--create` 只配 `--session`） |
| `--model <id>` / `--system-prompt <text>` / `--use-default-system-prompt` | 设置该会话的模型与系统提示词（仅 `run`） |
| `--enable <name>` / `--disable <name>` | 启用/停用扩展条目，可重复（仅 `run`） |
| `--print` | 只输出最终 turn 文本（仅 `run`；与 `--json` 互斥） |
| `--scope <global\|workspace>` | `config` 的目标层，默认 `global` |
| `--workspace <dir>` | 工作区目录（`config --scope workspace`、`extensions list`）；新会话的工作区（仅 `run`，绝对路径，须为新建会话，既有会话仅在已落盘时拒绝） |
| `--json` | 机器可读输出：`status`、`templates`、`config list/get`、`extensions list`、`sessions list`、`run`、`provider list`、`models list` |
| `--help` / `--version` | 帮助/版本；可在第一个参数位置或任一命令参数位置使用（`wat --help` 仍是用法错误） |

未知命令（如 `client`、`providers check`、`auth`）打印 usage 并以 2 退出；`--config`、`--data-dir`、
`--node`、`--provider`、`--workspace`、`--scope`、`--session`、`--model`、`--system-prompt`、`--enable`、
`--disable` 缺少取值或其取值以 `-` 开头、`--json` 用于不支持的子命令（含 `sessions export|cancel`）、
`--node` 用于非 `sessions export`、`--provider` 用于 `provider list`（`models list` 与 `run` 接受它）、
`--workspace` 与 `--scope global` 同用、`run --workspace` 不是绝对路径、`--print` 与 `--json` 同用、`--system-prompt` 与
`--use-default-system-prompt` 同用、`run` 缺少/多余位置参数或会话选择器冲突时，同样按用法错误处理。

## 6. 文件位置

| 路径 | 内容 | 权限 |
|---|---|---|
| `<dataDir>/daemon.pid` | 单条 JSON：`{ "pid", "socketPath", "startedAt" }` | `0600` |
| `<dataDir>/daemon.log` | daemon 子进程 stdout/stderr（启动行、错误码） | `0600` |
| `<dataDir>/run/pisces.sock` | 本地 Unix socket | `0600` |
| `<dataDir>/run/pisces.lock` | daemon 单实例锁 | `0600` |
| `<dataDir>/sessions/` | 会话记录（由 daemon 维护） | 目录 |
| `<config home>/pisces/config.json` | 本文件所述的全局配置（统一 schema） | 用户自定；`config set` 写入时 `0600` |
| `<workspace>/.pisces/config.json` | 工作区配置（只允许扩展子集） | `config set` 写入时 `0600` |

`<config home>` 是 `$XDG_CONFIG_HOME`（缺省 `~/.config`）。§5 中的 `<configDir>` 不是它，而是
`dirname(解析后的 --config 路径)`；两者只在默认配置路径下重合于 `~/.config/pisces`。

- **只有 `start` 会创建并校验 `dataDir` 策略**：路径必须是绝对路径（`--data-dir` 相对路径直接
  以 `daemon.insecure_directory` 退出 2）、存在或可创建、属于当前有效 uid、且不带 group/world
  写位；`start` 以 `0700` 创建。不满足时 `error: daemon.insecure_directory: Data directory is not
  private`，退出 2。
- `status`/`stop` **不**校验该策略：它们只读 `<dataDir>/daemon.pid`，并探测由 dataDir 推导的
  `<dataDir>/run/pisces.sock`；`status` 在探测成功后还会沿同一 socket 调用一次 `turn.list` 以列出
  活跃会话（探测失败则不调用）。目录不安全只会表现为探测失败（`unresponsive`/`unknown_owner`）。
- `daemon.pid` 写入或清除失败时打印 `error: storage.io: Daemon pid file could not be written`，
  退出 1（运行时失败）。
- `daemon.log` 会记录 socket 路径与错误码，不会记录密钥。
- `stop` 后 `daemon.pid` 被删除；`run/` 与 `sessions/` 目录保留。

## 7. 失败与恢复

- **stale pid 文件**（记录中的进程已退出）：`status` 打印 `stopped (stale pid file)`（退出 1）并删除
  记录；`stop` 打印 `not running`（退出 0）并删除记录；`start` 直接回收该记录后启动。
- **pid 文件内容损坏**：视为无属主记录。`status`/`stop` 按未运行处理；`start` 在确认本 dataDir 的
  socket 不应答后清除该文件并正常启动。
- **`daemon.unknown_owner`**（进程存活、但本 dataDir 推导的 socket 不应答，或者记录里的
  `socketPath` 与推导路径不一致）：`start`、`status` 与 `stop` 都退出 1，**保留** pid 记录、不发送任何
  信号（防止 PID 复用误杀）。`start`/`status`/`stop` 只信任推导路径，记录里的 `socketPath` 仅作诊断
  参考（`status --json` 也输出推导路径）。恢复步骤：
  1. `ps -p <记录中的 pid> -o pid,cmd` 查看该进程是什么；
  2. 若确实是本 dataDir 的 `daemon-child.js`，可自行 `kill -TERM <pid>`，再 `pisces stop` 或
     `pisces start`；若进程异常，必要时 `kill -KILL` 后删除 `daemon.pid`；
  3. 若不是本 daemon（PID 已被复用），不要杀它，只需删除 `<dataDir>/daemon.pid`。
- **`daemon.already_running`**：同 dataDir 已有应答的 daemon。先 `pisces status` 确认，再 `stop` 或
  直接复用。
- **`daemon.start_failed`**：`start` 会同时打印 `log: <dataDir>/daemon.log`，并已清理自己写下的 pid
  记录、终止自己启动的子进程。先看日志（其中只有固定错误码，如 `daemon.native_unavailable`、
  `daemon.unsupported_platform`、`daemon.lock_busy`）。
- **`daemon.stop_timeout`**：10 s 内进程未退出，记录保留；daemon 可能仍在收尾，先 `status`，必要时
  按上面 `unknown_owner` 的步骤人工处置。
- **`daemon.unmanaged`**（socket 应答、无 pid 记录）：`stop` 退出 1 且不发送信号；该 daemon 不是本
  CLI 启动的，需人工确认后用 `kill` 停止。
- **`config.invalid`**：`start`/`status`/`stop` 以及 `sessions list|export|cancel`、`run`、
  `provider list`、`models list` 都需要可读配置（用于解析 `dataDir`）；修复配置文件后重试。
- **`config.unknown_key` / `config.no_workspace`**：`config` 的目标层出现不允许的键，或
  `--scope workspace` 没有可用目录；命令退出 2，不写任何文件。
- **未知键的码取决于命令**：同一个不允许的顶层键，`config list|get|set|unset` 报
  `config.unknown_key`，而 `start`/`status`/`stop`/`templates`/`extensions list`/`sessions list|export|cancel`
  等生命周期与读取命令统一报 `config.invalid`（加载器只映射固定码）。看到 `config.invalid` 时，
  先用 `config list` 看原始内容，再对照 §3 的键白名单排查。
- **`config unset` 在删除后重新校验整份草稿**：文件里有多个未知键（或残留的悬空 `defaults`）时，
  一次 `unset` 只能去掉一个，剩下的仍让命令以 `config.invalid`/`config.unknown_key` 失败；
  这种文件请手工编辑（或逐次用 `unset` 配合其他修复），不要指望一条命令清干净。
- **`config set` 的写入顺序**：草稿校验要求 `defaults` 必须指向已存在的 `provider` 与 `model`，所以
  新文件先写 `dataDir`、再写 `providers`，最后写 `defaults`；若已有 `defaults` 而要先换掉
  `providers`，先 `config unset defaults`，否则改 `providers` 的那一步会因悬空引用被拒。
- **`config.key_not_found`**：`config get`/`unset` 的路径不存在；退出 1，文件不变。
- **`provider.not_found`**：`models list --provider <id>` 的 id 不在 daemon 的 provider 清单里。该码
  由 CLI 本地产生（协议没有对应错误码），退出 1，stdout 为空；先用 `provider list` 确认可用 id。
- **`turn.cancel_failed`**：`sessions cancel` 的 `turn.cancel` 未被 daemon 接受（`{cancelled:false}`，
  通常是列出与取消之间 turn 已收尾的竞态）。该码由 CLI 本地产生，退出 1；重试一次通常得到
  `no active turn`（退出 0）。
- **`daemon.unreachable`**：`sessions list|export|cancel`、`run`、`provider list`、`models list` 无法连接
  由 dataDir 推导的 socket；先 `pisces status`，必要时 `start`。这些命令只经协议读取，不直接读会话文件
  或本地 provider 定义。
- **`run.default_system_prompt_unsupported`**：`--use-default-system-prompt` 只对新会话有效。对
  `--session`/`--continue` 选中的既有会话，`run` 在本地以该码退出 1，不修改会话；新会话去掉该选项或
  改用 `--system-prompt`。
- **`queue.invalid_control`**：`run --enable/--disable` 的 toggle 声明被 daemon 拒绝，例如手动模式
  （未装配扩展）的 daemon。退出 1，此时提示词未入队、turn 未启动、会话不会落盘；去掉 toggle 选项或用
  装配了扩展的 daemon 重试。
- **`run` 的失败 turn**：daemon 在 `turn.ended` 中只保留 `turn.empty`，其余失败投影为
  `internal.error: Turn failed`；`run` 原样转发该码与固定消息（人类模式写 stderr，`--json` 写进对象的
  `error`），不回显供应商或适配器原文。
- **`run` 被取消**：`turn.cancel` 后退出 130（不是 1）。在另一个终端 `sessions cancel` 与 Ctrl-C 的
  结果相同；需要区分成功与取消的脚本应按 0/130 判断。

## 8. 本阶段未交付

- `client list|start`、`providers check`、`auth`。
- `run` 的交互式 stdin 循环与多轮输入；本阶段只交付由位置参数驱动的单个非交互 turn。
- CLI 已装配目录驱动扩展：`start` 始终传 `extensions.configPath`，`run --enable` 与配置默认值可用。
  仍没有交互式配置编辑器、配置迁移工具、凭据文件，也没有 `extensions install/enable`（安装与
  更新由 npm/git 完成）。
- macOS 与 Windows：仅 Linux x64 已实现并验证。
- 多用户共享 dataDir、非本地（网络）socket、systemd 等进程管理器集成。

## 9. 安全与信任边界

- **没有沙箱**：daemon 以当前用户权限运行，工具（含内置 shell 工具）与扩展在 daemon 进程内执行；
  `start` 不提供隔离、权限降级或审批机制。
- **工作区扩展是代码**：在工作区运行 `pisces run` 会装配该工作区的 `.pisces/extensions/` 并遵循
  `.pisces/config.json` 的 `extensions`；仓库自带的 `.ts` 工具代码在模型调用时以 daemon 用户权限执行。
  没有沙箱也没有审批提示：只在你信任的工作区运行，或先清空该工作区的扩展选择与目录。
- **密钥信任**：密钥从 `start` 的环境变量进入 daemon 进程环境。同一用户的其他进程可通过
  `/proc/<pid>/environ` 读取它（能否读取取决于内核与 `/proc` 挂载策略）；安全边界是同一 uid，不是
  密钥本身。
- socket 权限为 `0600`，daemon 在读取任何协议字节前用 `SO_PEERCRED` 校验对端 uid 必须等于自身
  有效 uid；不一致只断开该连接，无降级认证。
- `dataDir` 含会话记录（可能含敏感内容）与日志；保持 `0700`，不要交给其他用户或放进共享目录。
- `daemon.log` 与 `status --json` 不输出密钥、变量名或 provider 配置；请勿手工把密钥写进
  `config.json`、pid 文件或命令行。

## 10. 验证状态

`packages/cli/test/run-e2e.test.ts` 在进程内真实 daemon（原生 transport、真实 Unix socket、真实
`SessionStore`）上验收非交互 `run`：daemon 默认工作区/供应商/模型下 `--print` 只输出最终文本并落盘会话；
`--json` 只输出一行对象；第二次 `--continue` 复用同一会话；失败 provider 使 turn `failed`、退出 1且
不输出成功文本（`--json` 对象含 `error`、stderr 为空）；挂起 provider 上注入 Ctrl-C 后真实
`turn.cancel` 让 turn 从 `turn.list` 消失并以 130 退出；daemon 停止后退出 1（`daemon.unreachable`）；
未装配扩展的 daemon 上 `--enable` 得到 `queue.invalid_control` 且不启动 turn。
`packages/cli/test/default-workspace-e2e.test.ts` 用 `buildDaemonOptions` 启动真实 daemon，验收全局
`defaultWorkspace` 生效、运行中的 daemon 在改写配置后让**新会话**立即使用新默认值（无需重启）、
`run --workspace` 覆盖默认，以及既有会话上本地拒绝 `--workspace`。构建后的 `dist/main.js` 子进程
另在同一进程内 daemon 上跑一次 `run ... --print` 并断言 stdout 与落盘会话。
`packages/cli/test/extensions-e2e.test.ts` 同样从 `buildDaemonOptions` + `startDaemon` 启动真实
daemon（真实 provider host 指向本机 OpenAI 兼容 SSE 服务器），经真实 socket 跑 `run`：配置
`extensions` 启用内置 shell 并真实执行 `printf tool-ok`、无 `extensions` 时 `run --enable` 成功、
`--config alt.json` 读取 alt 文件与 `dirname(alt.json)/extensions`、工作区 `.pisces/extensions`
中的工具可被发现并执行；会话记录与 provider 请求同时验证工具调用与真实命令输出。本地在
Node 26.13.0 x64 上通过；远端 CI 未运行。运行方式：

```bash
pnpm exec vitest run packages/cli/test/run-e2e.test.ts packages/cli/test/extensions-e2e.test.ts
```

真实进程验收测试 `packages/cli/test/cli-lifecycle.test.ts` 使用构建后的 `dist/main.js` 与真实后台
daemon，覆盖：

- `start` 退出 0、输出含 `running`、pid 记录指向子进程、socket 完成 `protocol.hello` 握手；
- 重复 `start` 退出 1 且为 `daemon.already_running`；
- `status` 退出 0，`status --json` 解析为 `{ "state": "running" }`；
- `daemon.log` 存在且不含密钥值；
- `stop` 退出 0 后记录消失、socket 不再应答、子进程不再存活；重复 `stop` 退出 0；
- 手写死亡 pid 记录被 `status`/`stop` 清理；
- 手写“存活但不应答”的记录（socket 路径为推导路径但无人监听）使 `stop` 退出 1 且保留文件；
- 手写记录指向另一个**确实应答**的 socket（pid 仍存活）时，`stop` 退出 1、保留文件、不杀该进程，
  外部 socket 仍然应答；
- 两个并发 `start` 恰好一个退出 0、另一个退出 1，只留一个 pid 记录，应答的 daemon 唯一。

运行方式（先构建原生插件与 dist）：

```bash
node packages/daemon/native/build.mjs
pnpm exec tsc -b tsconfig.build.json
pnpm exec vitest run packages/cli/test/cli-lifecycle.test.ts
```

模板命令的真实进程验收在同目录的 `packages/cli/test/templates-e2e.test.ts`（构建后的 CLI 启动真实
daemon，覆盖 `list`/`preview`/`apply`、无 `--confirm` 退出 2、`daemon.unreachable` 退出 1），
细节见 `docs/templates.md` §11。

`packages/cli/test/config-extensions-sessions-e2e.test.ts` 用同一构建产物与真实 daemon 验收本阶段
三组命令：`config set` 逐键生成统一全局文件后 `start`/`status` 成功；真实 `session.create` 使用
`defaults`，临时会话不在 `sessions list`，`turn.start` 落盘后出现且字段正确，`--json` 可解析；
`config unset defaults` 后重启仍可 `start`，但真实 `session.create` 返回 `session.model_required`；
`extensions list` 对真实内置/全局/工作区目录输出三种 origin 且不执行工具代码，坏 `entryConfig`
退出 2；daemon 停止后 `sessions list` 退出 1 且为 `daemon.unreachable`。`packages/daemon/test/
sessions-list-socket.test.ts` 另在真实 socket 上验收 `session.list` 的临时/已落盘语义与统一配置。
运行方式：

```bash
pnpm exec vitest run packages/cli/test/config-extensions-sessions-e2e.test.ts \
  packages/daemon/test/sessions-list-socket.test.ts
```

`packages/cli/test/providers-e2e.test.ts` 验收 `provider list` 与 `models list`：进程内真实 daemon
注册 `alpha`（2 个模型，其中一个带 `pricing`）与 `beta`（0 个模型），断言两条命令的人类输出、
`--json` 与真实 `provider.list` 结果一致、`--provider` 命中/空结果/未知 id（`provider.not_found`）、
daemon 停止后两者退出 1；并用构建后的 CLI 对 `pisces start` 起的真实 detached daemon 跑
`provider list --json` 与 `models list --json`。运行方式：

```bash
pnpm exec vitest run packages/cli/test/providers-e2e.test.ts
```

`packages/cli/test/sessions-export-cancel-e2e.test.ts` 在进程内真实 daemon（原生 transport、真实
Unix socket、真实 `SessionStore`）上验收 `sessions export` 与 `sessions cancel`：正常 provider 提交
节点后，全树导出逐行 `JSON.parse` 与 `session.read` 记录深度相等，分叉树上的 `--node` 只导出祖先
链且为全树的严格子集；挂起 provider 让 turn 保持 `running`，真实 CLI 取消后输出 `cancelled <turnId>`、轮询
`turn.list` 直到该 turn 消失，再次取消得到 `no active turn`；daemon 停止后两命令均退出 1
（`daemon.unreachable`）。构建后的 `dist/main.js` 子进程另在独立的进程内 daemon 实例上导出真实会话，
并在空闲会话上得到 `no active turn`（退出 0）。本地在 Node 26.13.0 x64 上通过；远端 CI 未运行。运行方式：

```bash
pnpm exec vitest run packages/cli/test/sessions-export-cancel-e2e.test.ts
```

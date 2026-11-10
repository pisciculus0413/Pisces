# CLI：本地 daemon 生命周期

本文件描述当前已实现、并已被真实 socket 与真实进程验收（真实 `dist/main.js`、真实后台 daemon、
真实 Unix socket 握手）覆盖的 CLI 子集：`start`、`status`、`stop`、`templates`、`config`、
`extensions list`、`sessions list|export|cancel`、`provider list` 与 `models list`，以及配置文件、
凭据来源、退出码、文件位置与失败恢复。
**未交付**的命令与平台在 §8 明确列出。权威契约见
`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §7.1、§7.2、§7.5、§8.6，
daemon 侧的安全边界见 `docs/daemon-linux.md`。

## 1. 支持范围

- 仅 Linux x64；Node.js `>=22.19.0`，ESM。
- 命令：`start`、`status`、`stop`、`templates list|preview|apply`、`config list|get|set|unset`、
  `extensions list`、`sessions list|export|cancel`、`provider list`、`models list`（模板细节见
  `docs/templates.md`，扩展配置见 `docs/extensions.md`）。没有 `run`、`client`、`providers check`、
  `auth`（见 §8）。
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
| `templatesDir` | 否 | 模板目录；绝对路径（支持 `~/`），`start` 作为第三个 argv 传给 daemon 子进程 |

- `defaults` 是 CLI 与扩展层共用的唯一默认 provider/model 键；旧的 `defaultProvider`/`defaultModel`
  已移除（pre-release 变更，无迁移）：出现时按未知键退出 2。
- 全局文件还允许扩展组的 `defaultWorkspace`、`extensions`、`entryConfig`。CLI 生命周期命令**接受
  但不校验、不使用**扩展键；daemon 的扩展加载器忽略 CLI 键。`config` 命令同时按两侧规则校验，
  因此它写出的全局文件对两个加载器都合法。
- 工作区 `<workspace>/.pisces/config.json` 只允许 `defaults`、`extensions`、`entryConfig`；出现
  `dataDir`、`providers`、`templatesDir` 或 `defaultWorkspace` 按未知键处理。
- 工作区 `defaults` 在全局文件可读且含 `providers` 时也校验其指向；全局文件缺失时只校验格式。
- 扩展键的语义见 `docs/extensions.md`。

- 未知键、类型错误、重复 `id`、相对 `dataDir` 均视为不合法，退出 2。
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
```

```console
$ pisces status --json
{"state":"running","pid":187181,"socketPath":"/home/me/.local/state/pisces/run/pisces.sock","dataDir":"/home/me/.local/state/pisces"}
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

JSON 只含 `state`、`pid`（仅进程存活的记录）、`socketPath`、`dataDir`；不含密钥、变量名或 provider
配置。

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
| `config get` / `config unset` 未命中（`config.key_not_found`）；`sessions list|export|cancel` / `provider list` / `models list` 连接失败（`daemon.unreachable`）；`sessions export|cancel`、`provider list`、`models list` 与人类模式的 `sessions list` 协议响应不合法（`client.protocol`；`sessions list --json` 与 `provider list --json` 原样透传、不做结构校验，但协议层/传输失败仍退出 1）；`sessions export` 的 `session.not_found` / `session.node_not_found`；`sessions cancel` 被拒绝（`turn.cancel_failed`）；`models list --provider` 未知 id（`provider.not_found`） | 1 |
| 已在运行 / 未知属主 / 启动失败 / 停止超时 / socket 无属主 / pid 记录写入或清除失败 | 1 |
| 用法错误、配置不合法、配置键未知、工作区不可用、缺少密钥、数据目录不可用 | 2 |

选项：

| 选项 | 说明 |
|---|---|
| `--config <path>` | 配置文件路径（所有命令接受） |
| `--data-dir <path>` | 覆盖 `dataDir`（生命周期、`templates`、`sessions list|export|cancel`、`provider list`、`models list`） |
| `--node <id>` | 只导出该节点的分支（仅 `sessions export`） |
| `--provider <id>` | 只列出该 provider 的模型（仅 `models list`） |
| `--scope <global\|workspace>` | `config` 的目标层，默认 `global` |
| `--workspace <dir>` | 工作区目录（`config --scope workspace`、`extensions list`） |
| `--json` | 机器可读输出：`status`、`templates`、`config list/get`、`extensions list`、`sessions list`、`provider list`、`models list` |
| `--help` / `--version` | 帮助/版本；可在第一个参数位置或任一命令参数位置使用（`wat --help` 仍是用法错误） |

未知命令（包括本阶段未实现的 `run` 等）打印 usage 并以 2 退出；`--config`、`--data-dir`、
`--node`、`--provider`、`--workspace`、`--scope` 缺少取值或其取值以 `-` 开头、`--json` 用于不支持的
子命令（含 `sessions export|cancel`）、`--node` 用于非 `sessions export`、`--provider` 用于
`provider list`（只有 `models list` 接受它）、以及 `--workspace` 与 `--scope global` 同用时，同样
按用法错误处理。

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
  `<dataDir>/run/pisces.sock`；目录不安全只会表现为探测失败（`unresponsive`/`unknown_owner`）。
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
- **`config.invalid`**：`start`/`status`/`stop` 以及 `sessions list|export|cancel`、`provider list`、
  `models list` 都需要可读配置（用于解析 `dataDir`）；修复配置文件后重试。
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
- **`daemon.unreachable`**：`sessions list|export|cancel`、`provider list`、`models list` 无法连接由
  dataDir 推导的 socket；先 `pisces status`，必要时 `start`。这些命令只经协议读取，不直接读会话文件
  或本地 provider 定义。

## 8. 本阶段未交付

- `run`（交互/`--print`/`--json`）、`client list|start`、`providers check`、`auth`。
- 配置文件中的扩展配置对 CLI 生命周期命令只是“接受并忽略”；CLI 尚不装配扩展，也没有交互式配置
  编辑器、配置迁移工具、凭据文件或扩展安装/更新。
- macOS 与 Windows：仅 Linux x64 已实现并验证。
- 多用户共享 dataDir、非本地（网络）socket、systemd 等进程管理器集成。

## 9. 安全与信任边界

- **没有沙箱**：daemon 以当前用户权限运行，工具（含内置 shell 工具）与扩展在 daemon 进程内执行；
  `start` 不提供隔离、权限降级或审批机制。
- **密钥信任**：密钥从 `start` 的环境变量进入 daemon 进程环境。同一用户的其他进程可通过
  `/proc/<pid>/environ` 读取它（能否读取取决于内核与 `/proc` 挂载策略）；安全边界是同一 uid，不是
  密钥本身。
- socket 权限为 `0600`，daemon 在读取任何协议字节前用 `SO_PEERCRED` 校验对端 uid 必须等于自身
  有效 uid；不一致只断开该连接，无降级认证。
- `dataDir` 含会话记录（可能含敏感内容）与日志；保持 `0700`，不要交给其他用户或放进共享目录。
- `daemon.log` 与 `status --json` 不输出密钥、变量名或 provider 配置；请勿手工把密钥写进
  `config.json`、pid 文件或命令行。

## 10. 验证状态

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

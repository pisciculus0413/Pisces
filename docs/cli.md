# CLI：本地 daemon 生命周期

本文件描述当前已实现、并已被真实进程验收（真实 `dist/main.js`、真实后台 daemon、真实 Unix socket
握手）覆盖的 CLI 子集：`start`、`status`、`stop`，以及配置文件、凭据来源、退出码、文件位置与失败恢复。
**未交付**的命令与平台在 §8 明确列出。权威契约见
`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §7.1、§7.2、§7.5、§8.6，
daemon 侧的安全边界见 `docs/daemon-linux.md`。

## 1. 支持范围

- 仅 Linux x64；Node.js `>=22.19.0`，ESM。
- 命令：`start`、`status`、`stop`。没有 `run`、`sessions`、`client`、`models`、`providers check`、
  `config`、`auth`、`extensions`、`templates`（见 §8）。
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

- 未知键、类型错误、重复 `id`、相对 `dataDir` 均视为不合法，退出 2。
- CLI 只暴露一种方言 `openai-chat`；`baseUrl` 必须能提供 OpenAI Chat Completions 兼容接口。
- `dataDir` 也可以用 `--data-dir <path>` 临时覆盖（必须是绝对路径；相对路径在 `start` 时以
  `daemon.insecure_directory` 退出 2）。

## 4. 凭据：只来自环境变量

- `start` 会逐个检查配置中每个 provider 的 `apiKeyEnv` 在当前环境中非空；缺任何一个就
  `error: config.missing_api_key: An API key is missing from the environment`，退出 2，且不启动、
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

JSON 只含 `state`、`pid`（仅进程存活的记录）、`socketPath`、`dataDir`；不含密钥、变量名或 provider
配置。

### `stop`

```console
$ pisces stop
stopped (pid 187181)
$ echo $?
0
$ pisces stop
not running
$ echo $?
0
```

`stop` 只在同一个 pid 仍存活、且本 dataDir 的 socket 完成握手后，才向该 pid 发送 `SIGTERM`；随后
最多等待 10 s 退出，成功才删除 pid 记录。已停止时重复 `stop` 是幂等的，退出 0。

| 命令 | 退出码 |
|---|---|
| 全部命令成功 | 0 |
| 已在运行 / 未知属主 / 启动失败 / 停止超时 / socket 无属主 | 1 |
| 用法错误、配置不合法、缺少密钥、数据目录不可用 | 2 |

选项：

| 选项 | 说明 |
|---|---|
| `--config <path>` | 配置文件路径 |
| `--data-dir <path>` | 覆盖 `dataDir` |
| `--json` | 机器可读输出，仅 `status` 接受 |
| `--help` / `--version` | 帮助/版本；可在第一个参数位置或任一命令参数位置使用（`wat --help` 仍是用法错误） |

未知命令（包括本阶段未实现的 `run`、`sessions` 等）打印 usage 并以 2 退出；`--config`、
`--data-dir` 缺少取值、其取值以 `-` 开头，或 `--json` 用于 `status` 以外命令时，同样按用法错误处理。

## 6. 文件位置

| 路径 | 内容 | 权限 |
|---|---|---|
| `<dataDir>/daemon.pid` | 单条 JSON：`{ "pid", "socketPath", "startedAt" }` | `0600` |
| `<dataDir>/daemon.log` | daemon 子进程 stdout/stderr（启动行、错误码） | `0600` |
| `<dataDir>/run/pisces.sock` | 本地 Unix socket | `0600` |
| `<dataDir>/run/pisces.lock` | daemon 单实例锁 | `0600` |
| `<dataDir>/sessions/` | 会话记录（由 daemon 维护） | 目录 |
| `<configDir>/pisces/config.json` | 本文件所述的配置 | 用户自定 |

- `dataDir` 必须存在或可创建、属于当前有效 uid、且不带 group/world 写位；CLI 以 `0700` 创建。
  不满足时 `error: daemon.insecure_directory: Data directory is not private`，退出 2。
- `daemon.log` 会记录 socket 路径与错误码，不会记录密钥。
- `stop` 后 `daemon.pid` 被删除；`run/` 与 `sessions/` 目录保留。

## 7. 失败与恢复

- **stale pid 文件**（记录中的进程已退出）：`status` 打印 `stopped (stale pid file)`（退出 1）并删除
  记录；`stop` 打印 `not running`（退出 0）并删除记录；`start` 直接回收该记录后启动。
- **pid 文件内容损坏**：视为无属主记录。`status`/`stop` 按未运行处理；`start` 在确认本 dataDir 的
  socket 不应答后清除该文件并正常启动。
- **`daemon.unknown_owner`**（进程存活、但 socket 不应答）：`start` 与 `stop` 都退出 1，**保留**
  pid 记录、不发送任何信号（防止 PID 复用误杀）。恢复步骤：
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
- **`config.invalid`**：`start`/`status`/`stop` 都需要可读配置；修复配置文件后重试。

## 8. 本阶段未交付

- `run`（交互/`--print`/`--json`）、`sessions list|export|cancel`、`client list|start`、
  `models list`、`providers check`、`config list|get|set|unset`、`auth`、`extensions list`、
  `templates list|preview|apply`。
- 配置文件中的扩展配置、默认工作区、会话级设置；CLI 配置只接受 `dataDir`、`providers`（及可选的
  `defaults`），其中 `defaults` 只被传给 daemon 作为协议会话的默认 provider/model，CLI 自身没有命令
  读取它。
- 凭据文件、密钥校验（`auth`）、扩展安装/更新、模板创建。
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
- 手写“存活但不应答”的记录使 `stop` 退出 1 且保留文件；
- 两个并发 `start` 恰好一个退出 0、另一个退出 1，只留一个 pid 记录，应答的 daemon 唯一。

运行方式（先构建原生插件与 dist）：

```bash
node packages/daemon/native/build.mjs
pnpm exec tsc -b tsconfig.build.json
pnpm exec vitest run packages/cli/test/cli-lifecycle.test.ts
```

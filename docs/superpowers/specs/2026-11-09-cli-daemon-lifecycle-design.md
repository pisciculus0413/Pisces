# CLI 守护进程生命周期：设计

**状态：待用户批准。批准后才写实施计划。**

## 1. 意图与原因

目前 Pisces 只能嵌入使用：宿主自己调 `startDaemon({dataDir, providers, providerHost})`，没有可执行的 `pisces` 命令，也没有配置文件/凭据装配。演示需要一个能后台常驻、可查询、可停止的本地 daemon，provider 使用 OpenAI 兼容的 key。因此先交付最小 CLI：`start` / `status` / `stop`，其余命令面（`run`、`sessions`、`providers check`、`config`、`auth`、`extensions`、模板）留待后续。

## 2. 目标 / 非目标 / 反目标

**目标**

- `pisces start` 以 detached 子进程拉起真实 daemon，就绪后返回 0。
- `pisces status` 报告运行状态（pid、socket、协议握手），运行中返回 0，否则 1。
- `pisces stop` 请求优雅停止，等待退出，清理 pid 文件；可重复执行。
- 一个最小 JSON 配置：dataDir、provider（OpenAI 兼容）、模型、key 的环境变量名。
- key 只从环境变量读取，不落盘、不进日志、不进 pid 文件。
- 同一 dataDir 只允许一个受 CLI 管理的 daemon。

**非目标**

- 不做 `run`/交互式对话、`sessions`、`providers check`、`config`、`auth`、`extensions`、模板。
- 不做 `CredentialStore`、OAuth、key 加密存储。
- 不做自动重启、崩溃拉起、日志轮转、systemd/launchd 集成。
- 不做脚本化就绪断言/CI 演示；等待与退出码只服务于人手动演示和基本正确性。
- 不做 Windows，也不做 macOS：daemon 自身在非 Linux 上以 `daemon.unsupported_platform` 拒绝启动，CLI 沿用该边界。

**反目标（能跑也算失败）**

- key 出现在配置文件、pid 文件、日志、`--json` 输出或进程参数里。
- `stop` 在无法确认进程身份时仍然发信号。
- 两个 `start` 指向同一 dataDir 却都成功。
- `status` 只看 pid 存活就报 running（进程可能已不是我们的 daemon）。
- 为了"能启动"绕过既有单实例锁、私有 run 目录或 peer 身份校验。

## 3. 约束

- 新包 `packages/cli`（`@pisces/cli`），依赖 `@pisces/core`、`@pisces/daemon`、`@pisces/protocol`；`bin: {"pisces": "dist/main.js"}`。
- 继续 `dev-pi` 顺序开发；不建 worktree、不 push/merge。
- 每次提交跑既有门禁 G；新增包纳入 `tsc -b` 与 biome。
- Core/daemon/protocol 的边界不变；CLI 可以读写本地文件与启动子进程。
- 子进程以当前用户身份运行，不加沙箱；配置与 pid 文件权限按 0600/0700 处理（dataDir 由 daemon 强制 0700，pid 文件写在 dataDir 内）。

## 4. 方案（已选定 A）

- **A. CLI 监督者 + pid 文件（选定）**：`start` spawn detached 子进程，父进程写 `<dataDir>/daemon.pid`、日志到 `<dataDir>/daemon.log`，轮询 socket 握手确认就绪；`status` 读 pid + 握手；`stop` 校验身份后 `SIGTERM` 并等待。daemon 代码不改，控制面全在 CLI。
- **B. daemon 自写 pid**：更"正统"，但要改 daemon host 的原子写、陈旧清理与锁语义，演示收益低、回归面大。
- **C. 仅前台运行**：代码最少，但演示不出"后台常驻"。

## 5. 设计

### 5.1 包结构与职责

```
packages/cli/
  package.json          # @pisces/cli, bin: pisces -> dist/main.js
  tsconfig.json         # extends 根配置，references core/daemon/protocol
  src/main.ts           # argv 解析、命令分派、退出码
  src/commands.ts       # start/status/stop 三个命令
  src/config.ts         # 配置读取与严格校验（纯函数，无进程副作用）
  src/credentials.ts    # 只读环境变量的 Credentials 实现
  src/lifecycle.ts      # pid 文件、进程探测、socket 握手、spawn/kill
  src/daemon-child.ts   # 子进程入口：装配 providers/providerHost 并 startDaemon
  test/*.test.ts
```

`main.ts` 不直接 `process.exit`；`run(argv, env, io)` 返回退出码，便于测试。IO 抽象只含 `stdout/stderr` 与 spawn/信号等最小 seam。

### 5.2 命令面

```
pisces start  [--config <path>] [--data-dir <path>]
pisces status [--config <path>] [--data-dir <path>] [--json]
pisces stop   [--config <path>] [--data-dir <path>]
pisces --help | --version
```

- `--config` 默认 `$XDG_CONFIG_HOME/pisces/config.json`，回退 `~/.config/pisces/config.json`。
- `--data-dir` 覆盖配置中的 `dataDir`；最终必须是绝对路径。覆盖值通过子进程第二个 argv 传入，父进程与子进程使用同一个已解析值（不靠子进程重读配置）。
- 用法/配置错误退出 2；运行时失败退出 1；成功 0。
- 人类可读输出；`status --json` 输出 `{state, pid?, socketPath?, dataDir}`（不含任何 key）。

### 5.3 配置

```json
{
  "dataDir": "/home/me/.local/state/pisces",
  "providers": [
    {
      "id": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": [
        { "id": "gpt-4o-mini", "contextWindow": 128000, "maxOutput": 16384, "modalities": ["text"] }
      ]
    }
  ],
  "defaults": { "provider": "openai", "model": "gpt-4o-mini" }
}
```

- 严格校验：未知键、缺失必填、重复 id/model、非法 URL/数值一律 `config.invalid` 文案（固定，不回显值）；dialect 固定为 `openai-chat`，不在配置暴露。`defaults.provider`/`defaults.model` 必须引用已声明的组合，否则同样 `config.invalid`。
- `apiKeyEnv` 是环境变量名；启动时父进程只检查它非空，不读取值到 CLI 可打印的状态里。
- `dataDir` 缺省 `$XDG_STATE_HOME/pisces`，回退 `~/.local/state/pisces`；必须是绝对路径，不存在时由 daemon 创建。
- 不读取其他配置来源；`defaults` 原样传给 `startDaemon`（字段形状以 `SessionDefaults` 为准，实施时核对）。

### 5.4 `start`

1. 读取配置；解析 dataDir；检查 `defaults` 引用；检查 `apiKeyEnv` 对应的环境变量存在且非空（否则退出 2，固定文案 `Missing API key environment variable`，不打印变量内容）。
2. 创建/校验 dataDir：`mkdir(recursive, 0700)` 后 `lstat` 校验目录、非符号链接、属主为当前 uid、无 group/world 写权限；不满足退出 2（`daemon.insecure_directory`）。以 `0600` 追加方式打开 `<dataDir>/daemon.log`。
3. **先探测**派生的 socket（`<dataDir>/run/pisces.sock`，由 runtime 规则推导）：
   - 握手成功 → 退出 1，`daemon.already_running`（包括无 pid 文件的嵌入宿主）。
   - 无响应且 pid 文件中的进程不存在 → 清理陈旧 pid 文件。
   - 无响应但 pid 进程存活 → 退出 1，`daemon.unknown_owner`，不 spawn。
4. `spawn(process.execPath, [childEntry, configPath, dataDir], {detached:true, stdio:["ignore", logFd, logFd], env: process.env})`；`childEntry` 由 CLI 自身模块 URL 推导（`dist/daemon-child.js`）。
5. 以 `open(pidFile, "wx", 0600)` 写入 `{pid: child.pid, socketPath, startedAt}`；`EEXIST` 说明并发 `start` 已抢先，终止本子进程并退出 1（`daemon.already_running`）。不使用 tmp+rename，避免覆盖他人的 pid 文件。
6. 轮询（间隔 50 ms，上限 10 s）同时检查：子进程是否已退出（`exitCode !== null`）、pid 文件 pid 是否仍等于 `child.pid`、socket 握手是否成功。三者在窗口内同时成立则打印 `running (pid …, socket …)` 返回 0。子进程提前退出或超时 → `SIGTERM` 子进程、清理本进程写入的 pid 文件、退出 1（`daemon.start_failed`），并提示日志路径；日志里有子进程写下的安全错误码，父进程不解析日志。

### 5.5 `status`

- 无 pid 文件 → `stopped`，退出 1。
- pid 不存在 → `stopped (stale pid file)`，删除 pid 文件，退出 1。
- pid 存活 + 握手成功 → `running`，退出 0。
- pid 存活 + 握手失败 → `unresponsive`，退出 1，不删除 pid 文件（可能仍在启动/停止）。
- `--json` 输出结构化状态；状态判断与人类输出同源。

### 5.6 `stop`

- 无 pid 文件 → `not running`，退出 0（幂等）。无 pid 文件但 socket 仍在响应 → `unmanaged daemon`，退出 1，不杀。
- pid 文件陈旧（进程不存在）→ 清理文件，退出 0。
- pid 存活但握手失败 → 拒绝发信号，退出 1（`daemon.unknown_owner`），提示人工检查；恢复手段是人工确认后删除 pid 文件（文档写明）。
- 身份确认（pid 存活 + socket 握手成功）→ `SIGTERM`，轮询进程退出，上限 10 s；退出后删除 pid 文件，返回 0。
- 超时 → 退出 1（`daemon.stop_timeout`），不发送 `SIGKILL`，保留 pid 文件与日志供排查。
- 子进程自身的 `SIGTERM`/`SIGINT` 处理：调用 `host.stop()`，成功退出 0，失败退出 1。

### 5.7 子进程装配（`daemon-child.ts`）

- argv 收配置路径与已解析的 dataDir；不通过命令行传 key。
- 构造 `createProviderManagement()`，对每个 provider 注册 `{id, dialect:"openai-chat", baseUrl, auth:{type:"apiKey", credentialRef:<id>}, models, headers?}`，注册一次 `openai-chat` 方言（`openAiChatAdapterFactory`）。
- `Credentials`：`get(ref)` 返回配置中该 provider 的 `apiKeyEnv` 对应环境变量值（缺失返回 undefined）；`refresh` 无刷新能力，抛固定 `provider.credentials_unavailable`（实施时核对既有错误码）。
- `ProviderHost`：`createProviderHost({providers, credentials})`，fetch 用全局。
- `startDaemon({dataDir, providers, providerHost, defaults})`；忽略 `SIGPIPE` 的默认行为不需要改。
- 就绪由父进程握手判定，子进程不打印解析用的标记；日志只写启动/停止/错误的安全摘要（无 key、无提示词）。

### 5.8 错误与安全

- 固定安全文案 + 稳定码：`config.invalid`、`daemon.already_running`、`daemon.unknown_owner`、`daemon.start_failed`、`daemon.stop_timeout`；不打印文件内容、URL 凭据或环境变量值。
- pid 文件与日志都在 `<dataDir>`（daemon 会强制该目录 0700）；pid 文件 0600。
- 配置文件权限不强制检查（用户自担），但 key 不在其中。
- `stop` 只在"同一 pid + 该 dataDir 的 socket 能完成协议握手"时发信号，避免 PID 复用误杀。
- 日志追加写，不轮转；`stop` 不清日志。子进程失败时向日志写一行安全码（不含密钥/配置内容），父进程只把日志路径给用户。
- 并发 `start` 由 socket 预探测 + `O_EXCL` pid 文件 + 子进程存活校验三者共同防止；pid 文件写入者失败时绝不覆盖已有文件。

### 5.9 验证

- 单元：配置解析（合法/未知键/重复/非法 URL/缺省 dataDir）、pid 文件读写与陈旧判定、状态机（stopped/running/unresponsive/unknown_owner）用注入的进程/socket 替身。
- 集成（真实文件系统 + 真实子进程）：临时 dataDir + 临时配置（provider 指向不可达的假 baseUrl，启动不需要网络）→ `start` 返回 0 且 socket 可握手 → 重复 `start` 退出 1 → `status` 退出 0 → `stop` 退出 0 且 pid 文件消失 → 再 `stop` 退出 0；另测陈旧 pid 文件清理、"pid 存活但 socket 不通"拒绝停止、并发 `start` 只有一个成功、`--data-dir` 覆盖与子进程实际绑定一致。
- 日志断言：不含 key 值。
- 门禁 G + 聚焦套件；远端 CI 未运行需如实标注。

## 6. 留给实施者

- `provider.credentials_unavailable` 是否已有既有码；没有则用最近的既有码并记录。
- `daemon.insecure_directory`/`daemon.already_running` 等码在 CLI 输出中的确切用法（保持固定文案即可）。
- 子进程向日志写"安全码"的具体格式（一行 JSON 或 `error: <code>`），只要不含密钥与配置值。
- 日志 fd 的打开方式（`open` + `append`）与关闭时机。
- 握手客户端的最小实现（复用 `@pisces/protocol` 的 `encodeFrame`/`createNdjsonDecoder`，不新增协议方法）。
- 集成测试是否依赖 `tsc -b` 产物；若依赖，明确构建前置并在报告中记录。

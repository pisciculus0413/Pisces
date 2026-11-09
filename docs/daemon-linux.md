# Linux 本地 daemon 运维说明

本文件说明本阶段 Linux 本地 daemon 的构建前提、程序化启动方式、安全边界与停止失败时的运维处置。权威契约见
`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §§3.1–3.9、5.1、5.3、5.9。

## 支持范围

- 仅 Linux x64；Node.js `>=22.19.0`，ESM。
- 本阶段**没有** CLI、`run` 命令或配置文件加载器。宿主由嵌入程序调用
  `startDaemon(...)` 启动，provider、工具与默认值由调用方传入。
- macOS 与 Windows 在导入原生绑定、绑定 socket 之前以 `daemon.unsupported_platform`
  失败；两者均不是当前实现，Windows 命名管道为目标设计。
- 本地只在 Node 26.13.0 x64 上验证。CI 配置了 Node 22.19.0 / 24 / 26 x64，但本阶段
  未 push，因此这三个远端矩阵结果均**未验证**，不得当作已通过。

## 构建

前置条件：Linux、C 工具链（`gcc`/`make`/`python3`）与 Node 头文件下载能力。原生插件**不会**在
安装时自动编译：安装后必须显式执行下方的 `build:native`，按当前 Node ABI 编译，不下载预编译二进制。

```bash
pnpm install --frozen-lockfile
pnpm --filter @pisces/daemon run build:native   # 固定 node-gyp 12.4.0
pnpm run build                                  # tsc -b，生成 dist/
```

- 原生源码为 `packages/daemon/native/binding.c`（plain C Node-API）；构建产物复制到被忽略的
  `packages/daemon/native/peercred.node`。`src/` 与 `dist/` 解析同一路径，因此不需要分别构建。
- 每次切换 Node 版本都必须重新执行 `build:native`：产物与 Node ABI 绑定。
- 完整测试与子进程 fixture 依赖 `dist/` 和 `.node` 产物；直接 `vitest run` **不会**自动构建它们。
  在全新检出上先执行原生与 TypeScript 构建，再运行测试。
- 缺少 `.node`、`node-gyp` 未安装或编译失败时，`startDaemon` 以
  `daemon.native_unavailable` 失败；不存在降级认证路径。
- 冷 CI 上 `node-gyp` 需要下载对应 Node 头文件。

验证命令（每次提交前）：

```bash
node_modules/.bin/vitest run
node_modules/.bin/tsc -p tsconfig.json
node_modules/.bin/tsc -b tsconfig.build.json
node_modules/.bin/biome check .
```

## 程序化启动

```ts
const host = await startDaemon({
  dataDir: "/absolute/private/dir",
  providers,
  providerHost,
  // defaults / createTools / entries / skills / sources 等既有可选项
});

host.socketPath;          // <dataDir>/run/pisces.sock
host.initializationIssues;
host.recoveryIssues;
host.status();            // { state: "running" | "quiescing" | "stopped", activeTurns }
await host.stop();
```

- `dataDir` 必须是绝对路径，存在或可创建，属主为当前有效 UID，且组/其他用户不可写；
  目录不存在时以 `0700` 创建。`dataDir/run` 必须为属主 `0700`，既有的符号链接或不安全模式
  直接拒绝，不会 chmod 修复。
- host 用同一个 `dataDir` 构造 `SessionStore`、`ActiveTurnStore`、`EventBus`、`Concurrency`、
  `Gateway` 与监听器；公开 API 不接受外部 store/marker 注入，避免锁路径与存储路径不一致。
- 启动顺序：平台与 `getuid() === geteuid()` 检查 → 私有运行目录 → `run/pisces.lock` 的
  `flock` → 原生 peer 凭据自检 → 陈旧 socket 处理 → `bootstrapGateway`（存储初始化与 turn 恢复）
  → 绑定并校验 `pisces.sock` → 接受连接。任何一步失败都按逆序关闭已获取资源，并保留锁文件本身。
- 单实例由锁保证：第二个进程以 `daemon.lock_busy` 失败，且不会删除存活实例的 socket。

## 安全边界

- 认证在同用户内：accept 的 socket 以 `pauseOnConnect` 暂停，先通过原生
  `getsockopt(SOL_SOCKET, SO_PEERCRED)` 取内核 peer UID，与 `process.geteuid()` 比较，
  通过后才挂载 NDJSON 解析器并 `resume()`；失败只销毁该连接，不发送任何协议字节。
- 无 chmod-only 或未认证回退。Node 的 accepted `net.Socket` 没有公开 peer UID API，
  实现把**未文档化**的 `socket._handle.fd` 访问隔离在单一适配器中。
- 启动时在持锁后、绑定 `pisces.sock` 之前，用 `dataDir/run` 下的私有临时路径做一次有界
  自连接能力探测；结果必须是同 UID。探测路径按 inode 校验后清理；失败启动以
  `daemon.peercred_probe_failed` 或 `daemon.native_unavailable` 拒绝启动。
- 原生 `bindUnixListener(path)` 创建并 listen socket，Node 用 `server.listen({ fd })` 接管，
  因此 Node 不持有路径名、也不会在 `server.close()` 时自动 unlink 路径。路径清理只由
  身份校验后的 quarantine 流程负责；不要改回按路径 `listen`，否则可能删除被替换的路径。
- socket 为 `0600`，绑定后以 `lstat` 校验类型、属主与模式；Unix 路径编码长度上限 107 字节。

## 连接与协议限制

- NDJSON，仅字面 `LF` 分帧；`\r` 属于帧内数据。帧上限 8 MiB（含结尾 LF）。
- 响应与事件序列化负载各上限 4 MiB；单连接出站队列默认上限 8 MiB。
- 握手前最多同时 64 个连接，每个连接 5 秒内必须完成 `protocol.hello`；认证后的流式 turn
  没有空闲超时。任何业务方法成功分派前必须先完成 `protocol.hello`；握手前发送其他方法会收到 `protocol.hello_required`，连接仍可随后握手。版本不匹配的错误刷出后关闭连接。
- 无法关联 `id` 的错误响应使用 `id: ""` 哨兵；不回显原始输入。
- 订阅是连接级的：`session.subscribe` 在校验会话后才安装订阅，`session.unsubscribe` 只移除
  当前连接；断线或退订不中止 turn。事件不重放，客户端先订阅再 `session.read`，以首个
  `session.read.seq` 为水位。
- 队列溢出、写错误或超限事件只关闭该连接并解除其订阅，turn 继续运行；客户端重连后重新订阅并读取。
- 未识别的方法返回 `protocol.unknown_method`；没有连接上下文时
  `session.subscribe`/`session.unsubscribe` 也按未知方法处理。

## 停止与失败处置

`stop()` 的顺序：同步置 `quiescing` 并阻断新帧 → 停止 accept → 等待已受理请求（含客户端已断开
的请求，5 秒）→ `Concurrency.cancelAll(5000)` 并等待取消与标记清理、注销 → 要求
`activeTurns().length === 0` → 关闭/解除连接 → 关闭监听器并按 inode 清理 socket → 释放锁 →
dispose `Gateway` → `stopped`。成功返回后 `stop()` 幂等。

以下任一情况以 `daemon.stop_incomplete` 失败：已受理请求 5 秒内未结算、仍有登记 turn（含
`turn.cleanup_failed` 的残留标记）、标记删除失败、监听器/锁释放失败。

失败时**不会**强制清理：

- 进程保持 `quiescing`，锁与标记仍被持有，socket 与 `Gateway` 按其实际状态保留；
- 已登记 turn 可能仍在运行；再次 `stop()` 会重试同一顺序，但在进程终止/重启恢复前可能持续失败；
- 不自动杀进程。中止进程是操作者的独立显式动作；终止后下一次启动按 Plan B 标记恢复处理中断 turn；
- 锁文件不在停止时 unlink（inode 复用会分裂所有权）；进程退出后 `flock` 自动释放；
- 清理失败或崩溃可能留下 `pisces.sock.stale-<pid>-<uuid>` 隔离项。只在确认没有存活 daemon 时
  人工检查并删除；不要盲目按路径复用或删除不属于自己的 socket。

启动错误的稳定代码：`daemon.unsupported_platform`、`daemon.native_unavailable`、
`daemon.peercred_probe_failed`、`daemon.lock_busy`、`daemon.lock_failed`、
`daemon.insecure_directory`、`daemon.socket_live`、`daemon.socket_path_too_long`、
`daemon.start_failed`。停止失败统一为 `daemon.stop_incomplete`。原始原生 errno、路径与
cause 不进入响应或事件。

## CI

`.github/workflows/linux-daemon.yml` 在 `ubuntu-24.04`（x64）上以 Node 22.19.0 / 24 / 26
矩阵执行：`pnpm install --frozen-lockfile`（pnpm 12.8.1）→ 原生构建 → `tsc -b` →
两次 `tsc` 校验 → Biome 格式化与 lint → 完整 Vitest → Core 与 protocol 两条边界扫描。
扫描把 ripgrep 的退出码 1（无匹配）视为通过，退出码 2 视为失败，而不是用 `if rg` 把两者
都当作通过。

测试中的 peer 凭据用例覆盖真实自连接、注入的 UID 不一致、缺失/invalid fd 与原生错误；外部属主 socket 用例仅在 root 下运行，普通用户下跳过。真实跨 UID 回归另见下节；它不是跳过项。

### 真实跨 UID 回归与前置条件

`packages/daemon/test/unix-transport.test.ts` 用真实的不同宿主 UID 客户端验证拒绝路径，
`packages/daemon/test/fixtures/cross-uid-client.mjs` 是只依赖 Node 内建模块的子进程 fixture：

- 测试以 `unshare --map-auto --user --setuid 1 --setgid 1` 启动该 fixture；`--map-auto` 使用
  `/etc/subuid`、`/etc/subgid` 的从属 ID 区间，因此子进程在父命名空间中有一个与 daemon
  不同的宿主可见 UID。
- 先做独立预检：一次性测试目录内另起 socket，用生产原生 `SO_PEERCRED` 读取器观察该子进程的
  真实 peer UID，必须不等于 `process.geteuid()`（本机为 euid 1000、peer 100001；数值随环境
  变化，断言只比较是否相等）。子进程自己打印的命名空间 UID 不作为证据。
- 预检通过后才启动使用**生产默认**原生读取器（不注入 `peerUidFor`）的监听器；仅在
  `start()` 完成绑定与 `0600` 校验**之后**，才把一次性测试目录改为可穿过、socket 改为可连接，
  使内核凭据校验而非 DAC 成为拒绝原因。子进程连接时立即写入数据，断言连接被关闭、认证处理
  函数未被调用、子进程未收到任何协议字节；随后同 UID 客户端仍须正常到达处理函数。
- 前置条件：util-linux `unshare`（支持 `--map-auto`，通常 >= 2.38）、用户可用的从属 ID 区间，
  以及 setuid 的 `newuidmap`/`newgidmap`。任一缺失，或宿主观察到的 peer UID 与 daemon UID
  相同，测试都以显式配置错误**失败**而不是跳过，因此 Linux CI 必须提供该映射。
- 单独的 `unshare -Ur` 不产生宿主可见的 UID 差异（内核把子进程映射回父 UID），不能作为跨 UID
  证据；本回归测试不使用它，也只在本机验证过，远端 Node 矩阵仍未运行。

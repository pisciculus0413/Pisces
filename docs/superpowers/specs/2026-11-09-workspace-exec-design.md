# WorkspaceAccess / ExecHost 与首个内置 shell 工具：设计

**状态：待用户批准。批准后才进入 writing-plans。**

## 1. 意图与原因

框架已交付 core、daemon、扩展系统（Plan A/B），但**没有任何自带工具**：模型能对话，不能读写工作区或执行命令；同时扩展工具拿到的是 `workspace` 路径字符串，没有任何受控访问手段。DDS §5.7 已定义 `WorkspaceAccess`/`ExecHost`，但至今无实现、无消费者。

本阶段交付这两个服务，并用一个真实消费者验证接口：`extensions/builtin/shell` 中的最简 shell 工具。这样接口在真实链路（发现 → 声明 → 确认 → 调用 → 工具结果落库）里被用过一次，而不是先写死再等模板阶段返工。

## 2. 目标 / 非目标 / 反目标

**目标**

- 实现 `WorkspaceAccess`：工作区根内路径解析、目录创建、读写、存在性检查；越界或越界符号链接拒绝。
- 实现 `ExecHost`：不经 shell 的 `spawn` 执行、超时与 abort 终止、输出上限截断、受控环境变量。
- 扩展 `ToolInvocationContext`，让工具经契约拿到 `files`/`exec`，宿主保留策略控制权。
- 交付 `extensions/builtin/shell`：`package.json` + `tools/shell.ts` + sidecar，作为内核自带的第一个可选项。
- 真实 socket 端到端证明：选择 shell → 确认 → invoke → 工具结果节点。

**非目标**

- 不做沙箱、不做容器、不做权限降级。
- 不做文件类工具（读/写/编辑/搜索），只做 shell。
- 不做流式输出、交互式 stdin、PTY。
- 不做进程组/子孙进程管理，不做跨平台（Linux daemon only）。
- 不做模板（`TemplateStore`/`ExecHost` 的模板用法留到模板阶段）、凭据、CLI。
- 不默认启用 shell：出现在清点里，必须被显式选择。

**反目标（即使能跑也算失败）**

- 工具能通过 `context.workspace` 字符串自行绕过访问限制，而宿主以为已受控。
- shell 继承 daemon 的敏感环境变量、凭据或 socket 路径。
- 输出无上限，撑爆 256 KiB 节点预算或 4 MiB 响应。
- 超时/取消后留下子进程。
- 为了“能跑”放宽既有认证、停止保锁或扩展身份语义。

## 3. 约束

- 沿用 `dev-pi`、顺序开发；不建 worktree、不 push/merge。
- Core 保持无文件/环境 I/O、不依赖 daemon/protocol；服务实现只在 daemon。
- 每次提交运行既有门禁 G（原生构建、两次 tsc、完整 Vitest、Biome、两项边界扫描、`git diff --check`）。
- 扩展只能通过 `ToolInvocationContext` 拿到能力，不直接 import daemon 内部实现；`@pisces/*` 宿主映射与入口摘要校验不变。
- 既有 A/B 语义不变：声明 all-toggle、确认前不执行、stale 不执行、不持锁执行工具。

## 4. 方案与取舍（已在对话中选定）

1. **注入方式**：保留 `workspace: string`，新增可选 `files?: WorkspaceAccess`、`exec?: Exec`（选 A）。替换成对象会破坏 HLD §6.3 已公开契约；新增可选字段向后兼容，旧宿主/旧扩展行为不变。
2. **shell 形态**：`command: string` 经 `/bin/sh -c` 执行，可选 `cwd`、`timeoutMs`（选 A）。argv 形式更“可控”，但失去 shell 语义且参数拼装成本转移给模型。
3. **放置**：真实扩展包 `extensions/builtin/shell`（选 A）。daemon 内置注册会绕过刚验收的扩展链路，无法验证发现/惰性装载/声明。
4. **默认启用**：否。config 的内置默认 `extensions` 为空，用户需显式选择；测试与文档给选择示例。

## 5. 设计

### 5.1 Core 契约（`packages/core/src/exec/types.ts`，经 index 导出）

```ts
interface WorkspaceAccess {
  resolve(path: string): string;                  // 返回工作区内绝对路径
  ensureDirectory(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;        // UTF-8
  exists(path: string): Promise<boolean>;
}

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ExecResult { exitCode: number; stdout: string; stderr: string }

interface Exec {
  run(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}
```

- `ExecResult` 增加内部字段 `stdoutTruncated`/`stderrTruncated: boolean`（默认 false），供工具区分“完整输出”与“被截断”。
- 错误：路径越界抛内部 `PiscesError("workspace.path_outside", <固定文案>)`；I/O 失败抛 `PiscesError("storage.io", ...)`。两者都不携带路径或原始 errno 文案到线上（`Gateway` 本就只转发 code/message）。exec 的非零退出**不抛**。
- `ToolInvocationContext` 增加 `files?: WorkspaceAccess; exec?: Exec;`。`Tools.invoke` 原样转发存在的字段，不凭空构造；缺省时工具必须自行安全失败。

### 5.2 驱动与 Gateway 接线

- `RunTurnInput` 增加可选 `files?: WorkspaceAccess; exec?: Exec`；driver 构造 `ToolInvocationContext` 时透传；`context.ts` 的来源解析上下文不变。
- `GatewayDeps` 增加可选 `createWorkspaceAccess?: (workspace: string) => WorkspaceAccess` 与 `exec?: Exec`（测试注入用）；缺省由 Gateway 用 daemon 真实实现构造。
- `WorkspaceAccess` **在 `turn.start` 内构造**（不在同步的 `createRuntime` 里）：先 `realpath(meta.workspace)` 得到 canonical root，成功则 `createWorkspaceAccess(root)` 并在 runtime 上缓存；失败则本次 turn 不注入 `files`（`exec` 不受影响），工具安全失败为固定 `tool.failed`，`session.read`/队列等既有行为不变。配置模式下工作区消失已由 `preparePersistedBinding` 提前返回 `session.invalid_workspace`，此降级只影响手动注入模式。
- 注入的 root 恒为已 canonical 的绝对路径；`createWorkspaceAccess` 不对收到的字符串再做一次 realpath 作为根。
- `Exec` 为 daemon 级无状态单例。
- `RunTurnInput` 里的 `files`/`exec` 一并传入，driver 只透传。

### 5.3 `WorkspaceAccess`（`packages/daemon/src/workspace/access.ts`）

- `createWorkspaceAccess(root)`：`root` 必须已是绝对 canonical 路径（由 Gateway 传入 `realpath` 结果）。
- `resolve(path)`：
  1. 类型必须是字符串、非空、无 NUL；
  2. 拒绝绝对路径与盘符形式；
  3. 按段折叠 `.`/`..`，任何使深度为负的 `..` 立即 `workspace.path_outside`；
  4. 对**已存在**目标用 `realpath` 校验仍在 root 内；对不存在的目标，取最深的已存在祖先 `realpath` 后与剩余段拼接，再校验 containment；
  5. 返回 root 内的绝对路径（不跟随最终符号链接到 root 外）。
- `ensureDirectory` 逐级 `mkdir`（`recursive`），每级先在父目录 `resolve`。
- `writeFile`：先 `ensureDirectory(dirname)` 再写 UTF-8；不自动创建 root 之外任何目录。
- `readFile`：仅读取，不跟随越界符号链接（同上 resolve）。
- `exists`：对越界路径直接抛 `workspace.path_outside`（不是返回 false），避免把越界探测伪装成“不存在”。
- 不做大小限制（工具/模板自行限制）；不做原子写（模板阶段再定）。

### 5.4 `ExecHost`（`packages/daemon/src/exec/exec-host.ts`）

- `createExecHost(options?)`：`spawn(command, args, { cwd, env, stdio: ["ignore","pipe","pipe"] })`，不经 shell、不解析字符串。
- 环境：只传 `env` 参数显式给出的键，另加基础 `PATH`（默认 `/usr/local/bin:/usr/bin:/bin`）；**不继承** `process.env` 其他键；不传 `HOME`、`PWD`、socket 路径或任何 daemon 状态。
- 默认超时 `120_000 ms`；`timeoutMs` 允许 1..`600_000`，越界截断到范围内（不报错）。
- 超时或 `signal` abort：向直接子进程发送 `SIGKILL`，不管理子孙进程。完成判定有界：正常路径等待 `close`；若收到 `exit` 后 `1_000 ms` 内仍未 `close`（例如子孙继承管道），立即 `destroy` 两个流并按已收集输出 resolve。超时/abort 同样走该路径，并在内部标记 `timedOut`/`aborted`。这样 `daemon.stop()` 的 5 s `cancelAll` 不会因管道未关而失败收尾。
- daemon 被强杀时子进程可能残留；本阶段不做存活子进程登记，文档如实说明。
- 输出：每个流最多保留 `65_536` 字节，按 UTF-8 边界截断，截断时置对应 `*Truncated`；持续读取但丢弃超出部分（不缓存全量）。
- stdin 立即关闭；非零退出码正常返回。
- `spawn` 失败（ENOENT/EACCES 等）：抛 `PiscesError("storage.io", "Command could not be started")`，不带原始文案。

### 5.5 shell 工具（`extensions/builtin/shell/`）

- `package.json`：`{ "name": "@pisces/builtin-shell", "private": true, "type": "module", "pisces": { "tools": ["tools/shell.ts"] } }`。
- `tools/shell.ts`：默认导出 `ToolFunction`；`tools/shell.ts.meta.json` 声明 `name: "shell"`、描述与 parameters。
- 参数（JSON Schema）：`command`（string，必填，1..65536 字符）、`cwd`（string，可选）、`timeoutMs`（integer，可选）。
- 行为：
  1. 校验参数；不合法返回 `isError: true`、`code: "tool.failed"`、固定文案（不回显参数）。
  2. `const cwd = args.cwd === undefined ? context.workspace : context.files.resolve(args.cwd)`；无 `files`/`exec` 时安全失败（固定文案 `Execution host is unavailable`）。
  3. `exec.run("/bin/sh", ["-c", command], { cwd, signal: context.signal, timeoutMs })`。
  4. 结果内容：`exit code: N`、stdout、stderr 各一个 text 块；被截断的流附加 `[truncated]`；`exitCode !== 0` 或超时/abort 标 `isError: true`。
  5. 不拼接、不解释 `command`，不读配置文件，不访问网络。
- 清点名称：`@pisces/builtin-shell#shell`；默认不启用。

### 5.6 错误与安全边界

- 新增内部码 `workspace.path_outside`（加入 DDS §3.9，标注“内部码，不透传线上”）；工具把越界映射为 `tool.denied` 固定文案。
- shell 遵守“不是沙箱”的既有声明：命令以 daemon 进程身份运行，可越过 `WorkspaceAccess` 的限制；`files` 只约束经契约访问的路径。文档在 `docs/extensions.md` 明确写出。
- 不继承 daemon 环境；不传 `TURN`/`SESSION`/socket 路径。
- 工具结果仍受 driver 的 256 KiB 节点限制；`exec` 的 64 KiB/流上限保证不会先撑爆。

### 5.7 文档同步

- HLD §6.3：`ToolInvocationContext` 增加 `files`/`exec`（可选）与语义（宿主注入、缺省安全失败）。
- DDS §5.7：标记 `WorkspaceAccess`/`ExecHost` 为已实现，补实际边界（root canonical、存在的祖先 realpath、env 白名单、超时/abort、64 KiB 截断、子进程组限制）。
- DDS §3.9：新增 `workspace.path_outside` 内部码。
- `docs/extensions.md`：新增内置 shell 章节（选择示例、参数、无沙箱警告、输出上限、未默认启用）。
- 不宣称模板、CLI、其它工具可用。

## 6. 验证

- Core 单测：`Tools.invoke` 透传 `files`/`exec`，缺省时不构造。
- WorkspaceAccess 单测：`..`/绝对路径/符号链接越界拒绝；深目录创建；读写；不存在路径允许创建；越界 `exists` 抛错。
- ExecHost 单测：退出码与双流；超时与 abort 杀进程且保留部分输出；持有管道的子孙不阻塞收尾（1 s 兜底）；env 不含宿主变量；64 KiB 截断与 UTF-8 边界；stdin 已关闭；argv 不经 shell（`echo` 与 `;` 不解释）。
- shell 工具单测：正常/非零/超时/越界 cwd/缺宿主/参数非法/截断标记。
- 真实 socket 端到端：`startDaemon({extensions:{configDir, builtinDir}})` → 创建会话选择 `@pisces/builtin-shell#shell` → 确认 → 假 provider 发起工具调用 → 工具结果节点含真实输出 → 未选择时不进 `request.tools`。
- 门禁 G + 聚焦套件；远端 CI 未运行需如实标注。

## 7. 留给实施者

- 具体文件拆分、测试组织与 TDD 顺序（在计划阶段决定）。
- `ExecResult` 内部字段的命名细节与是否对外暴露（默认不进入协议）。
- `WorkspaceAccess.exists` 在 I/O 错误（非 ENOENT）时的返回/抛出选择，需在实现时按“越界抛、I/O 抛 storage.io”统一。
- shell 结果文案的精确措辞（固定、无参数回显即可）。
- 是否需要 `HOME=/tmp` 一类可选覆盖；默认不给，除非实现时发现 `/bin/sh -c` 必需。
- 子进程 `exit`/`close` 兜底的具体毫秒数（默认 1000 ms）可按实测调整，但必须是有限值。

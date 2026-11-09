# Extensions Selection：完成交接（A + B）

**状态：B 完成。A（Tasks 1–6）与 B（Tasks 7–11）均已代码验收、独立任务审查与阶段整体审查通过。当前无后续授权工作；不 push/merge，不自动开始新阶段。**

本文件是最终恢复入口：只读本文件、设计、Plan A/B 即可工作，不需要恢复旧对话。所有子智能体继续显式使用 **`deepseek-flash`**。

## 1. 仓库、验收 SHA 与环境

| 项目 | 实际值 |
|---|---|
| 分支 / 工作树 | `dev-pi`，干净；不建 worktree、不向 main 提交、不 push/merge |
| **A 代码验收 SHA** | **`e57f793f6d746759d67122a134ca1c24c7c7c52`**（A 范围整体审查与 READY 交接 `189f0ff`） |
| **B 代码验收 SHA** | **`ce1281d5f9138db4e9adfa9b5ec496ebbc0be029`**（本交接文档提交在其后，不自引自身 SHA） |
| A 验收仍是 B 的祖先 | `189f0ff` 与 `e57f793` 均为 B 验收 HEAD 的祖先 |
| 计划索引 / 门禁 G | [共同门禁与执行约束](../plans/2026-11-09-extensions-selection.md) |
| 计划 | [Plan A：Tasks 1–6](../plans/2026-11-09-extensions-selection-a-foundations.md)、[Plan B：Tasks 7–11](../plans/2026-11-09-extensions-selection-b-integration.md) |
| 设计 | [已批准设计](../specs/2026-11-09-extensions-selection-design.md) |
| 契约文档 | [扩展系统与透明选择](../../extensions.md) |
| 环境 | Node v26.13.0、pnpm 12.8.1、Linux x86_64 |
| 远端 CI | **从未运行**；不得声称通过或跨版本矩阵由 CI 覆盖 |

## 2. B 验收证据（在 `ce1281d`）

完整门禁 G（仓库根逐条执行，日志 `.superpowers/sdd/2026-11-09-extensions-selection-b-integration/b-final-*.log` 与修复轮 `task-7-agg-g-*.log`）：

| 命令 | 结果 |
|---|---|
| `node packages/daemon/native/build.mjs` | 0 |
| `pnpm exec tsc -b tsconfig.build.json` | 0 |
| `pnpm exec vitest run` | 0 — **67 文件 / 996 通过 / 1 预存在 root-only skip** |
| `pnpm exec tsc -p tsconfig.json` | 0 |
| `pnpm exec tsc -b tsconfig.build.json` | 0 |
| `pnpm exec biome check .` | 0（153 文件） |
| `rg ... packages/core/src` | 1（无匹配，符合预期） |
| `rg ... packages/protocol/src` | 1（无匹配，符合预期） |
| `git diff --check` | 0；工作树干净 |

真实链路证据：
- `packages/daemon/test/extensions-socket.test.ts`：真实 Unix socket + NDJSON，11 用例覆盖 hello→create→subscribe→snapshot→enqueue→edit/remove→turn.start→多 step 工具/包装器/来源执行、取消选择/重选、零片段重试、ignored abort、清点冲突隔离、断开客户端不取消 turn、超限 snapshot 后同连接继续可用、协议转录无秘密。
- 跨 UID：`unshare --map-auto` 真实执行（非 skip），异 UID 客户端在认证前被拒、读取 0 协议字节，同 UID 客户端仍可用；环境缺少映射时测试**失败**而非跳过。
- dist 子进程：`extensions-host.test.ts` 仅从 `packages/daemon/dist/index.js` 导入，真实 socket 创建扩展会话并执行真实 TS 工具，停止后无残留 socket/lock/进程。
- mutation sensitivity：临时移除 Core 资格分支导致 stale 断言变红，恢复后 11/11；记录为敏感性检查，不是原始 TDD RED。
- B 整体审查发现并修复一个 Critical：仅有内容证据的关闭 toggle 不得附加新类型快照，否则持久化后会让“内容→tool/wrapper”重开合法；修复 `ce1281d` 含回归测试，独立验证通过。

## 3. A 验收证据（保留，`e57f793`）

完整门禁 G：62 文件 / 925 通过 / 1 预存在 skip；两项 tsc、Biome、边界扫描、`git diff --check` 全部符合预期；loader 聚焦矩阵在 Node 22.19.0 / 24.11.0 / 26.13.0 各 66 通过（日志 `a-matrix-node*.log`）。依赖精确锁定：Ajv 8.20.0、tinyglobby 0.2.17、jiti 2.7.0（pnpm patch，patch SHA-256 `128e860385ec4366a7945e5ca6b241357f652a920be95ab13af25bd1e2a794a1`）。

## 4. 已交付契约（实现，不是计划）

- 配置：`.pisces/config.json`（全局/工作区），键 `defaultWorkspace`、`defaultProvider`、`defaultModel`、`extensions`、`entryConfig`；层级内置默认 < 全局 < 工作区；显式 `extensions` 替换默认，`[]` 禁用全部默认；provider/model 成对；`defaultWorkspace` 仅全局且为绝对路径。
- 发现：`package#name`、`foo.ts.meta.json`、技能相邻 `foo.meta.json` + `SKILL.md`、wrapper sidecar `{defaults,schema}`；只读清点、不执行代码；重复名/坏包的 issue 隔离，不阻断健康条目。
- 声明：客户端只提交单 text 块 `{toggle:[...]}`；daemon 同步富化，为 toggle 中的 tool/wrapper 附加冻结完整快照（all-toggle；仅内容证据的关闭例外）；定义来自 binding 或历史，不重算哈希；类型变化在覆盖前检查，关闭保留旧证据。
- 路由：`session.create`（配置模式与 `extensions` 数组）、`entries.snapshot`（安全投影 `{name,kind,description,parameters,definitionHash,configHash}` + 持久化 selection + 分支重放的 effective/stale）、`queue.enqueue`（声明富化）、`queue.edit/remove/clear`、`turn.start`（确认前按目标分支 `validateQueue`，steer 按提交偏移协调原/最新分支）、`session.read`、`provider.list`、订阅路由。
- 宿主：`startDaemon({ dataDir, providers, providerHost, extensions: { configDir, builtinDir? } })`；目录模式与 `defaults/createTools/entries/skills/sources` 手动模式互斥，混用在监听前以 `daemon.start_failed` 失败；平台/身份检查顺序与停止保锁语义不变；builtin 目录由模块 URL 向上取仓库根。
- 字节边界：条目 256 KiB、队列 1 MiB、响应/事件 4 MiB、帧 8 MiB；响应在 Gateway 以完整信封 UTF-8 预检，超限返回 `protocol.frame_too_large` 且连接继续可用。

## 5. 明确的未交付能力与残余风险

- 未交付：providers/clients 扩展装配、CLI、凭据/OAuth 管理、模板解析、`session.list`、工作区初始化、扩展沙箱、热重载、依赖树锁定、跨平台传输。
- 远端 CI 未运行；4 秒内部等待边界只在未加压的本机验证；Node 22/24 仅覆盖 A 阶段的 loader 聚焦矩阵，不等于 B 的跨版本验收。
- 仅入口字节按摘要冻结，不冻结依赖树；显式 `createRequire`、`process.getBuiltinModule`、`data:` URL 等原生逃逸不在身份隔离承诺内。
- 既有会话的工作区消失时，历史读取不可用（返回既有 `session.invalid_workspace`），恢复工作区后才可继续；这是已记录的可用性限制。
- 客户端提交条目的 `source` 原样保留；它不是授权通道，伪造来源只会让 §8.4 证据判断更保守，但文档已注明。
- `configHash` 单独变化导致的 stale 以及 `turn.start` 显式历史分支、`queue.clear` 目前只有单元级覆盖，socket 级覆盖集中在主要流程。
- 扩展服务失败映射为固定安全文本且无本地诊断日志，运维需靠复现区分配置错误与实现缺陷。
- `.gitattributes` 对 `patches/*.patch` 豁免行尾空白（仅生成补丁的上游 vendored 内容）；源码/测试仍全量检查。

## 6. 后续工作启动条件

1. 任何新阶段（例如 provider/client 扩展装配或 CLI）都需要用户单独授权；本文件完成状态不等于授权。
2. 开始前核对 `dev-pi` 上 `ce1281d` 与其后的文档提交，工作树归属清楚。
3. 每次提交前运行门禁 G；显式暂存；真实 socket/跨 UID 验收不得跳过，缺失环境必须失败。
4. 不重做已完成任务；新的发现应定点定位到具体任务与文件，避免无界重审。

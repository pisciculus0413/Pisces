# Pisces 实现缺口清单

本文件按当前 `dev-pi` 分支（`39030f5`）的代码与 `docs/1 High-Level Design/1 High-Level Design.md`、`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` 对照，汇总**设计中已描述、但尚未实现**的能力。

本文件是状态快照，不替代 HLD/DDS：契约冲突时以 HLD/DDS 为准；本文件只回答“现在缺什么”。

## 已实现基线

以下能力已经交付并通过本机门禁，不再列为缺口：

- Linux x64 本地 daemon：Unix socket、`SO_PEERCRED`、单实例锁、恢复、停止。
- CLI：`start`/`status`/`stop`、`config`、`extensions list`、`templates list|preview|apply`、`sessions list|export|cancel`、`client list|start`、`provider list`、`models list`、非交互 `run`。
- 目录驱动扩展：清点、声明式选择、`entryConfig`、冻结定义、按需装载、`entries.snapshot`、队列路由、内置 shell、工作区扩展。
- 扩展装配：CLI 启动的 daemon 始终传入精确 `extensions: { configPath }`；配置与目录在 `session.create` 时读取与扫描。
- 工作区访问、内置 shell、模板存储、会话默认工作区。
- 工具/包装器/技能/上下文来源的 Core 契约与 daemon 装配。
- 客户端：清单 `clients` 发现、`ClientRegistry` 装配与启动、协议 `client.list`/`client.start`、CLI `client list|start`。

## 1. CLI 与协议

| 功能 | 当前状态 | 依据 |
|---|---|---|
| `providers check` | 未实现；只能经 `provider list` 看 `ready`，没有具体不可用原因 | HLD §6.8；DDS §7.1 |
| `auth` | 未实现；不能校验或刷新供应商凭据 | HLD §6.8；DDS §7.1 |
| 交互式 `run` | 仅非交互单 turn；stdin 循环、多轮输入未实现 | HLD §6.8；DDS §7.2 |
| `pisces storage migrate` | DDS 定义了显式迁移入口，CLI 尚无该命令 | DDS §7.3 |

当前 `run` 的限制还包括：没有 `--output`，不直接读取会话文件或事件日志；`--json` 在 setup/协议错误时不输出对象（文档已说明）。

## 2. 扩展与凭据装配

| 功能 | 当前状态 |
|---|---|
| 扩展清单中的 `providers` 贡献 | 不装配；只记录 `extensions.unsupported_contribution`，provider 仍由 CLI 配置构造 |
| `CredentialStore` | 未装配。当前只有 CLI 从 `apiKeyEnv` 指定的环境变量读取 API key，没有文件凭据存储、OAuth 获取/刷新 |
| 已有会话热重载 | 未实现。扩展变更只影响之后新建的会话；旧会话只把哈希不匹配的条目显示为 `stale` |
| 依赖树锁定 | 未实现。`definitionHash` 只覆盖条目文件本身，`configHash` 只覆盖包装器配置，不哈希依赖 |

说明：当前供应商方言固定为 `openai-chat`。CLI 配置只暴露 `apiKeyEnv`；Core/daemon 的 `ProviderDescriptor.auth` 虽支持 `oauth` 类型，但没有 CLI 配置入口与 `CredentialStore`，因此 OAuth 实际不可用。

## 3. 平台与传输

| 项目 | 当前状态 |
|---|---|
| Linux x64 + Unix domain socket | 已实现并验证 |
| macOS | 目标设计，未实现；启动以 `daemon.unsupported_platform` 失败 |
| Windows 命名管道 | 目标设计，未实现 |
| 网络 socket / 多用户 daemon | 不属于当前 HLD 交付范围；当前为单用户本地 daemon |

## 4. 明确“不设计”的能力

以下不是遗漏，而是 HLD/DDS 明确排除的范围；补实现前应先改设计：

- **沙箱、权限降级、工具审批**：扩展与 shell 以 daemon 用户权限运行；安全边界是同一 uid 与用户知情选择。
- **扩展安装/更新/卸载**：交给 npm/git，不在软件生命周期内执行或拦截安装脚本。
- **协议写配置、写凭据、安装扩展**：这些只经 CLI，协议不提供写方法。
- **多用户共享 dataDir**：当前 daemon 以用户级单实例运行。
- **扩展依赖树完整性校验**：当前明确不哈希依赖。

## 5. 已知可靠性与验证缺口

- **`active-turn.json` 崩溃窗口**：`session.create` 已提交、尚未补写 `active-turn.json` 之间崩溃时，可能没有可供重启恢复的标记；DDS 明说不承诺恢复该窗口。
- **无历史 schema 迁移**：当前 `schemaVersion=1`，没有旧版本迁移函数；因此 `storage migrate` 即使补入口，也暂时没有真实迁移数据可跑。
- **结构化错误详情**：`Response.error` 只映射 `code`/`message`，不转发 `PiscesError.data`/`cause`；这是未来目标。
- **远端 CI 未运行**：本机只验证 Linux x64 / Node 26.13.0；HLD 设计的 Node 22.19.0 / 24 / 26 远端矩阵尚未实际运行，不能声称通过。
- **构建产物缺失时 e2e 跳过**：部分构建后 CLI e2e 在 `dist` 缺失时 `skipIf`；CI 需要补构建步骤才能覆盖。

## 6. 建议优先级

1. `providers check` + `auth` + `CredentialStore`：补齐供应商可用性与凭据管理。注意 DDS 目前没有
   `<configDir>/credentials` 的文件格式、权限与写入原子性定义，也没有 OAuth 的 token endpoint 与
   刷新流程，落地前需先补设计；本阶段只宜做 apiKey 文件凭据 + `providers check` 原因输出。
2. 交互式 `run`：在现有非交互单 turn 之上增加 stdin 循环与多轮输入。
3. `pisces storage migrate`：等出现第二个 schema 版本时再落地迁移函数与 CLI 入口。
4. macOS/Windows 与远端 CI：平台移植与验证矩阵，优先级低于功能补齐。

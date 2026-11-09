# Extensions Selection：A → B 交接门禁

**状态：READY。A（Tasks 1–6）代码验收与 A 范围整体审查已完成；Plan B 仍未获实施授权，不得据本文件自动开始。**

本文件是 B 的实施入口：只读本文件、Plan B 与共同门禁即可工作，不需要恢复旧对话、重读 Plan A 全文或重做已验收任务。所有子智能体继续显式使用 **`deepseek-flash`**，不得静默升级模型。

## 1. 仓库、授权与环境

| 项目 | 实际值 |
|---|---|
| 分支 | `dev-pi`（不建 worktree、不向 main 提交、不 push/merge） |
| **A 代码验收 SHA** | **`e57f793f6d746759d67122a134ca1c24c7c7c52`** |
| 计划索引 / 门禁 G | [共同门禁与执行约束](../plans/2026-11-09-extensions-selection.md) |
| Plan A（已完成） | [Plan A：Tasks 1–6](../plans/2026-11-09-extensions-selection-a-foundations.md) |
| Plan B（未授权） | [Plan B：Tasks 7–11](../plans/2026-11-09-extensions-selection-b-integration.md) |
| 设计 | [已批准设计](../specs/2026-11-09-extensions-selection-design.md) |
| 环境 | Node v26.13.0；pnpm 12.8.1；Linux x86_64 |
| 远端 CI | **未运行**；不得声称通过 |
| 跨 UID / 真实 socket 验收 | 属 Plan B，尚未进行 |

## 2. 验收证据（在 `e57f793`）

完整门禁 G，仓库根逐条执行，日志见 `.superpowers/sdd/2026-11-09-extension-loader-jiti-patch/a-g-*.log`：

| 命令 | 结果 |
|---|---|
| `node packages/daemon/native/build.mjs` | 0 |
| `pnpm exec tsc -b tsconfig.build.json` | 0 |
| `pnpm exec vitest run` | 0 — **62 文件 / 925 通过 / 1 预存在 skip** |
| `pnpm exec tsc -p tsconfig.json` | 0 |
| `pnpm exec tsc -b tsconfig.build.json` | 0 |
| `pnpm exec biome check .` | 0（144 文件） |
| `rg ... packages/core/src` | 1（无匹配，符合预期） |
| `rg ... packages/protocol/src` | 1（无匹配，符合预期） |
| `git diff --check` | 0；工作树干净 |

loader 聚焦矩阵（8 个 loader/引擎测试文件，66 用例）在验收 SHA 上实际执行：Node **22.19.0**、**24.11.0**、**26.13.0** 各 66 通过、exit 0，日志 `.superpowers/sdd/.../a-matrix-node{22,24,26}.log`（含 runtime 路径、版本、命令、exit）。

Task 3 专项证据（真实 dist 子进程、隔离冻结安装、缺补丁/坏补丁负控各自失败）：`.superpowers/sdd/2026-11-09-extensions-selection-a-foundations/task-3-jiti-patch-report.md` 与同目录 `task-3-jiti-patch-*.log`；补丁 provenance：[`patches/jiti-2.7.0.md`](../../../patches/jiti-2.7.0.md)。

精确依赖：Ajv **8.20.0**、tinyglobby **0.2.17**、jiti **2.7.0**（pnpm `patchedDependencies` 精确固定，patch 文件 SHA-256 `128e860385ec4366a7945e5ca6b241357f652a920be95ab13af25bd1e2a794a1`）。无直接 get-tsconfig 依赖（jiti 内嵌 4.14.0）。

## 3. 已完成，不要重复实施

| 工作 | 提交 | 结论 |
|---|---|---|
| 基线 mkdir 竞争修复 | `62c2720` | EEXIST 后 fresh lstat，保留目录安全检查 |
| Task 1 配置与哈希 | `51bbf4c`、`acfdb35` | 五键、层级合并、canonical SHA-256；深 JSON 异常安全归一化 |
| Task 2 声明式清点 | `2f8bf16`、`0a503e5`、`e4776e6` | 同步 draft-07 校验、最终 defaults+override、canonical 身份/去重、冻结 |
| Task 3 loader 主路径 + I1 | `fd5e158`、`e7d937d` | 惰性、摘要校验、每 loader promise 缓存含失败、安全错误边界 |
| Task 3 jiti 局部补丁 | `6527e0f`、`e033032` | 实例模式、图私有 raw JSON、格式拒绝、标记 fail-closed；原 CJS 两个身份断言现为 GREEN |
| Task 3 验收文档 | `66969ed` | 状态与延期 Minor 记账 |
| Task 4 Core 纯选择/资格 | `a3faddc`、`41500e1` | 单一重放/XOR 引擎、§8.4 五类规则、legacy 模式不变 |
| Task 5 A/C 重校验 + driver | `7b4e4a9` | `viewFor`/`validateQueue`、`executionSelection`、幸存窗口重算 |
| Task 6 每会话 binding | `e8c0cd1`、`e57f793` | 每 prepare 独立 Tools/loader、惰性代理、冻结配置与来源副本 |

## 4. A 实际公开接口（B 的最小契约）

以下均为**已存在代码**，不是计划契约。`extensions/` 模块**没有**从 `packages/daemon/src/index.ts` 再导出；按契约表从 `packages/daemon/src/extensions/extensions.js` 直接导入。

- `createExtensions(options): Extensions`；`Extensions.readGlobalConfig(): Promise<ExtensionConfig>`；`Extensions.prepare(workspace): Promise<ExtensionBinding>`。
- `ExtensionBinding` 恰为八个字段：`workspace`、`config`、`inventory`、`issues`、`entries`、`skills`、`sources`、`tools`。内部 records/loader 不外泄。
- `ContextEntries`：`kind`、`selected`、`get`，外加可选纯同步 `matchesDefinition(definition)`（`ExtensionBinding` 总是提供）。
- Core 导出的纯函数：`viewFor`/`validateQueue` 在 `Context` 上；`replaySelection`、`applyDeclarations`、`evaluateSelection`、`SelectionView`、`SelectionEvaluation`、`EffectiveEntry` 从 `packages/core/src/index.ts` 公开。
- `AssembledContext.executionSelection?`；driver 使用 `assembled.executionSelection ?? assembled.selection`。
- loader `ExtensionModule { default: unknown; config?: unknown }`、`ExtensionLoader.load(entry)` 为 daemon 内部实现，不在 B 契约内。

### 4.1 必须知道的接口偏差（不要让 B 猜）

1. **不存在 `Context.effectiveFor`。** B 需自行组合 `evaluateSelection(await ctx.viewFor(nodeId), binding.entries)`；设计 §8.2 只是“建议”该查询。
2. **`validateQueue(nodeId?)` 只校验未确认条目** 针对目标分支历史；已确认但未提交的冲突由 assemble C 段在不可逆写入前重校验。不得假设确认前已全覆盖。
3. **`applyDeclarations(view, pending)` 返回的视图包含未确认定义**，只可用于校验，不得当作已持久化快照对外暴露（§8.2 的 `snapshot.effective` 必须来自 `replaySelection`）。
4. **`prepare` 不校验** `config.extensions` 成员/重复、`defaultProvider/Model` 组合，也不验证 workspace 是否为目录（`realpath` 对文件成功，随后扩展目录读作空）。这些属于 B Task 8；`config.invalid` 同时用于“工作区不可访问”。
5. **strict 资格规则只在 `entries.matchesDefinition` 存在时生效**（`ExtensionBinding` 恒有），旧嵌入式/手动注入路径保持原语义。
6. **`binding.tools` 是完整 `Tools`，带注册/变更方法**（计划强制）。B Task 7 只能读 `selected`/`invoke`，不得注册、替换或 `forInventory`，否则会破坏冻结保证。
7. **同名跨 workspace** 各自独立实现；不同 prepare 之间不共享模块身份或 promise 缓存（同 workspace 新 binding 会重新求值一次，含失败）。

## 5. 残余风险与边界（B 必须继承）

- 扩展 `source` 只能由宿主产生：strict 模式只把**分支内**内容节点当作 §8.4 证据，`applyDeclarations` 看不到队列来源证据；若 B 允许客户端选择 `source`，会打开同名重义漏洞。
- loader **不是沙箱**：显式 `createRequire`、`process.getBuiltinModule`、`data:` URL 等原生逃逸不在身份隔离承诺内；扩展入口依赖的 `.node`/未知格式在模式内拒绝，但宿主自身 N-API 不受影响。
- 仅入口字节按摘要冻结，不冻结依赖树、不提供热重载/依赖重放。
- JSX 仅支持 automatic runtime + 扩展自带 runtime/pragma；**不支持**仅靠 tsconfig `jsx`/`jsxImportSource`。
- 仓库新增 `.gitattributes`：`patches/*.patch whitespace=-blank-at-eol`，仅豁免生成补丁内的 vendored 上游空白，源码/测试仍全量检查。
- 运行 `git status` 时注意 `.superpowers/sdd/` 为被忽略的本地证据区，不属于产品改动。

## 6. 延期 Minor 处置（A 整体审查已分类）

**READY 前已关闭：** handoff 重写（本文件）、验收 SHA 三运行时矩阵补录。

**移交 B / 文档任务：**
- `validateQueue` 未确认范围与 `applyDeclarations` 含未确认定义：必须写入 B 的 Task 8/9 契约（见 §4.1）。
- adapter 级 bare builtin 正控标签不准（`node:fs` 用了两次）；引擎级 bare `fs` 已覆盖。
- `data:` URL 需在补丁边界文档补一句。
- `binding.tools` 只读规则需在 Task 7 审查中把门。
- binding 测试中 tool 与 wrapper 共用一个 sentinel 日志，弱化单产物加载计数证据。
- issue `source` 在重复/根故障时使用条目名或目录标签而非包名（分类学瑕疵）。

**接受现状（不修）：** `compareNames` 冗余、`frozenDefinition` 防御分支与文案差异、legacy 分类重复、`isContentNode` 非类型谓词、ad-hoc kind 联合、无 matchesDefinition 短路测试、`source_failed` 两处构造、materialize 双重投影、重复 definition map、两个重放入口、type-only 循环导入、`validateQueue`/`viewFor` 无 spy 测试、`task-5-focused-vitest.log` 标签错误、Tools 变更方法暴露、`info.definition?.parameters ?? {}` 死防御、inventory/records 双份结构等价定义、未冻结 binding 字面量、缺 binding 级 `readGlobalConfig` 测试、空 `{}` 导出在无 sidecar defaults 时被接受。

## 7. B 启动条件（严格）

1. 用户**单独**授权 Plan B；本文件 READY 不等于授权。
2. 先核对 `dev-pi` 上是否存在 `e57f793` 及其后的文档提交，工作树归属清楚。
3. 按 Plan B 的接口表逐项对照 §4；任何不符立即暂停并修正契约，不得口头交接。
4. 每次提交前运行共同门禁 G；显式暂存；不跳过跨 UID 真实 socket 验收（无法建立异 UID 宿主时必须失败而非跳过）。

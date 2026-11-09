# Extensions Selection：分阶段计划入口

**本文件已替代原单体计划，仅是导航与共同门禁，不是第三份实施计划。** 用户已批准 Plan A 并授权基线修复；A（Tasks 1–6）已完成代码验收（`e57f793`）与 A 范围整体审查，交接 READY。Plan B 未获实施授权；不提供授权前不开始 Task 7。当前恢复入口见下方交接记录。

## 执行顺序

| 计划 | 任务（保留原编号） | 独立交付 / 停止点 |
|---|---|---|
| [Plan A：扩展基础与 Core 资格](2026-11-09-extensions-selection-a-foundations.md) | 1–6 | 可测试 binding 服务，完成 A 审查及交接；不接通新路由 |
| [Plan B：Gateway 与宿主闭环](2026-11-09-extensions-selection-b-integration.md) | 7–11 | 消费 A 契约，完成真实 socket 验收与文档 |

设计：[`2026-11-09-extensions-selection-design.md`](../specs/2026-11-09-extensions-selection-design.md)。
Task3 专项修订：[jiti 补丁计划](2026-11-09-extension-loader-jiti-patch.md)（已批准补充设计；实现与独立审查完成 `6527e0f`/`e033032`，残余 Minor 留 A 整体审查；替代 A 内旧 Task3 正文，不新增阶段、不重复 Tasks1–2）。
交接：[`2026-11-09-extensions-selection-a-to-b.md`](../handoffs/2026-11-09-extensions-selection-a-to-b.md)，**当前 READY**；已填入 A 代码验收 SHA `e57f793`、实际接口偏差、依赖能力、验证与残余风险。B 仍需用户单独授权。

## 上下文与交接规则

- 当前 A 已完成且交接 READY，下一阶段是 Plan B（任务 7–11），但尚未获授权；授权前不修改 Gateway/路由。不重做选型或 Tasks1–6。
- 给单任务智能体只发送该任务、共同约束/门禁、直接接口、对应设计段落和短报告；不传全部计划或继承整个父会话。继续逐任务 TDD 与独立审查，不并行修改共享 checkout。
- 每任务保存实际提交、RED/GREEN、审查/修复和下一步。暂停时写清当前任务/步骤、未提交文件归属、下一命令、失败日志路径，不能只说“继续”。本地详细日志可留 `.superpowers/sdd/2026-11-09-extensions-selection/`；A→B 必要结论必须进入受版本控制的交接记录。
- A 的交付边界为 `Extensions.prepare → ExtensionBinding` 和 Core 视图/资格接口。B 携带最小契约；A 任何接口调整都需同步 B 和交接记录，不让后继猜测。
- A 验收 SHA 未产生、loader 能力无证据、Critical/Important 未关闭或接口不符时，不开始 B。A 完成报告后等待 B 的授权；交接模板不能作为完成证明。
- 本阶段始终在 `dev-pi` 顺序工作，不建 worktree、不向 main 提交、不 push/merge，保留所有旧 SDD 目录。

## 新上下文启动指令（获得实施授权后使用）

**A：**「先读本入口与 Plan A，按需读已批准设计 §3–8；核对分支与状态。只执行 Tasks 1–6，逐任务 TDD/独立审查，完成 A 整体审查后填写受版本控制的 A→B 交接，不自动执行 B。」

**B：**「先读本入口、Plan B 与 A→B 交接，核对 READY、完整验收 SHA、工作树和最小接口；任何证据缺失立即暂停。不要重读 A 全文或依赖旧对话，从 Task 7 继续，遵守 Plan B 的启动门槛。」

任务报告可写 `.superpowers/sdd/2026-11-09-extensions-selection/task-N-report.md`，最少包含：任务/步骤状态、起止完整 SHA、实际文件/接口变化、RED/GREEN 命令与结果、审查未决项、下一任务及读取路径。失败日志写路径和关键原文，不把大段工具输出复制进后继提示。

## 共同提交门禁 G

每任务 Step 5 前执行；命令从仓库根运行。所有阶段完成结论还需要其最终 HEAD 上的新鲜验证。

```bash
node packages/daemon/native/build.mjs
pnpm exec tsc -b tsconfig.build.json
pnpm exec vitest run
pnpm exec tsc -p tsconfig.json
pnpm exec tsc -b tsconfig.build.json
pnpm exec biome check .
```

随后分别运行并核对退出码：

```bash
rg -n 'from "(node:)?(fs|http|https|net|tls|dgram|dns)|from "@pisces/(daemon|protocol)"' packages/core/src
rg -n 'from "@pisces/(daemon|core)"' packages/protocol/src
git diff --check
git status --short
```

两个 rg 必须 exit **1**（无匹配）；exit 2 是错误，不能 `|| true` 吞掉。审查还需核对新增动态 import/require。Biome 使用只读 `check`，不要把带写入的 lint 脚本当作验证。

提交只显式暂存本任务修改路径，先确认工作树和 staged diff，不使用 `git add .` 或 `git add -A`。消息使用 `feat(core|daemon): ...`、`fix(...)` 或 `docs: ...`。依赖变更一并显式暂存锁文件。

真实跨 UID Linux 测试在无法建立宿主可见异 UID 时必须失败，不得跳过；不能因环境/loader 障碍放宽生产安全边界。远端 Node 22.19/24/26 CI 没有实际结果时明确记未运行。

## 拆分自审（历史记录）

- 原 11 个任务正文、测试断言、接口和提交路径原样迁移：A 1–6，B 7–11，未删功能或新增产品设计。
- 共用约束/门禁留在本入口；各计划仅含本阶段文件图与五项 Review Focus。B 额外携带 A 的最小输出契约，不依赖 A 全文。
- 每份计划可在独立上下文实施和审查；A 的 loader 是早期硬门槛，失败时暂停，不把不确定性推给 B。
- 拆分提交 c0be772 当时只重组文档；之后的实施状态以当前交接为准。Tasks 1–2 已完成不代表 A/B 已完成，Task 3 的能力失败仍是硬阻塞。

# Extensions Selection：当前工作交接 / A → B 门禁

**状态：BLOCKED / NOT READY。Plan A 的 Task 3 正式 jiti 补丁实现进行中，硬门槛未验收；不能启动 Tasks 4–6 或 Plan B。**

用户此前要求交接，随后完成选型并批准 jiti 局部补丁设计；当前已确认修订计划并进入正式实现，产品验收尚未通过。本文件是恢复入口，不是新实施计划；不要恢复整段旧对话，也不要重做已完成任务。所有子智能体继续使用 **`deepseek-flash`**。

**最新进展：** 用户已批准 [jiti 替换设计](../specs/2026-11-09-extension-loader-jiti-patch-design.md)，[Task3 专项修订计划](../plans/2026-11-09-extension-loader-jiti-patch.md) 已获用户确认并进入正式实现；[选型报告](../research/2026-11-09-extension-loader-selection.md) 保留实测证据。两个候选在本地 Node 22.19/24.11/26.13 均通过共用 17 测试；额外 6 项独立边界检查中，最终 jiti 补丁全部通过，esbuild 有 3 项语义失败。原产品两个 CJS 身份断言在本轮实现前为 RED；当前按既定 deepseek-flash SDD 完成实现与证据，验收和独立审查尚未通过；不重复选型或重做 Tasks1–2。

## 1. 仓库与授权

| 项目 | 实际状态 |
|---|---|
| 分支 / HEAD | `dev-pi` / `e7d937db06a8a9a4fa4b5e4401889957fc735672` |
| 计划索引 | [共同门禁与执行约束](../plans/2026-11-09-extensions-selection.md) |
| 当前计划 | [Plan A：Tasks 1–6](../plans/2026-11-09-extensions-selection-a-foundations.md)，已获实施授权 |
| 后续计划 | [Plan B：Tasks 7–11](../plans/2026-11-09-extensions-selection-b-integration.md)，未获实施授权 |
| 设计 | [已批准设计](../specs/2026-11-09-extensions-selection-design.md) |
| A 验收 SHA | **不存在**；Tasks 3–6 未完成，整体审查未进行 |
| 环境 | Node v26.13.0、pnpm 12.8.1、Linux x86_64；远端 CI 未运行 |

用户已授权 A、选型并批准补丁设计；当前要求修订计划，确认后才恢复 Task3 正式实现，不能把原型当成已修复产品。继续现有 checkout，不建 worktree、不向 main 提交、不 push/merge、不清理旧 SDD。当前有刻意保留的未提交 RED 测试，不能 reset/clean/delete 掉。

## 2. 已完成，不要重复实施

| 工作 | 提交 | 实施与独立审查结论 |
|---|---|---|
| 基线 mkdir 竞争修复 | `62c2720` | 仅 EEXIST 进入 fresh stat，保留目录安全检查；已审查接受 |
| Task 1 配置与哈希 | `51bbf4c`、`acfdb35` | 完成；深层 JSON 异常归一化修复已限定复审接受 |
| Task 2 声明式清点 | `2f8bf16`、`0a503e5`、`e4776e6` | 完成；5 个生产缺陷及异步 schema 崩溃回归补强已审查接受 |
| Task 3 主路径加载器 | `fd5e158` | 部分实现，不是能力验收点 |
| Task 3 I1 装载前错误边界 | `e7d937d` | 已限定复审：ADDRESSED，无新增阻断；**不解除 I2 阻塞** |
| Tasks 4–6 | 无 | 未开始；Core 选择视图/执行资格、独立 binding 尚不存在 |

精确依赖：Ajv **8.20.0**、tinyglobby **0.2.17**、jiti **2.7.0**，已精确锁定。没有直接 get-tsconfig 依赖；当前 jiti 包内嵌 4.14.0。

## 3. 当前阻塞：CJS 传递依赖绕过宿主映射

实际 fixture：TS 入口导入扩展自己的 `node_modules/cjs-dep/index.cjs`；该依赖 `require("@pisces/core")`，扩展目录另有一份不同的宿主包。其 `ToolDeniedError` 与真实宿主类不相等。

已测结果：
- 源码模式真实身份断言失败。
- 无 Vitest resolver 的 dist 子进程输出 `{"host":false}`。
- jiti 的 virtualModules 只拦截经过 jiti 的解析；原生 CJS require 绕过它。
- `transformModules:["cjs-dep"]` 可以修正已知 `.js` 依赖，但实测仍无法修正 `.cjs` 依赖。不能靠枚举已知包名保证任意传递依赖图。

**硬门槛未通过。** 不能仅文档披露第二份宿主包、降低 instanceof/身份断言、删除/跳过测试、修改 Node 全局加载器/cache 或猜测扫描整个依赖树来宣称通过。选型与补充设计审批、专项计划确认均已完成；当前执行正式 TDD/补丁安装与 dist 验证，随后交独立审查；验收未通过前不改产品边界。

### 必须保留的未提交文件

`packages/daemon/test/extensions-loader-cjs.test.ts`：本轮新增、未跟踪，含源码与 dist 两个正向身份断言，当前均 RED；不是用户的其他改动。不得 `.skip` / `.todo` / `.fails` 或移出测试集。

```bash
pnpm exec vitest run packages/daemon/test/extensions-loader-cjs.test.ts
```

预期当前结果：exit 1，2 个身份测试失败。文件已通过 tsc 和定点 Biome；子进程有 15 秒 SIGKILL 限时并等待 close，fixture 在 finally 清理。早期曾临时归档该用例，后已恢复；旧的 **825 通过 / 1 跳过**提交前结果没有包含它，不能当作硬门槛成功。

## 4. 上次交接完整门禁（历史，非本轮候选测试）

Controller 已在当前 HEAD、保留 RED 测试的工作树重新执行全部门禁：

| 门禁 | 本轮结果 |
|---|---|
| native build、两次 dist build | 全部 exit 0 |
| 完整 Vitest | **exit 1：54 文件，1 失败 / 53 通过；2 failed / 825 passed / 1 skipped** |
| 失败范围 | 仅上述 CJS 源码与 dist 身份断言；不是 collection/import 错误 |
| tsc -p | exit 0 |
| 只读 Biome | exit 0 |
| Core / protocol 边界扫描 | exit 1 / 1，均符合“无匹配”预期 |
| git diff --check | exit 0 |

日志位于本地 SDD：`handoff-gate-summary.log`、`handoff-vitest.log` 及其他 `handoff-*.log`。这证明当前阻塞仍可复现，**不是 A 验收成功**。远端 CI 未运行。

本轮有 4 个已跟踪文档改动：本记录、计划索引、Plan A、设计状态页；另有上述 1 个未跟踪 RED 测试，均属本轮工作。它们保留为未提交改动：完整测试门禁有已知阻塞，故不擅自豁免“每次提交前全门禁”规则来制造收尾提交。没有暂存、push/merge，所有后台智能体均已结束。

## 5. 接口和已记录裁定

现有 daemon `extensions/` 模块：`types.ts`、`hash.ts`、`config.ts`、`metadata.ts`、`discovery.ts`、`loader.ts`。公开的 binding/Extensions/Core 接口仍是后续计划契约，**尚未实现**，不要误读 Plan B 的接口表为现有代码。

恢复时保留以下裁定，细节见台账：
- 未知顶层配置键及工作区 defaultWorkspace：固定安全 `config.unknown_key`；其他无效配置：`config.invalid`。
- 深层 JSON 处理异常安全归一化，不新增任意深度限制或改变哈希配方。
- 拒绝 Ajv 异步 schema，调用前隔离；崩溃用例已做移除 guard 的真实 mutation sensitivity，不能冒称原始 TDD RED。
- wrapper schema 校验最终合并配置；允许用户补全 partial defaults。无用户覆盖时无效默认隔离条目；显式最终配置无效或目标不可用则 `config.invalid`。
- 入口 canonical realpath 用于包内身份/去重/加载；logical path 用于相邻 sidecar 和名称，同目标按逻辑路径排序选代表。
- 枚举错误以安全 issue 隔离最小来源，不阻断健康包。
- 已实测 JSX 范围是 automatic runtime + 本地 pragma；**不支持仅靠 tsconfig jsx/ jsxImportSource 选择运行时**，不能宣称全量 TS compiler options 支持。
- Task 6 预计需要最小扩宽 Core wrapper factory 类型到 `ToolWrapper | Promise<ToolWrapper>`；尚未改动，不能漏掉既有预检裁定。

## 6. 证据与未决事项

本地台账及全部日志：`.superpowers/sdd/2026-11-09-extensions-selection-a-foundations/`（git-ignored，必须保留）。

优先读：`progress.md`、`task-3-report.md` 的 fix1/恢复测试段、`task-3-fix1-review.md`。阻塞日志：`task-3-cjs-red.log`、`task-3-fix1-i2-probe.log`；早期独立 review 的 Approved 结尾不能覆盖其两个 Important，最新限定复审明确 I2 OPEN/BLOCKED。

后续 A 整体审查必须重看各任务延期 Minor，不能视为已修复：基线测试诊断/覆盖；Task1 稀疏数组及程序化非 JSON 输入、UTF-8/验证前提与证据边界；Task2 logical sidecar 越界别名、类型只读性、schema 正则风险和枚举诊断；Task3 虚拟模块继承键、tsconfig stat 吞错、额外宿主身份覆盖与 JSX 限制。完整逐项记录在台账及 `task-N-review.md`。

## 7. 新会话恢复指令

> 读取本交接、最新选型报告、Plan A 和本地 progress.md；核对 HEAD、分支、未提交文件归属，保留 extensions-loader-cjs.test.ts。Tasks 1/2 已完成，不重派。用户已批准 jiti 补丁设计并确认专项计划，不重做选型/设计；以 deepseek-flash SDD 继续 Task3，不能把临时绿结果当作产品验收。额外未提交研究报告属于本轮；不直接执行 Tasks 4–6，更不能进入 B。所有子智能体 deepseek-flash；不依赖旧对话。

只有 Task3 硬门槛、Tasks4–6、A 整体审查和最终完整门禁均完成，才可填写 A 验收 SHA 并将本记录改为 READY；之后仍需 B 的实施授权。

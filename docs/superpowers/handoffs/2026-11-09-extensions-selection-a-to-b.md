# Extensions Selection：Plan A → Plan B 交接记录

**状态：NOT READY。当前只是交接模板；Plan A 尚未实施，不能据此启动 Plan B。**

## 1. 交接身份（Plan A 完成者填写真实值）

| 字段 | 当前值 |
|---|---|
| 分支 | dev-pi |
| 规划提交 | e977dac（拆分前规划；不是 A 的实施完成点） |
| A 实施起点完整 SHA | 未开始 |
| A 审查通过的完整 SHA | 未产生 |
| 完整验证所在 SHA / Node / 平台 | 未运行 |
| 工作树状态与未提交文件归属 | 交接时重新核对 |
| 接手任务 | A 验收通过后从 Task 7 开始 |

## 2. 任务与审查证据

每项填写实际提交、RED/GREEN 的命令及摘要、独立审查结论和报告路径。缺证据保持未完成；不得把 mutation 检查伪称原始 RED。

| A 任务 | 实施提交 | RED/GREEN 证据 | 独立审查 / 修复结论 |
|---|---|---|---|
| 1 配置与哈希 | 未开始 | 未运行 | 未审查 |
| 2 声明式清点 | 未开始 | 未运行 | 未审查 |
| 3 Loader 能力硬门槛 | 未开始 | 未运行 | 未审查 |
| 4 Core 选择视图 | 未开始 | 未运行 | 未审查 |
| 5 装配执行资格 | 未开始 | 未运行 | 未审查 |
| 6 独立 binding | 未开始 | 未运行 | 未审查 |

A 整体审查：未进行。所有 Critical/Important 关闭后才能 READY；延期 Minor 必须记录影响与接手任务，不能只写“已知问题”。

## 3. 接口差异与依赖能力

计划契约见 Plan B 的“来自 A 的最小接口契约”。A 完成时逐项记录：

- [ ] `extensions/types.ts`：ExtensionsOptions、ExtensionConfig、Inventory、ExtensionBinding、Extensions 的实际位置/签名与 Plan B 一致。
- [ ] `extensions/extensions.ts`：createExtensions(options)；每 prepare 独立 binding，重扫、不导入插件。
- [ ] `@pisces/core`：SelectionView、EffectiveEntry、SelectionEvaluation、applyDeclarations、evaluateSelection 已导出。
- [ ] Context.viewFor / validateQueue 的持锁要求、executionSelection fallback 与 Plan B 一致。
- [ ] 依赖精确版本与 lockfile 提交：填写实际解析版本，不把设计推荐版本当作验证结果。
- [ ] Loader 能力证据：TS、TSX/JSX、tsconfig paths/extends、本地依赖、node_modules TS、静态/动态宿主身份、跨 binding 缓存隔离、入口修改拒绝、dist 子进程。
- [ ] 同工作区并发/不同工作区同名条目的注册表、配置、promise 隔离证据。

如实际接口有偏离，先同步 Plan B 的接口契约与受影响任务，再交接；不得要求接手者从旧对话猜差异。不新增兼容层来掩盖未经审查的接口漂移。

## 4. 完整验证（对应 A 验收 SHA）

| 门禁 | 命令 / 结果 / 日志路径 |
|---|---|
| native build + dist build | 未运行 |
| 完整 Vitest（文件数/通过/失败/跳过及原因） | 未运行 |
| tsc -p / tsc -b | 未运行 |
| Biome | 未运行 |
| Core / protocol 边界扫描（预期 exit 1/1） | 未运行 |
| Loader dist 子进程验证 | 未运行 |
| git diff --check / 工作树核对 | 未运行 |

远端 CI：未运行。没有宿主可见异 UID 映射时 Linux 跨 UID 测试必须失败，不能记为环境跳过。

## 5. 尚未交付与残余风险

A 完成后仍不能宣称协议闭环已完成：Gateway/公开宿主接入、声明富化、snapshot/队列新路由和真实 socket 纵向验收属于 B。CLI、模板、凭据管理、provider/client 扩展装配、session.list、跨平台传输继续不交付。

残余事项列表：未开始实施，暂无经验证的新增发现。交接时改为真实问题（严重性、影响、裁定、负责任务），无问题也要明确记“审查未发现新增项”，不得保留本句冒充审查结果。

## 6. 接手与暂停规则

B 接手者先读原计划入口索引、Plan B、本记录；核对 READY、完整 SHA、分支、工作树和接口实际代码后重新运行所需门禁，再开始 Task 7。HEAD 若变化，先查变更及是否包含验收 SHA，不重写/丢弃用户文件。

中途换智能体时记录最后完成任务/步骤、工作树归属、下一条验证命令和失败原文位置；不要粘贴整段历史输出。未 READY、接口漂移、未关闭 Important 或 loader 能力缺证据时暂停，不能越过 A/B 边界补做并假称 A 已验收。

# Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付环境无关的公共领域类型与可注入仓库的 Sessions 树操作，不实现真实存储。

**Architecture:** `@pisces/core` 拥有类型原语、消息和会话领域契约；核心不引用协议。Sessions 只生成节点、确定父指针并调用仓库；测试专用内存仓库承担原子提交与分支读取契约。服务层锁与真实磁盘事务留给后续里程碑。

**Tech Stack:** TypeScript、Node >=22.19.0、ESM、pnpm 12.8.1、Vitest；沿用现有配置，不新增依赖。

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §2.2、§3.1、§4.1；`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §1.3、§2.1–2.4、§4.1、§5.4、§8.4–8.5。

## Global Constraints

- 实现语言为 TypeScript，运行时为 Node，包管理器使用 Pnpm，模块系统为 ESM。
- 核心层不得依赖服务层、客户端或运行环境。
- 类型原语（brand 机制、JSON 值、错误基类）集中定义，具体标识由各模块定义。
- 所有持久化记录都带 `schemaVersion`；当前版本为 `1`。
- 未出现的可选字段表示未设置；不使用 `null` 表示“未设置”。
- 时间戳为 RFC 3339 UTC 字符串，精确到毫秒，例如 `2026-11-06T13:00:00.000Z`。
- 会话树只追加，不删除、不改写。
- 不实施网络、daemon、Context、真实磁盘存储或协议方法；测试替身不作为产品 API 导出。
- 在现有 `dev-codex` 分支执行；不切换 main、不推送。提交前检查 `git status --short`，只暂存本任务文件。

## Review Focus

- 非默认分支续写后，默认末端应为最后追加节点；显式读取旧分支不得改变默认分支。Task 2 的 branch/default-head 测试覆盖。
- 第二个会话的有效节点 id 不能作为第一个会话的父节点。Task 2 的 foreign-parent 测试覆盖。
- 批量提交失败不能泄漏半批节点或新 meta，重试从最后成功末端继续。Task 2 的 create/append failure 测试覆盖。
- `updateMeta` 不能覆盖不可变字段。Task 2 的 immutable-meta 测试覆盖仓库契约。
- 异步读取中途抛错与写入错误必须向调用方传播。Task 2 的 read/write propagation 测试覆盖。

## 已确定的接口选择与验收边界

- 工厂 `createSessions(deps: SessionsDeps): Sessions`；依赖及方法签名逐字采用详设 §4.1。`readBranch`/`readTree` 直接返回仓库 iterable，不预读、不捕获吞错。
- `append` 显式 parent 用 `repository.readBranch(sessionId, parentId)` 验证；默认 parent 读取 `repository.readBranch(sessionId)` 并取最后节点。仓库通过分支索引实现该读取，核心不扫描全树。读到空分支时用 `PiscesError("storage.corrupt", ...)` 拒绝已有空会话。
- `create`/`append` 空 drafts 在调用仓库、时钟和 id 工厂前抛 `TypeError`。详设要求非空但未规定错误码；此为内部调用契约，不新增协议错误码。
- `updateMeta` 直接转发；只替换 model/provider 的要求属于 repository 实现契约（详设 §5.4.2），测试替身必须遵守。不通过 `list()` 模拟单个 meta 查询。
- 故障注入证明 Sessions 不吞错、不返回部分结果及不保留错误 head 缓存；内存替身的原子性不等于真实磁盘原子性验收。
- 控制内容解析、定义快照完整性、kind/role 运行时校验由后续装配/存储边界实现；本批只保持详设类型，不引入未约定的校验框架。

### Task 1: 公共领域类型与错误基类

**Files:**
- Create: `packages/core/src/types.ts` — JsonPrimitive/JsonValue/JsonObject、Brand 与 PiscesError。
- Create: `packages/core/src/messages.ts` — EntryName、TurnId、ToolCall、ToolResult、ContentBlock、Message、DefinitionSnapshot、DeclarationPayload、CompactionPayload、CancelPayload、ControlPayload。
- Create: `packages/core/src/sessions/types.ts` — SessionId、NodeId、SessionMeta、SessionNode、SessionNodeDraft、SessionRepository、SessionsDeps、Sessions。
- Modify: `packages/core/src/index.ts` — 导出以上公共契约。
- Test: `packages/core/test/errors.test.ts` — 只测运行时错误行为。

**Interfaces:**
- Consumes: 详设 §2.1–2.4、§4.1 和 §8.4。
- Produces: 上述类型原样采用文档字段、可选性和联合类型；`PiscesError(code: string, message: string, options?: { data?: JsonValue; cause?: unknown })`。`NodeId` 的类型引用使用 `import type`，不引入运行时环。
- 只实现本里程碑依赖闭包；暂不实现 QueueEntry、Usage/StopReason、WireToolCall、协议专用 RequestId/ClientId、条目信息、信封和方法类型。后续模块自行定义自己的标识。

- [ ] **Step 1: 编写错误类失败测试。** `errors.test.ts` 从公开入口导入 PiscesError。断言 `new PiscesError("storage.io", "write failed", {data: {operation: "append"}, cause})` 是 Error，name 为 PiscesError，code/message/data/cause 原样保留；省略 options 时 data/cause 为 undefined。
- [ ] **Step 2: 验证红灯。** 运行 `pnpm test packages/core/test/errors.test.ts`，预期因公开入口没有 PiscesError 而失败。
- [ ] **Step 3: 实现契约。** 按文件职责添加上述类型与详设 §8.4 错误类；不把 SessionNode 的宽泛 kind/role 字段改写为更窄的判别联合，不把 schemaVersion 字段改为字面量类型。类型本身不写运行时占位测试。
- [ ] **Step 4: 验证。** 运行 `pnpm test packages/core/test/errors.test.ts`、`pnpm typecheck`、`pnpm build`，全部退出 0。tsc 检查生产类型与既有配置兼容，不新增仅重述类型的测试。
- [ ] **Step 5: 提交。** `git status --short` 确认变更归属后，显式暂存本任务四个源码文件和 errors.test.ts，提交 `feat(core): define session domain contracts`。不暂存计划或其他智能体文件。

### Task 2: Sessions 树操作与内存仓库契约测试

**Files:**
- Create: `packages/core/src/sessions/sessions.ts` — createSessions。
- Create: `packages/core/test/support/memory-session-repository.ts` — 测试专用仓库。
- Create: `packages/core/test/sessions.test.ts` — 树与失败语义。
- Modify: `packages/core/src/index.ts` — 导出 createSessions。

**Interfaces:**
- Consumes: Task 1 的 SessionRepository、SessionsDeps、Sessions、SessionNodeDraft、SessionNode、SessionMeta、PiscesError。
- Produces: `createSessions(deps: SessionsDeps): Sessions`，所有 Sessions 方法采用详设 §4.1 签名。
- 测试替身：`MemorySessionRepository implements SessionRepository`；`failNextWrite(operation: "create" | "append" | "updateMeta", error: Error): void` 在提交前抛指定错误。替身使用 clone 隔离已提交数据，所有校验在替换 Map 条目前完成。
- 替身读不存在会话抛 session.not_found；指定未知/外会话节点抛 session.node_not_found；从根到指定末端返回分支，readTree 返回追加顺序。create 不覆盖现有会话；不验证生产磁盘格式。

- [ ] **Step 1: 添加测试夹具与树测试。** 固定 `now` 返回 `2026-11-06T13:00:00.000Z`，newId 顺序返回 n1、n2……（显式断言为 NodeId）；meta 为 id=s1/model=m/provider=p/workspace=/workspace/schemaVersion=1。草稿用 agent/user、text 块、source=create。通过公开工厂创建会话：create 两节点期望 `(n1,n1),(n2,n1)`；默认 append 两节点期望 `(n3,n2),(n4,n3)`，所有新节点时间相同且版本为 1。树等于四节点，旧内容与父指针未改变。
- [ ] **Step 2: 验证红灯。** 运行 `pnpm test packages/core/test/sessions.test.ts`，预期缺少 createSessions 导出而失败。
- [ ] **Step 3: 实现最小树写入。** 在 sessions.ts 生成整批节点：每节点分别调用 newId/now，首根自指，后续按前节点串联。只在仓库写入成功后返回整批；append 在编号前读取并确认父节点。实现直接转发读取/list/updateMeta；不用运行状态或 head 缓存。
- [ ] **Step 4: 验证初始绿灯。** 运行 `pnpm test packages/core/test/sessions.test.ts`，预期已有树测试通过。
- [ ] **Step 5: 添加分支和输入失败测试。** 先构建 n1→n2→n3，再从 n1 append 得 n4，默认读取应为 [n1,n4]，显式 n3 为 [n1,n2,n3]，readTree 为 [n1,n2,n3,n4]；读 n3 后默认 append n5 的 parentId 仍为 n4。第二会话节点、未知节点分别作为 s1 的 parent 均拒绝 session.node_not_found，树保持原状。create/append 空数组拒绝 TypeError 且 repository 写入、newId、now 都不调用；不存在会话 append 保留 session.not_found。独立读取不存在节点也保留错误码。
- [ ] **Step 6: 红灯后补实现并验证。** 运行 `pnpm test packages/core/test/sessions.test.ts`，确认新增失败断言对应未完成逻辑（测试直接通过则记录已有覆盖，不刻意破坏实现）；补最少代码后重新运行，预期全部通过。
- [ ] **Step 7: 添加原子性和转发测试。** create 故障后 list 为空、readTree(s1) 抛 session.not_found；成功重试后有完整批次。append 故障后 readTree/默认分支等于提交前快照，重试 parent 指向失败前末端（允许 id/时间已被消费）。updateMeta 故障后旧 meta 完整保留；成功时仅 model/provider 改变，即使输入 id/workspace/createdAt/schemaVersion 不同也保留旧字段。每次失败均断言捕获对象与注入 Error 为同一对象。另用 spy repository 返回会在 yield 一个节点后抛错的 iterable，断言 Sessions 返回同一 iterable 且迭代抛同一错误；list/updateMeta 原样委派。测试读取返回值被调用方修改后仓库已有记录不变，验证替身没有意外共享引用。
- [ ] **Step 8: 红灯后完成失败行为。** 运行 `pnpm test packages/core/test/sessions.test.ts`；确认故障针对提交前边界生效，再补所需最少实现。成功条件是无 meta/半批记录泄漏、无吞错、无错误默认末端。避免把原子性重写进 Sessions；由 repository 契约和替身提交点负责。
- [ ] **Step 9: 最终验收。** 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm exec biome check packages/core/src packages/core/test`，全部退出 0。若格式检查失败，只格式化本任务文件后重跑受影响检查。检查 core 新源码没有 node:*、protocol、daemon、文件系统或网络导入。
- [ ] **Step 10: 提交。** `git status --short` 验证文件归属后，仅显式暂存 sessions.ts、memory-session-repository.ts、sessions.test.ts 和 index.ts，提交 `feat(core): implement append-only session trees`。不推送。

## 后续里程碑与已批准裁定

本计划覆盖详设 Sessions 全接口及其最小类型依赖，公共类型其余部分随所属模块实现；不代表详设全量交付。真实 SessionStore、存储损坏校验、磁盘事务和并发锁单独验收。

主智能体已批准两项文档未明说的策略：空 drafts 使用 TypeError；updateMeta 的不可变字段限制由 repository 履约，Sessions 原样委派。执行方法由主智能体安排，无需再次向用户确认。用户指定在 dev-codex 原地开发，不创建新 worktree。若改变裁定，先更新相应步骤和断言，不新增未经设计的协议错误码。

pnpm 若因沙箱中的包管理器存储锁受阻，可使用等价本地命令：`node_modules/.bin/vitest run`、`node_modules/.bin/tsc -p tsconfig.json`、`node_modules/.bin/tsc -b tsconfig.build.json`、`node_modules/.bin/biome check packages/core/src packages/core/test`，单文件测试在 vitest run 后追加路径。

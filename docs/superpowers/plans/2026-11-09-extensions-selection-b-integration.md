# Extensions Gateway Integration (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于已验收的 A binding/Core 契约，交付声明审查、Gateway/宿主接线和真实 socket 扩展闭环。

**Architecture:** Gateway 通过 A 的服务创建/恢复会话 binding，在锁内富化并一次入队，使用 Core 验证而不重写选择算法。公开宿主仅新增目录 options，认证/marker/停机逻辑保持既有语义。沿用原任务编号 7–11。

**Tech Stack:** TypeScript/ESM、Node >=22.19.0、pnpm/Vitest、现有 Linux 原生模块；依赖使用 A 验收锁文件，不重新选 loader/库版本。

**Spec:** `docs/superpowers/specs/2026-11-09-extensions-selection-design.md`（已批准），主要 §4.1、§8–11；前置为 A 的实际验收与下述最小接口契约，不是 A 的规划提交。

## Global Constraints

- 本计划待用户审阅，尚未开始实施；在 `dev-pi` 顺序工作，不建 worktree、不向 main 提交、不 push/merge，保留旧 SDD 资料。
- 必须读入口索引 `2026-11-09-extensions-selection.md` 的门禁 G；每次提交执行原生构建、完整 Vitest、两项 tsc、Biome、边界扫描，仅显式暂存本任务文件。
- Core 无文件/环境 I/O，不依赖 daemon/protocol；发现不执行扩展代码，工具/包装器 invoke 时才装载，来源按需固化。
- `package#name`；`foo.ts.meta.json`；技能相邻 `foo.meta.json` + `SKILL.md`；只有 wrapper 接受条目配置。
- 配置内置默认 < 全局 < 工作区；defaultWorkspace 仅全局且为绝对路径，provider/model 成对；显式 extensions 替换默认，空数组禁用全部默认。
- SHA-256 + 对象键排序 JSON、数组顺序不变；每会话独立冻结 inventory/Tools/配置/装载 promise；不承诺沙箱、依赖树锁定或热重载。
- selection 保留真实异或，executionSelection 决定执行；stale 不改历史、不进入请求工具、不参与包装。DefinitionSnapshot 只覆盖 tool/wrapper，不提升 schemaVersion。
- 保留 Linux SO_PEERCRED、读协议前认证、marker 恢复和不完整停机保锁；256 KiB 条目、1 MiB 队列、4 MiB 响应/事件、8 MiB 帧。
- 不交付 CLI、凭据管理、模板、provider/client 扩展装配、session.list 或跨平台传输；远端 CI 未实际运行不得称通过。

- 所有 tool/wrapper toggle 均带完整可用快照，关闭缺失旧条目可用历史快照；不因删除前序声明或换分支改写幸存正文。

## Review Focus

1. 删除前序声明/换历史分支不能缺定义或静默重写已审查内容（Tasks 7/9）。
2. 新建失败/并发会话/重启不得遗留 runtime、串用 binding 或用新默认值改旧 meta（Task 8）。
3. 巨型 UTF-8 snapshot 必须安全报错且连接仍可用，配置/异常秘密不外泄（Tasks 9/11）。
4. steer 在实际活跃分支校验，且先于 confirm/marker/registerTurn；不以默认分支偷换目标（Task 9）。
5. 公开宿主配置模式互斥、dist 加载身份、真实 socket 取消/停机不能绕过既有安全边界（Tasks 10/11）。

---

## 来自 A 的最小接口契约（接手时核对实际代码）

下列为 B 直接依赖，足以开始 Task 7；无需加载 A 的内部清点/loader 实现全文。类型来自既有 `@pisces/core` 或指定文件，返回对象隔离副本。

| 定义位置 | B 消费的契约 |
|---|---|
| daemon `extensions/types.ts` | `ExtensionsOptions { configDir: string; builtinDir?: string }` |
| 同上 | `ExtensionConfig { defaultWorkspace?: string; defaultProvider?: string; defaultModel?: string; extensions?: EntryName[]; entryConfig?: Record<string, JsonObject> }` |
| 同上 | `Inventory { hash: string; entries: EntryInfo[] }` |
| 同上 | `ExtensionIssue { code: "extensions.invalid" \| "extensions.duplicate" \| "extensions.unsupported_contribution"; source: string; name?: EntryName }` |
| 同上 | `ExtensionBinding { workspace: string; config: ExtensionConfig; inventory: Inventory; issues: readonly ExtensionIssue[]; entries: ContextEntries; skills: Skills; sources: ContextSourceRegistry; tools: Tools }` |
| 同上 | `Extensions { readGlobalConfig(): Promise<ExtensionConfig>; prepare(workspace: string): Promise<ExtensionBinding> }` |
| daemon `extensions/extensions.ts` | `createExtensions(options: ExtensionsOptions): Extensions` |
| Core `context/types.ts` / public index | `SelectionView { selection: SelectionState; definitions: DefinitionSnapshot[]; contentNames: EntryName[] }` |
| Core `context/selection.ts` / public index | `replaySelection(branch: readonly SessionNodeDraft[]): SelectionView`；`applyDeclarations(view: SelectionView, pending: readonly SessionNodeDraft[]): SelectionView` |
| 同上 / public index | `evaluateSelection(view: SelectionView, entries: ContextEntries): SelectionEvaluation` |
| Core public types | `EffectiveEntry { name: EntryName; definitionHash?: string; configHash?: string; stale: boolean }`；`SelectionEvaluation { effective: EffectiveEntry[]; executionSelection: SelectionState; contentSelection: SelectionState; unresolvedSources: EntryName[] }` |
| Core Context | `viewFor(nodeId?: NodeId): Promise<SelectionView>`；`validateQueue(nodeId?: NodeId): Promise<void>`，两者均由调用方持会话锁，验证不确认/写盘/发事件 |
| Core ContextEntries | `kind(name: EntryName)` 沿用原签名；新增可选 `matchesDefinition?(definition: DefinitionSnapshot): boolean`，纯同步 |
| Core AssembledContext / driver | 可选 `executionSelection?: SelectionState`；driver invoke 使用该字段，缺省 fallback 到 selection |

必须延续的语义：每 prepare 重扫但不导入插件，每 binding 独立；all-toggle snapshots、不可变已审查正文、类型校验在覆盖旧定义之前。未知缺失来源与 known-kind 规则按设计 §8.4，不复制另一套 XOR 或 stale 算法。B 只从 inventory.entries 富化定义，不能访问 A 内部 loader/records 或在会话锁里转译。

## B 启动门槛与上下文恢复

1. 只读入口索引、本计划、A→B 交接记录、设计 §4.1/8–11；需要具体元数据时再定点读 §5–7，不要求读 A 或全部 HLD/DDS。
2. 核对交接 READY、A 验收完整 SHA/审查/loader 证据；`git branch --show-current`、`git status --short`、`git merge-base --is-ancestor <A验收SHA> HEAD`；先解释后续提交和工作树差异，不能 reset 用户文件。
3. 对照上表核对实际 exports/types/context；只读涉及文件。接口漂移或 Important 未关闭即暂停交接，不临时猜适配器。
4. 新鲜运行入口索引的门禁 G，再定点运行 A 的 `extensions-binding`、`extensions-loader`、`context-selection`、`context-selection-runtime` 测试；已有 RED/GREEN 证据不重造，能力或环境不满足则暂停。
5. 从 Task 7 开始；每次给子智能体约束+本任务+直接消费的接口行+设计相关段落，不附 A 全文或父会话。中断时记录任务/步骤、提交、未提交文件归属、下一命令与问题原文路径。

## 文件职责与任务关系

| 文件组 | 职责 | Task |
|---|---|---|
| daemon `extensions/declarations.ts` | 客户端 toggle 校验与原子富化 | 7 |
| daemon `gateway/extension-session.ts`、gateway/protocol | 默认值解析、会话 binding 接线 | 8 |
| daemon `gateway/extension-view.ts`、gateway/protocol | 快照、队列与确认前验证 | 9 |
| daemon host/index、dist 子进程 fixture | 公开启动装配 | 10 |
| `extensions-socket.test.ts`、HLD/DDS、运维/扩展文档 | 真实协议验收与契约状态 | 11 |

依赖：A READY → 7→8→9→10→11。不要重做 A；详细路径、命令和接口见各任务。

### Task 7: 原子声明富化与不可变审查内容

**Files:** Create `packages/daemon/src/extensions/declarations.ts`; Test `packages/daemon/test/extensions-declarations.test.ts`。

**Interfaces:**
- Consumes ExtensionBinding、SelectionView、applyDeclarations/replay 规则、现有 QueueEntryInput。
- `enrichQueueEntries(binding: ExtensionBinding, view: SelectionView, pending: readonly QueueEntryInput[], inputs: readonly unknown[]): QueueEntryInput[]`。
- 接受 agent 输入及客户端单 text `{toggle}` declaration；输出可信、深复制、附完整 snapshots 的整批输入，不分配 id、不入队、不确认。pending 用于名称/开关验证，不能将 pending definitions 当成已持久化快照对外展示。

- [ ] **Step 1: 写失败测试。** 内联 definitions（含空数组）、未知 payload 字段、重复名和非法 control 全部整体失败；每个可用 tool/wrapper toggle 都带 snapshot，含看似关闭的条目。字节预算由 Task 8 的真实 Context.enqueue 测试负责，不要求无 id 的纯富化函数预测最终队列大小。
  ```ts
  expect(off.definitions).toEqual(on.definitions);
  expect(() => enrichQueueEntries(binding, view, [], [agent, forged])).toThrowError();
  expect(view).toEqual(beforeView);
  expect(pending).toEqual(beforePending);
  ```
  覆盖 A 开/B 关后删除 A 仍能开启；默认分支关转历史分支开；缺失旧条目关闭附历史快照；同会话已知跨类型重新开启拒绝，不能先覆盖定义再检测。合法关闭缺失内容来源可入队，但在其他分支反转时由 Core 安全 source_failed。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/daemon/test/extensions-declarations.test.ts`。
- [ ] **Step 3: 实现富化。** 复用 Core 选择函数处理 XOR，不在 daemon 复制算法；只解析客户端 `{toggle}`，source 不影响授权，所有定义取 binding 或允许关闭的历史完整快照。无副作用预检，最终 queue 字节/id/createdAt 精确预算仍由 Context.enqueue 在一次调用中原子完成；本 helper 不臆造服务端 id。
- [ ] **Step 4: GREEN。** 重跑声明与 Core selection/runtime 测试，确认幸存声明无需补写定义。修改返回对象不能污染 binding 或旧队列。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/extensions/declarations.ts packages/daemon/test/extensions-declarations.test.ts
  git commit -m "feat(daemon): enrich reviewed declarations atomically"
  ```

### Task 8: Gateway 会话绑定、默认值解析与声明入口

**Files:** Create `packages/daemon/src/gateway/extension-session.ts`; Modify `gateway/{gateway,protocol}.ts`; Test Create `packages/daemon/test/gateway-extensions.test.ts`; Modify `gateway-session-create.test.ts`、`gateway-queue.test.ts`。

**Interfaces:**
- GatewayDeps 新增 `extensions?: Extensions`（内部服务实例，不是公开目录 options）；和 defaults/createTools/entries/skills/sources 手动模式互斥。
- `prepareExtensionSession(extensions: Extensions, params: CreateSessionParams, validateWorkspace: (workspace: string) => Promise<boolean>): Promise<{ binding: ExtensionBinding; workspace: string; provider: string | undefined; model: string | undefined; extensions: EntryName[] }>`；模型是否注册由 Gateway 校验。
- SessionRuntime 保存可选 binding；createRuntime 接受可选 binding，Context 与所有新 turn 使用同一 binding。runtimeFor 已落盘会话仅 prepare 一次并保持既有 meta，不按新默认值改 provider/model。

- [ ] **Step 1: 写失败测试。** 显式/默认非空选择产生未确认声明；空数组覆盖；provider/model 显式缺一不从默认补齐；省略 workspace 只用全局 defaultWorkspace；工作区默认模型有效但显式模型优先。失败不留 runtime、队列或空会话目录。
  ```ts
  expect(read.selection).toEqual([]);
  expect(read.queue.find(e => e.role === "declaration")?.confirmedAt).toBeUndefined();
  expect(await store.list()).toEqual([]);
  expect(imports).toBe(0);
  ```
  两个并发 session.create 同 workspace 得到独立 binding；重启后使用 meta.workspace 清点、旧定义 stale，不覆写历史。增加大 declaration 使完整条目超过 262144 字节、批量超过 1048576 字节的边界测试（含服务端 id/时间），失败时整批队列和事件计数不变。无 Extensions 的旧拒绝路径仍通过。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/daemon/test/gateway-extensions.test.ts packages/daemon/test/gateway-session-create.test.ts packages/daemon/test/gateway-queue.test.ts`。
- [ ] **Step 3: 接入。** prepare 不执行插件且在新 runtime 前完成；锁内将 prompts+富化声明一次 enqueue。runtimeFor 的绑定创建可在同会话锁中完成纯文件读取但不得嵌套 runExclusive/装载插件；失败不缓存半成品。queue.enqueue 仅配置驱动模式调用富化 helper，然后一次 context.enqueue。将来自扩展服务的未知异常映射固定安全消息，不能让 loader 构造的 PiscesError 绕过安全边界。保持当前协议控制输入拒绝未启用扩展的语义。
- [ ] **Step 4: GREEN。** 运行上述文件与 gateway-turn、gateway-session-read；验证 per-turn 不再生成失去 binding 的空 Tools。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/gateway/extension-session.ts packages/daemon/src/gateway/gateway.ts packages/daemon/src/gateway/protocol.ts packages/daemon/test/gateway-extensions.test.ts packages/daemon/test/gateway-session-create.test.ts packages/daemon/test/gateway-queue.test.ts
  git commit -m "feat(daemon): attach extension bindings to gateway sessions"
  ```

### Task 9: 快照、队列路由与确认前类型校验

**Files:** Modify `packages/daemon/src/gateway/{gateway,protocol}.ts`; Create `packages/daemon/src/gateway/extension-view.ts`; Test Create `packages/daemon/test/gateway-extensions-view.test.ts`; Modify `gateway-queue.test.ts`、`gateway-turn.test.ts`、`gateway-subscriptions.test.ts`。

**Interfaces:**
- Produces protocol types `EntriesSnapshotParams { sessionId: SessionId }`、`EntriesSnapshotResult { entries: EntryInfo[]; selection: SelectionState; effective: EffectiveEntry[] }`；`QueueEditParams { sessionId: SessionId; id: QueueEntryId; content: ContentBlock[] }`、`QueueRemoveParams { sessionId: SessionId; id: QueueEntryId }`、`QueueClearParams { sessionId: SessionId }`，edit/remove 返回 `{ id: QueueEntryId }`，clear 返回 `{ ids: QueueEntryId[] }`。
- `extensionSnapshot(binding: ExtensionBinding | undefined, view: SelectionView): EntriesSnapshotResult`：无 binding 且无条目时返回空 entries 与真实 selection；不泄漏 config/路径/execute。
- 所有路由仍经 Gateway.handle；无需增加 protocol 包的 Core 依赖。

- [ ] **Step 1: 写失败测试。** snapshot 临时 selection/effective 空、pending toggle 不混入、已固化 stale 可见；edit 未确认 agent 成功、confirmed 锁定、未确认 control invalid_control；remove confirmed 可删除，未知 id not_found；clear 在 running/cleanup/cleanup_failed 全部拒绝且零部分变化。
  ```ts
  expect(snapshot.selection).toEqual(persistedSelection);
  expect(snapshot.effective).toEqual(expectedEffective);
  expect(JSON.stringify(snapshot)).not.toContain(secretConfigValue);
  expect(queueEventsAfter - queueEventsBefore).toBe(1); // 一次变更，只由 Core 发布
  ```
  增加 inventory 快照超限：Gateway 返回安全 protocol.frame_too_large，连接仍可处理下一小请求；UTF-8 多字节与响应信封总大小（含 request id）计入 4194304 预算，不靠字符数。嵌套错误秘密不出现在响应/事件。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/daemon/test/gateway-extensions-view.test.ts packages/daemon/test/gateway-queue.test.ts packages/daemon/test/gateway-turn.test.ts packages/daemon/test/gateway-subscriptions.test.ts`。
- [ ] **Step 3: 实现路由与安全投影。** 同会话锁内 initialize/viewFor/操作。snapshot helper 返回 clone，Gateway 在响应前对完整 envelope UTF-8 预检；新增结果不能让纯读取导致 connection encode 超限断连。turn.start 对选定分支调用 validateQueue，置于 marker/confirm/registerTurn 之前；steer 也在 confirm 前校验其待执行分支，不能默认读取无关分支。SessionRuntime 保存该 turn 的原始 startNodeId/startOffset：steer 锁内先 initialize 协调 pending；若已提交偏移大于 startOffset，当前 turn 已追加，使用默认最新提交分支，否则用原 startNodeId。临时会话首次提交后同样按偏移判断。该规则依赖既有同会话唯一活跃 turn/唯一写入者，不新增 callback 或按事件时间猜端点。测试显式旧分支首次提交前/后 steer，及提交后 storage.io 的重读协调；不能只按 append promise 成功来更新游标。
- [ ] **Step 4: GREEN。** 重跑路由测试；跨类型拒绝保持队列、marker、activeTurns 不变；A 开/B 关删除 A 的正常同类型分支仍可确认；两连接只收到各自订阅事件。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/gateway/gateway.ts packages/daemon/src/gateway/protocol.ts packages/daemon/src/gateway/extension-view.ts packages/daemon/test/gateway-extensions-view.test.ts packages/daemon/test/gateway-queue.test.ts packages/daemon/test/gateway-turn.test.ts packages/daemon/test/gateway-subscriptions.test.ts
  git commit -m "feat(daemon): expose extension snapshots and reviewed queue operations"
  ```

### Task 10: 公开宿主装配与编译后入口验收

**Files:** Modify `packages/daemon/src/host/daemon-host.ts`、`src/index.ts`; Modify `packages/daemon/test/daemon-start.test.ts`; Create `packages/daemon/test/extensions-host.test.ts`、`test/fixtures/extensions-child.mjs`。

**Interfaces:**
- 公开 StartDaemonOptions 增加 `extensions?: ExtensionsOptions`，不能误用 GatewayDeps 的 Extensions 服务类型；以 `Omit<...>` 或明确 union 区分。
- `startDaemon` 构造服务后交给 bootstrapGateway；仍要求 providers/providerHost。服务类型/公开 options 从 daemon index 导出；不公开认证或任意 store/marker 注入。

- [ ] **Step 1: 写失败测试。** 测试名 `public host rejects mixed extension composition before listening`：混合 extensions 与 defaults/entries/skills/sources/createTools 任意一项失败，无监听、锁可重取。
  ```ts
  await expect(startDaemon(mixedOptions)).rejects.toMatchObject({ code: "daemon.start_failed" });
  expect(await socketExists(socketPath)).toBe(false);
  await expect(reacquireLock(dataDir)).resolves.toBeDefined(); // fixture finally 释放句柄
  ```
  另测公开 startDaemon 指定目录创建有扩展会话、无 extensions 旧启动流程不变，非 Linux 在读取扩展目录/导入原生前拒绝。
- [ ] **Step 2: RED。** 原生构建与 `pnpm exec tsc -b tsconfig.build.json` 后，`pnpm exec vitest run packages/daemon/test/extensions-host.test.ts packages/daemon/test/daemon-start.test.ts`；编译后子进程从 dist 导入，不借助 Vitest alias。
- [ ] **Step 3: 装配服务。** 平台/进程身份检查顺序不后移；配置错误/prepare 错误发生在 session.create 时返回对应安全错误，不让可隔离扩展损坏阻断 daemon。启动模式互斥在监听前检查并走已有释放逻辑。default builtin 定位由导入文件 URL 决定，改变 cwd 不影响结果。
- [ ] **Step 4: GREEN。** 有界 dist 子进程接真实 socket，调用 snapshot、确认执行一个 TS 工具；finally 先 stop 或 kill+reap，再删除 fixture。验证停止、失败重试与此前真实身份回归没有新旁路。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/host/daemon-host.ts packages/daemon/src/index.ts packages/daemon/test/daemon-start.test.ts packages/daemon/test/extensions-host.test.ts packages/daemon/test/fixtures/extensions-child.mjs
  git commit -m "feat(daemon): compose extension services in the public host"
  ```

### Task 11: 真实 socket 纵向验收与契约文档同步

**Files:** Create `packages/daemon/test/extensions-socket.test.ts`、`docs/extensions.md`; Modify `docs/daemon-linux.md`、`docs/1 High-Level Design/1 High-Level Design.md`、`docs/2 Detailed Design Specification/2 Detailed Design Specification.md`。

**Interfaces:** 消费已公开 startDaemon/options、NDJSON 协议和临时 fixture；不新增生产测试控制接口。文档明确本阶段仅可选择条目，不把 providers/clients 或 CLI 写成可用。

- [ ] **Step 1: 写端到端失败测试/敏感性检查。** 真实 Unix socket 上 hello → create → subscribe → snapshot → enqueue → edit/remove → turn.start → 多 step 假供应商的工具调用与最终节点。fixture 含 tool/wrapper/skill/context 四类，调用来自真实加载器，不以伪 binding 代替。若所有行为已绿，临时禁用一个关键资格/富化分支证明测试 RED，并恢复；记录为 mutation sensitivity，不伪称原始 TDD RED。
  ```ts
  expect(capturedRequests[0]?.tools).toEqual(frozenDeclarations);
  expect(importCountBeforeFirstInvoke).toBe(0);
  expect(persistedNodes.some(n => n.role === "declaration")).toBe(true);
  expect(protocolTranscript).not.toContain(secret);
  ```
  覆盖取消选择后过滤内容、重新选择复用来源、零片段重试、ignored abort 不提交、清点冲突隔离、断开客户端不取消 turn。超限 snapshot 后同一连接仍可 provider.list；延续订阅 seq 和完整 queue.updated。
- [ ] **Step 2: 运行并记录证据。** `pnpm exec vitest run packages/daemon/test/extensions-socket.test.ts`；不得跳过用户已要求的真实 socket/异 UID 前提。失败先定位根因，不为通过而放宽生产认证或修改 stop 锁规则。
- [ ] **Step 3: 最小集成修正与文档。** 修正仅限本阶段接线缺口；HLD/DDS 统一 wrapper 首次 invoke、sidecar/config/ABI、all-toggle snapshots、selection/effective/类型变化边界和已实现路由。说明旧会话如何 stale、如何重新选择，以及未哈希依赖树/skill-context 历史限制。提供实际可复制的配置和包示例，不新增样例专用协议。
- [ ] **Step 4: 完整验证。** 执行 G，另运行 dist 子进程 fixture；记录真实通过/跳过数、Node/平台与边界扫描退出码。远端 CI 未运行则显式标记，不能借前阶段本机 751/1 宣称本阶段覆盖。
- [ ] **Step 5: 显式暂存验收与上述四个文档，提交。** 若确有集成代码修正，先审查 diff 后逐个显式加入，不使用 git add . 或 -A。
  ```bash
  git add packages/daemon/test/extensions-socket.test.ts docs/extensions.md docs/daemon-linux.md "docs/1 High-Level Design/1 High-Level Design.md" "docs/2 Detailed Design Specification/2 Detailed Design Specification.md"
  git commit -m "feat(daemon): verify and document transparent extension selection"
  ```

## B 验收与自审

- [ ] Tasks 7–11 各自证据与独立任务审查完成；重点核对 all-toggle snapshots、目标分支、UTF-8 预算与原生认证没有退化。
- [ ] 独立整体审查覆盖 A 验收点之后的 B diff，并核对跨 A/B 接口；涉及 A 内部的发现须明确定位，不能自动展开无界重审/修复波。
- [ ] 最终 HEAD 新鲜运行门禁 G、dist 子进程与真实 socket 验收，记录实际结果；更新交接记录为 B 完成状态时保留原 A 验收证据。
- [ ] 用户授权前不 push/merge；分支、工作树、未交付能力与 remote CI 状态如实报告。

**范围自审：** §8.1 由 Task 7、§4.1/会话创建由 Task 8、§8.2/9 由 Task 9、公开宿主由 Task 10、§10–11 与完整契约同步由 Task 11 覆盖。A 已完成的 §5–7/8.3–8.4 只消费其接口，不要求新智能体恢复旧对话。测试片段中的临时文件/counter 工具是本地 fixture helper，不是遗漏生产接口。

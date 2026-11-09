# Extensions Foundations (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可独立测试的扩展基础服务、Core 执行资格和每会话 binding；不接通 Gateway 新协议路由。

**Architecture:** 配置/清点/惰性 loader 在 daemon，纯选择与资格判定在 Core。Task 6 将两者组合成独立 binding，作为 Plan B 唯一的服务层交接边界。沿用原任务编号 1–6，不跨阶段提前写接线。

**Tech Stack:** TypeScript/ESM、Node >=22.19.0、pnpm12.8.1/Vitest；SHA-256、Ajv8.20.0 draft-07、tinyglobby0.2.17、jiti2.7.0。原版 jiti 的 CJS 门槛失败；局部补丁设计已批准，正式实现按 Task3 修订计划验证。

**Spec:** `docs/superpowers/specs/2026-11-09-extensions-selection-design.md`（已批准）；本计划主要对应 §3–7、§8.3–8.4。Task3 另遵守 [已批准补丁设计](../specs/2026-11-09-extension-loader-jiti-patch-design.md)，其 [专项修订计划](2026-11-09-extension-loader-jiti-patch.md) 已获用户确认并进入正式实现。与后续声明交接相关的 §8.1 保留完整快照语义。

## Global Constraints

- 本计划已获用户实施授权，Tasks 1–6 已完成：代码验收 SHA `e57f793`，A 范围整体审查完成（无 Critical；2 项 Important 已关闭），交接 READY；Plan B 亦已完成（代码验收 `ce1281d`）。先读 [当前交接](../handoffs/2026-11-09-extensions-selection-a-to-b.md)；下方任务正文/checkbox 保留规划模板，不得据此重复已完成任务。Plan B 未授权。在 `dev-pi` 顺序工作，不建 worktree、不向 main 提交、不 push/merge，保留旧 SDD 资料。
- 必须读入口索引 `2026-11-09-extensions-selection.md` 的门禁 G；每次提交执行原生构建、完整 Vitest、两项 tsc、Biome、边界扫描，仅显式暂存本任务文件。
- Core 无文件/环境 I/O，不依赖 daemon/protocol；发现不执行扩展代码，工具/包装器 invoke 时才装载，来源按需固化。
- `package#name`；`foo.ts.meta.json`；技能相邻 `foo.meta.json` + `SKILL.md`；只有 wrapper 接受条目配置。
- 配置内置默认 < 全局 < 工作区；defaultWorkspace 仅全局且为绝对路径，provider/model 成对；显式 extensions 替换默认，空数组禁用全部默认。
- SHA-256 + 对象键排序 JSON、数组顺序不变；每会话独立冻结 inventory/Tools/配置/装载 promise；不承诺沙箱、依赖树锁定或热重载。
- selection 保留真实异或，executionSelection 决定执行；stale 不改历史、不进入请求工具、不参与包装。DefinitionSnapshot 只覆盖 tool/wrapper，不提升 schemaVersion。
- 保留 Linux SO_PEERCRED、读协议前认证、marker 恢复和不完整停机保锁；256 KiB 条目、1 MiB 队列、4 MiB 响应/事件、8 MiB 帧。
- 不交付 CLI、凭据管理、模板、provider/client 扩展装配、session.list 或跨平台传输；远端 CI 未实际运行不得称通过。

## Review Focus

1. 冻结后源码/配置变化不得执行未审查入口（Tasks 3/6）。
2. TSX、paths、静态/动态宿主导入不能产生第二份宿主实例（Task 3）。
3. 不同 workspace/并发新会话同名条目不得共享注册表、配置或 promise（Task 6）。
4. 移除或改变条目类型不能执行新实现、误报缺失来源为存储损坏（Tasks 4/5）。
5. 清点坏 JSON/schema/重复名必须隔离，秘密与原型污染不能穿过元数据边界（Tasks 1/2）。

---

## 阅读预算、文件职责与任务关系

执行者读入口索引 + 本计划 + 设计对应章节，不读 Plan B 全文或旧对话。向单任务子智能体仅发送本节约束、该任务、其直接接口、相关设计段落及上个任务报告摘要；不要附整个父会话。每任务结束落盘提交/验证/审查记录，下一任务使用新上下文。

| 文件组 | 职责 | Task |
|---|---|---|
| daemon `extensions/{types,hash,config}.ts` | 配置与哈希 | 1 |
| daemon `extensions/{discovery,metadata}.ts`、test `extensions-fixtures.ts` | 只读清点、元数据与临时包 fixture | 2 |
| daemon `extensions/loader.ts`、`patches/jiti@2.7.0.patch`、workspace/lock、专项测试 | 私有 loader、正式补丁与安装复现；具体文件见 Task3 修订计划 | 3 |
| Core `context/selection.ts`、types/index | 纯重放与历史类型/资格 | 4 |
| Core `context/{context,materialize,types}.ts`、`loop/driver.ts` | A/C 重校验、executionSelection | 5 |
| daemon `extensions/extensions.ts`、types | 每会话 binding 组合 | 6 |

依赖 `1→2→3`、`4→5`、`(2,3,4,5)→6`；按编号顺序实施。完整路径、测试与接口以各任务 Files/Interfaces 为准。

### Task 1: 确定性哈希与配置层

**Files:** Create `packages/daemon/src/extensions/{types,hash,config}.ts`; Test `packages/daemon/test/extensions-config.test.ts`。

**Interfaces:**
- Produces `ExtensionsOptions { configDir: string; builtinDir?: string }`。
- Produces `ExtensionConfig { defaultWorkspace?: string; defaultProvider?: string; defaultModel?: string; extensions?: EntryName[]; entryConfig?: Record<string, JsonObject> }`。
- `canonicalJson(value: JsonValue): string`; `sha256(bytes: string | Uint8Array): string`。
- `readConfigLayer(path: string, scope: "global" | "workspace"): Promise<ExtensionConfig>`（ENOENT = 空层，其他读取/格式错误 = 安全 config.invalid）。
- `mergeConfigLayers(layers: readonly ExtensionConfig[]): ExtensionConfig`；`readGlobalConfig(configDir: string): Promise<ExtensionConfig>`；`readWorkspaceConfig(configDir: string, workspace: string): Promise<ExtensionConfig>`（全局+工作区合并；无隐藏进程 cwd）。

- [ ] **Step 1: 写失败测试。** 使用临时文件覆盖工作区禁止 defaultWorkspace、全局 defaultWorkspace 必须绝对路径、未知键、非法 JSON、provider/model 缺一、空 extensions 替换、数组替换与对象递归合并；增加 `__proto__` 自有 JSON 键不污染原型及 ENOENT/其他 I/O 区别。
  ```ts
  expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(mergeConfigLayers([{ extensions: ["p#a" as EntryName] }, { extensions: [] }]).extensions).toEqual([]);
  ```
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/daemon/test/extensions-config.test.ts`；应因缺失行为失败，记录实际失败，不用源码 grep。
- [ ] **Step 3: 实现上述签名。** 配置仅允许五个键；合并结果深复制，不修改输入；无效数据只输出固定安全 code/message，不能插入配置值。
- [ ] **Step 4: GREEN。** 重跑同一文件，全部通过。
- [ ] **Step 5: 完整门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/extensions/types.ts packages/daemon/src/extensions/hash.ts packages/daemon/src/extensions/config.ts packages/daemon/test/extensions-config.test.ts
  git commit -m "feat(daemon): add deterministic extension hashes and config layers"
  ```

### Task 2: 声明式清点与不可变资源快照

**Files:** Create `packages/daemon/src/extensions/{discovery,metadata}.ts`; Modify `extensions/types.ts`、`packages/daemon/package.json`、`pnpm-lock.yaml`; Test `packages/daemon/test/{extensions-discovery.test.ts,extensions-fixtures.ts}`。

**Interfaces:**
- Consumes Task 1 的配置与哈希函数。
- Produces `ExtensionIssue { code: "extensions.invalid" | "extensions.duplicate" | "extensions.unsupported_contribution"; source: string; name?: EntryName }`（source 是包名/固定来源标签，不是原始错误）。
- Produces `DiscoveredEntry { info: EntryInfo; packageRoot: string; entryPath: string; entryDigest: string; wrapperConfig?: JsonObject; wrapperConfigSpec?: { defaults: JsonObject; schema: JsonObject }; skillContent?: ContentBlock[] }`。
- Produces `Inventory { hash: string; entries: EntryInfo[] }`、`DiscoveryResult { inventory: Inventory; records: ReadonlyMap<EntryName, DiscoveredEntry>; issues: ExtensionIssue[] }`。
- `discoverExtensions(options: ExtensionsOptions, workspace: string, config: ExtensionConfig): Promise<DiscoveryResult>`；`defaultBuiltinDir(): string` 相对模块 URL 定位仓库产品根 `extensions/builtin/`，在 src/dist 两种路径均不依赖 cwd。

- [ ] **Step 1: 写失败测试。** scoped 包、目录链接/realpath 去重、同名冲突全部排除、glob+排除、显式清单优先、无 sidecar 缺省、技能只读 SKILL.md；入口含 top-level 写 sentinel 的代码，但清点后 sentinel 不存在。
  ```ts
  expect(result.inventory.entries.map(e => e.name)).toEqual(["@scope/pkg#read", "other#skill"]);
  expect(result.inventory.entries[0]?.definition?.parameters).toEqual({});
  expect(await exists(sentinel)).toBe(false);
  expect(second.inventory.hash).toBe(first.inventory.hash); // 相同字节、扫描顺序/安装路径不同
  ```
  增加包根外入口、缺失正文、坏 sidecar、非法 schema、重复名称、未知用户 entryConfig 和非 wrapper config：坏扩展隔离，非法用户配置以 config.invalid 失败。providers/clients 识别并记 unsupported issue，不装载/不进入 inventory。缺省 builtin 目录暂不存在视为空，不偷偷创建目录。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/daemon/test/extensions-discovery.test.ts`。
- [ ] **Step 3: 实现发现与元数据。** 在加入依赖前通过执行时包元数据核实 `ajv@8` 与已有锁中的 `tinyglobby@0.2.17`；用 `pnpm --filter @pisces/daemon add --save-exact ajv@8 tinyglobby@0.2.17`，提交解析后的精确版本和锁文件。Ajv 固定 draft-07，禁用远程 schema 加载，不接受可执行 validator。所有条目按名称稳定排序；fingerprint 包含入口字节，不包含绝对安装路径。对重读/客户端结果返回副本，不泄露可修改 Map/配置。wrapper 没有 config 时规范化为空 defaults/schema，冻结合并配置的 configHash；definitionHash 严格遵循设计 §6.3 的名称/kind/description/parameters/入口字节配方，不临时把绝对路径或新的字段加入持久化哈希契约。
- [ ] **Step 4: GREEN。** 重跑清点和配置测试，验证原型安全、错误不含 sentinel secret、冻结副本与同名排除；scoped 包根枚举支持 `extensions/@scope/pkg`。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/extensions/types.ts packages/daemon/src/extensions/discovery.ts packages/daemon/src/extensions/metadata.ts packages/daemon/package.json pnpm-lock.yaml packages/daemon/test/extensions-discovery.test.ts packages/daemon/test/extensions-fixtures.ts
  git commit -m "feat(daemon): discover extension metadata without executing code"
  ```

### Task 3: 正式 jiti 局部补丁与宿主身份硬门槛（专项修订）

**唯一执行正文：** [Task3 jiti 补丁实施计划](2026-11-09-extension-loader-jiti-patch.md)。已完成：正式补丁、adapter 接线、三组行为 RED→GREEN、三版本/dist/隔离安装门禁、完整 G 与独立审查（`6527e0f`、`e033032`；审查两项 Important 已修复并经限定复审 clean）。原版 loader 已存在，不重新建文件/解析浮动 jiti@2，也不重新选型。原任务模板由该专项计划替代，Tasks4–6 不变。

**Interfaces（保持不变）：** `DiscoveredEntry`/`sha256` → `ExtensionModule { default: unknown; config?: unknown }`、`ExtensionLoader { load(entry: DiscoveredEntry): Promise<ExtensionModule> }`；`createExtensionLoader(): ExtensionLoader` 按 entryPath+entryDigest 缓存 promise/失败。

- [x] 按专项计划完成模式/JSON/格式的逐组行为 RED→GREEN 与正式 adapter 接线。
- [x] 三个本地 Node 版本、真实 dist、隔离冻结安装/负控及原 CJS 两项正向身份断言通过。
- [x] 完整 G 后提交，独立审查从原 Task3 BASE e4776e6 生成全部 diff，关闭 Critical/Important。

硬门槛已由 controller 接受（审查无 Critical；两项 Important 已修复并限定复审 clean）。延期 Minor 留 A 整体审查：宿主子路径错误消息未在设计中枚举、adapter 级 bare builtin 正控标签不准、测试 helper 重复/重复编译 N-API、`data:` URL 绕过未写入边界文档、交接 HEAD 值待重刷。历史 I1 已接受结论保留。

### Task 4: Core 纯选择视图与历史类型规则

**Files:** Create `packages/core/src/context/selection.ts`; Modify `context/{declarations,types}.ts`、`tools/types.ts`、`src/index.ts`; Test `packages/core/test/context-selection.test.ts`。

**Interfaces:**
- Consumes 现有 `replayDeclarations/parseDeclaration/validDefinition`；共享内部遍历，禁止实现两套 XOR。
- Produces `SelectionView { selection: SelectionState; definitions: DefinitionSnapshot[]; contentNames: EntryName[] }`（排序、隔离副本；contentNames 仅历史 agent/system/source 名称）。
- `replaySelection(branch: readonly SessionNodeDraft[]): SelectionView`。
- `applyDeclarations(view: SelectionView, pending: readonly SessionNodeDraft[]): SelectionView`（pending 跨已知类别换义时 queue.invalid_control；在覆盖旧 definitions 前验证）。
- `ContextEntries` 增加可选 `matchesDefinition?(definition: DefinitionSnapshot): boolean`，仅纯同步哈希匹配。
- Produces `EffectiveEntry { name: EntryName; definitionHash?: string; configHash?: string; stale: boolean }`、`SelectionEvaluation { effective: EffectiveEntry[]; executionSelection: SelectionState; contentSelection: SelectionState; unresolvedSources: EntryName[] }`。
- `evaluateSelection(view: SelectionView, entries: ContextEntries): SelectionEvaluation`；无 matchesDefinition 的旧模式保留原有投影/错误语义，由 Task 5 分支接入，不能让已有手动注入假哈希全 stale。

- [ ] **Step 1: 写失败测试。** XOR、最近定义与分支独立；先 off toggle 后删除前项、同工具历史分支反转；applyDeclarations 不改变 view/pending。按设计 §8.4 逐项覆盖已知历史 tool/wrapper、历史内容、零片段当前来源、完全缺失、必要定义损坏，以及 pending 与目标分支跨类型。
  ```ts
  expect(evaluateSelection(oldToolView, changedInventory).executionSelection).toEqual([]);
  expect(evaluateSelection(oldToolView, changedInventory).effective[0]?.stale).toBe(true);
  expect(evaluateSelection(missingContentView, emptyInventory).unresolvedSources).toEqual([name]);
  ```
  replay 返回数组不暴露内部 Map；畸形存储载荷仍 storage.corrupt，不能因为 unavailable 被吞掉。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/core/test/context-selection.test.ts`。
- [ ] **Step 3: 实现纯函数与类型导出。** contentSelection 包含已选历史内容和可用当前内容来源，不包含历史 tool 被改作 skill 的名字；已固化内容可复用但不执行缺失来源代码。unresolvedSources 在查询中报告，由 Task 5 在装配前转换为 context.source_failed；明确当前 tool 缺必要定义时 storage.corrupt。
- [ ] **Step 4: GREEN。** 重跑选择及已有 `context-materialize/context-queue` 测试；旧声明解析测试仍通过。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/core/src/context/selection.ts packages/core/src/context/declarations.ts packages/core/src/context/types.ts packages/core/src/tools/types.ts packages/core/src/index.ts packages/core/test/context-selection.test.ts
  git commit -m "feat(core): evaluate frozen selection and execution eligibility"
  ```

### Task 5: Context A/C 重校验及 driver 的 executionSelection

**Files:** Modify `packages/core/src/context/{context,materialize,types}.ts`、`loop/driver.ts`; Test Create `packages/core/test/context-selection-runtime.test.ts`; Modify `packages/core/test/loop-tools.test.ts`。

**Interfaces:**
- Consumes Task 4 的 SelectionView/SelectionEvaluation 和纯函数。
- `Context.viewFor(nodeId?: NodeId): Promise<SelectionView>`：宿主持锁，复用 readBranch，不改变选择缓存或 seq。
- `Context.validateQueue(nodeId?: NodeId): Promise<void>`：持锁，针对当前全部待确认队列以目标分支历史验证跨类型，不 confirm、不发布事件、不装载代码；无 matchesDefinition 的旧模式可空操作。
- `AssembledContext.executionSelection?: SelectionState`：新 createContext 返回此字段；driver 使用 `assembled.executionSelection ?? assembled.selection` 保持旧 fake/嵌入式实现兼容。

- [ ] **Step 1: 写失败测试。** selected stale tool 不在 request.tools，stale wrapper sentinel 不执行，公共 selection/selection.updated 不被过滤；provider 伪造未获资格工具调用仍失败。历史来源即使当前 kind 为 tool 也不调用新工具；缺失来源无历史正文时在写库前 source_failed。
  ```ts
  expect(assembled.selection).toContain(toolName);
  expect(assembled.executionSelection).not.toContain(toolName);
  expect(assembled.request.tools ?? []).toEqual([]);
  expect(wrapperCalls).toBe(0);
  ```
  增加 B 段 gate：删除已确认声明、同毫秒取消再确认、仅 definitions 改变、来源忽略 signal。C 段按幸存窗口重新计算工具/资格，丢弃不再允许的来源结果，不新增窗口外条目。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/core/test/context-selection-runtime.test.ts packages/core/test/loop-tools.test.ts`。
- [ ] **Step 3: 接入 A/B/C。** A/C 都使用同一纯重放/资格规则；B 只解析 contentSelection 对应来源。C 的 budget 使用 contentSelection 过滤来源正文，但持久化选择仍使用完整 selection；request.tools 从幸存快照投影，不使用实时 Tools。C 类型冲突/缺失来源在不可逆写入前拒绝。driver 只向 invoke 传执行集合，不改 cancel/cleanup 状态机。
- [ ] **Step 4: GREEN。** 重跑新测及 `context-commit/context-materialize/loop-tools/loop-control`；pending commit 的提交后重读/通知优先级保持原语义。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/core/src/context/context.ts packages/core/src/context/materialize.ts packages/core/src/context/types.ts packages/core/src/loop/driver.ts packages/core/test/context-selection-runtime.test.ts packages/core/test/loop-tools.test.ts
  git commit -m "feat(core): enforce execution eligibility during context assembly"
  ```

### Task 6: 每会话 Extensions binding 与实现代理

**Files:** Create `packages/daemon/src/extensions/extensions.ts`; Modify `extensions/types.ts`; Test `packages/daemon/test/extensions-binding.test.ts`。

**Interfaces:**
- Consumes Tasks 1–5、既有 createTools()。
- Produces `ExtensionBinding { workspace: string; config: ExtensionConfig; inventory: Inventory; issues: readonly ExtensionIssue[]; entries: ContextEntries; skills: Skills; sources: ContextSourceRegistry; tools: Tools }`。
- Produces `Extensions { readGlobalConfig(): Promise<ExtensionConfig>; prepare(workspace: string): Promise<ExtensionBinding> }`、`createExtensions(options: ExtensionsOptions): Extensions`。
- binding 的内部 records 不通过公共接口暴露；Task 7 取定义只需 inventory.entries。所有面对调用方的值隔离，注册对象仅服务内部拥有。entries.matchesDefinition 对名称/kind/definitionHash/configHash 与该 binding 冻结快照逐项比较，不访问磁盘或导入模块。

- [ ] **Step 1: 写失败测试。** 同 workspace 每次 prepare 重扫；不同 workspace 相同名字执行各自实现；旧 binding 保持旧 config、metadata、技能正文和注册表。工具/包装器/来源 top-level sentinel 直到实际 invoke/resolve 才出现。
  ```ts
  expect(await invokeText(left.tools, name)).toBe("left");
  expect(await invokeText(right.tools, name)).toBe("right");
  expect(old.inventory.hash).not.toBe(fresh.inventory.hash);
  expect(await moduleLoadCount(old)).toBe(0); // prepare、selected、snapshot 等不得触发导入
  ```
  schema/defaults 合并结果注入 wrapper 工厂；模块导出 config 不符则 wrapper_invalid，invoke 时修改磁盘覆盖不改变冻结配置。坏模块/拒绝 promise 缓存，不污染其他 binding。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/daemon/test/extensions-binding.test.ts`。
- [ ] **Step 3: 实现组合。** 每 prepare 创建独立 createTools 和 loader；工具注册 execute 异步代理，包装器注册惰性工厂，来源注册 resolve 代理，技能仅返回正文副本。loader 检查入口摘要；不把异步转译放入 ContextEntries.matchesDefinition。冻结失败仅使对应条目不可用；明确的用户配置错误整体返回安全 config.invalid。
- [ ] **Step 4: GREEN。** 重跑 binding、loader、discovery 三组测试，并行调用证明只缓存同 binding 的 promise，而非全局模块身份。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/extensions/extensions.ts packages/daemon/src/extensions/types.ts packages/daemon/test/extensions-binding.test.ts
  git commit -m "feat(daemon): bind isolated extension registries to sessions"
  ```

## A 验收与交接（已完成）

- [x] Tasks 1–6 各自 RED/GREEN、独立任务审查完成；Task 3 的 dist 子进程与 loader 全能力有实际证据。
- [x] 进行 A 范围独立整体审查并关闭 Critical/Important（无 Critical；2 项 Important 已关闭：验收 SHA 三运行时矩阵补录、交接文档重写）。延期 Minor 已逐项处置见交接 §6。
- [x] 在最终 A HEAD 新鲜运行门禁 G，记录完整 SHA、命令、实际通过/跳过数、Node/平台、依赖精确版本；检查工作树归属。
- [x] 填写并提交 `docs/superpowers/handoffs/2026-11-09-extensions-selection-a-to-b.md`；验收 SHA 指向代码验收点 `e57f793`，交接文档提交在其后。
- [x] 核对 Plan B 的最小接口契约与实际代码；偏差写入交接 §4.1（无 `Context.effectiveFor`、`validateQueue` 仅未确认、`applyDeclarations` 含未确认定义、`prepare` 不校验选择/目录、`tools` 只读规则、模块未从包入口再导出）。
- [x] 交接状态改为 READY，报告“A 基础服务完成，协议接线未做”，等待 B 的实施授权。

**范围自审：** 设计 §4/5/6/7 由 Tasks 1/2/3/6 覆盖；§8.3–8.4 的纯语义及装配由 Tasks 4/5 覆盖；五项 Review Focus 均有本计划测试。A 未更新 HLD/DDS 宣称新路由可用（路由接线属 B）。

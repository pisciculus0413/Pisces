# Extensions and Transparent Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Linux daemon 上交付可选择扩展的发现、审查、声明确认、固化与按需执行闭环。

**Architecture:** 服务层 Extensions 创建每会话独立的冻结 binding；Gateway 只从 binding 富化可信声明，不接受客户端 definition。Core 复用既有分支异或、确认代际与 A/B/C 装配，通过纯选择视图和 executionSelection 排除 stale 实现，不引入环境依赖。协议与既有 daemon 安全生命周期不变。

**Tech Stack:** TypeScript/ESM、Node >=22.19.0、pnpm、Vitest；daemon 使用 SHA-256、JSON Schema draft-07（Ajv 8）、tinyglobby、jiti 2。依赖尚未安装；版本和 loader 能力按 Task 2/3 的硬门槛核实，不把本计划当成验证证据。

**Spec:** `docs/superpowers/specs/2026-11-09-extensions-selection-design.md`（2026-11-09 用户批准）。同时阅读 HLD §2.1–2.2/5.2/5.4/6.6 与 DDS §2.3/2.5/3.4–3.6/4.2–4.3/5.5/6.7；冲突处以已批准阶段设计的明确裁定为准。

## Global Constraints

- 在现有 `dev-pi` 顺序工作；起点 `38a089befbc51461422f6d126eb839c88ff5b491`。不建立 worktree，不向 main 提交，不 push/merge，保留此前阶段资料。
- 本计划目前待用户审阅，编写计划不授权开始产品代码实施。
- Core 不读取文件、不执行环境 I/O、不依赖 daemon/protocol；服务层实现发现、哈希、配置和装载。
- 名称为 `package#name`；发现阶段只读取清单、sidecar 与资源，不执行扩展代码。
- 工具/包装器首次 invoke 才加载；来源在需要固化时加载；技能正文清点读取但只在已选装配时固化。
- 每会话独立持有 Tools、配置与装载 promise；不从全局 Tools 派生 facade 充当工作区隔离。
- `foo.ts` → `foo.ts.meta.json`；技能目录 `foo/` → 相邻 `foo.meta.json`；技能正文为 `SKILL.md`。
- 配置优先级：内置默认 < 全局 < 工作区；defaultWorkspace 只允许全局，provider/model 成对解析；显式 extensions 替换默认，空数组禁用全部默认。
- 本阶段只有 wrapper 支持 sidecar.config/entryConfig；配置默认值与 schema 必须声明式可读，不在 invoke 时读新覆盖。
- SHA-256 + 递归排序对象键的 JSON；保留数组顺序；不递归哈希/锁定整个依赖树，不承诺旧依赖重放或沙箱。
- 所有 tool/wrapper toggle 均附可用的完整快照；队列审查后不改写正文，跨分支仍是相对异或。
- selection 是真实选择，executionSelection 是实际执行资格；stale 不改历史或选择，不进 request.tools、不参与包装。
- DefinitionSnapshot 仍只覆盖 tool/wrapper；不增加 SessionMeta/schemaVersion 字段，不宣称 skill/context 有跨重启哈希检测。
- 沿用 256 KiB 条目、1 MiB 队列、4 MiB 响应/事件和 8 MiB 帧预算。
- 保留原生 SO_PEERCRED、同 UID 认证先于读协议、marker 恢复与不完整停机保锁；真实异 UID 测试不能因映射不可用而跳过。
- 不交付 CLI、凭据管理、provider/client 扩展装配、模板、session.list、热重载或跨平台传输。
- 每个行为任务必须保留真实 RED→GREEN 证据；每次提交前运行下方完整门禁，显式暂存本次文件。

## Review Focus

1. 删除前序声明或切换历史分支使关闭 toggle 变开启：正文和定义不能被静默重写（Tasks 4/7/9）。
2. 同名条目被移除或改变类型：不能用新工具替代历史来源，不能把不可判定缺失统称 storage.corrupt（Tasks 4/5/7）。
3. 并发新会话/不同工作区使用同名条目：注册表、模块 promise、配置不得串用；同会话首次调用只加载一次（Tasks 3/6/8）。
4. 巨型 inventory、恶意元数据或带秘密的装载异常：返回有界安全错误，不因只读快照造成断连或泄漏（Tasks 2/9/11）。
5. 冻结后入口/配置变化、TSX/paths/动态宿主导入：不得执行未审查入口或第二份宿主实例（Tasks 3/6/11）。

---

## 文件职责与依赖图

先定义边界，再定义任务；不要继续向 900 行 Gateway 填清单解析或哈希逻辑。

| 文件 | 单一职责 | 任务 |
|---|---|---|
| `packages/daemon/src/extensions/types.ts` | 配置、清点、binding 与服务接口；只含类型 | 1/2/6 |
| `packages/daemon/src/extensions/hash.ts` | canonical JSON、指纹与 SHA-256 | 1 |
| `packages/daemon/src/extensions/config.ts` | 配置层读取、校验、合并 | 1 |
| `packages/daemon/src/extensions/discovery.ts` | 包发现、glob、sidecar/技能读取、重复排除 | 2 |
| `packages/daemon/src/extensions/metadata.ts` | 元数据、wrapper schema/配置校验、清点哈希投影 | 2 |
| `packages/daemon/src/extensions/loader.ts` | 私有 loader、宿主实例映射、入口校验、promise 缓存 | 3 |
| `packages/core/src/context/selection.ts` | 纯分支视图、pending 重放、历史类型与资格判定 | 4 |
| `packages/core/src/context/{types,materialize,context}.ts` | 视图查询、A/C 资格重校验、request 投影 | 4/5 |
| `packages/core/src/loop/driver.ts` | invoke 使用 executionSelection | 5 |
| `packages/daemon/src/extensions/extensions.ts` | 配置/清点/loader 组合为每会话 binding | 6 |
| `packages/daemon/src/extensions/declarations.ts` | 客户端 toggle 验证、完整快照富化、整批原子预检 | 7 |
| `packages/daemon/src/gateway/extension-session.ts` | Gateway 的创建默认值解析与 binding 准备 | 8 |
| `packages/daemon/src/gateway/{gateway,protocol}.ts` | 会话绑定、声明路由、快照/队列方法及协议类型 | 8/9 |
| `packages/daemon/src/host/daemon-host.ts`、`src/index.ts` | 公开启动选项与 Extensions 装配 | 10 |
| `packages/daemon/test/extensions-fixtures.ts` | 有界临时包/配置 fixture，不执行产品逻辑 | 2 起 |
| `packages/daemon/test/extensions-*.test.ts` | 服务层独立行为测试 | 1–7 |
| `packages/core/test/context-selection*.test.ts` | Core 纯语义与装配竞争测试 | 4/5 |
| `packages/daemon/test/gateway-extensions*.test.ts` | 路由、会话恢复和安全协议投影 | 8/9 |
| `packages/daemon/test/extensions-socket.test.ts` | 真实 socket 的纵向验收 | 11 |
| `docs/extensions.md`、HLD、DDS、`docs/daemon-linux.md` | 用户契约与实现状态同步 | 11 |

依赖：`1 → 2 → 3`；`4 → 5`；`(2,3,4,5) → 6 → 7 → 8 → 9 → 10 → 11`。实际按任务编号顺序实施，无共享 checkout 并行写代码。

## 共同提交门禁 G（每个任务 Step 5 引用）

从仓库根执行；不能把 Biome 的带写入 lint 脚本当作只读验证。

```bash
node packages/daemon/native/build.mjs
pnpm exec tsc -b tsconfig.build.json
pnpm exec vitest run
pnpm exec tsc -p tsconfig.json
pnpm exec tsc -b tsconfig.build.json
pnpm exec biome check .
```

随后分别执行并核对退出码：

```bash
rg -n 'from "(node:)?(fs|http|https|net|tls|dgram|dns)|from "@pisces/(daemon|protocol)"' packages/core/src
rg -n 'from "@pisces/(daemon|core)"' packages/protocol/src
git diff --check
git status --short
```

两个 rg 都必须 exit 1（无匹配）；exit 2 是错误。不要用 `|| true` 吞掉扫描错误。审查新增 Core import 时补查动态 import/require，简单扫描不能代替审查。

提交只在 dev-pi，用任务列出的明确路径。若测试修复需要额外文件，先记录原因、检查 diff，再显式添加该路径。提交格式 `feat(core|daemon): ...` 或 `fix(...)`；文档用 `docs: ...`。依赖变更需一起显式暂存 `pnpm-lock.yaml`。本机与远端验证分开报告。

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

### Task 3: 惰性 TS/TSX loader 与宿主身份硬门槛

**Files:** Create `packages/daemon/src/extensions/loader.ts`; Modify daemon `package.json`、`pnpm-lock.yaml`; Test `packages/daemon/test/extensions-loader.test.ts`（使用 Task 2 fixtures）。

**Interfaces:**
- Consumes `DiscoveredEntry`、`sha256`。
- Produces `ExtensionModule { default: unknown; config?: unknown }`、`ExtensionLoader { load(entry: DiscoveredEntry): Promise<ExtensionModule> }`。
- `createExtensionLoader(): ExtensionLoader`：每个实例私有加载状态，按 entryPath+entryDigest 缓存 promise，包括失败。

- [ ] **Step 1: 写失败测试。** 临时 TS 工具、TSX+本地 JSX runtime、具有 extends/baseUrl/paths 的 tsconfig、本地 node_modules 依赖、node_modules 内 TS 包；模块静态和动态导入 `@pisces/core` 并抛 ToolDeniedError，要求宿主 `instanceof` 成立。同路径不同会话/不同冻结版本不得复用陈旧模块，单实例并发 load sentinel 只增加一次。
  ```ts
  const [a, b] = await Promise.all([loader.load(entry), loader.load(entry)]);
  expect(a).toBe(b);
  expect(await readCounter(counter)).toBe(1);
  expect(loadedError).toBeInstanceOf(ToolDeniedError);
  ```
  冻结后修改入口再首次 load 必须拒绝且 sentinel 不存在；语法错误/坏默认导出只影响本 entry；构造 loader 本身不导入任何扩展。
- [ ] **Step 2: RED。** `pnpm exec vitest run packages/daemon/test/extensions-loader.test.ts`。
- [ ] **Step 3: 实现 loader 并核实能力。** 执行时核实 jiti 2 文档/元数据后 `pnpm --filter @pisces/daemon add --save-exact jiti@2`；若解析 tsconfig extends/paths 需要独立解析器，使用 `get-tsconfig@4` 并同样 save-exact 锁定。jiti 配置必须禁止绕过入口校验的 native 直载/跨 binding 模块缓存；宿主 alias 指向同一已加载宿主文件，不能映射到扩展自己的副本。原生/转译层的缓存都要由身份测试实际证明，不能仅检查配置对象。load 对三类代码入口的 default 导出验证为函数；wrapper 工厂产物与 config 一致性由 Task 6 验证。
- [ ] **Step 4: GREEN/能力门槛。** 重跑 loader 测试，并用已编译 dist 入口在有界子进程中再验证宿主身份及无 Vitest resolver 帮助的路径解析。若 jiti 无法满足静态/动态导入、TSX 或跨 binding 隔离，停止 Task 3、记录最小复现，向用户请求等价 loader 方案；不得删测、放宽身份或虚报依赖能力。
- [ ] **Step 5: 门禁 G，然后提交。**
  ```bash
  git add packages/daemon/src/extensions/loader.ts packages/daemon/package.json pnpm-lock.yaml packages/daemon/test/extensions-loader.test.ts
  git commit -m "feat(daemon): load extension modules lazily with host identity"
  ```

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

## 自审与实施交接

### 设计覆盖检查

| 设计段落 | 负责交付 |
|---|---|
| §1–3 范围、复用与不交付 | 全局约束、各任务文件边界 |
| §4 宿主、工作区、缓存与重启 | Tasks 6/8/10/11 |
| §5 manifest/sidecar/技能/glob/重复 | Task 2 |
| §6 配置/哈希及 wrapper 冲突裁定 | Tasks 1/2/6 |
| §7 loader/宿主身份/模块 ABI | Tasks 3/6/10 |
| §8.1 声明、删除、分支反转 | Tasks 4/5/7/9 |
| §8.2 快照与已固化视图 | Tasks 4/9 |
| §8.3–8.4 stale/历史类型/来源缺失 | Tasks 4/5/7/9/11 |
| §9 并发、预算、队列路由 | Tasks 5/8/9/11 |
| §10–11 兼容/验收/安全错误 | Tasks 8–11 与门禁 G |

- Step scan：任务均有测试断言、RED 命令、实现签名、GREEN 和提交门禁；文档不采用 grep 文本作为行为测试。
- Type consistency：Task 2 定义 Inventory/DiscoveryResult，Task 3 定义 loader，Task 4 定义 Core 视图/资格，Task 6 定义 binding/service，Task 7 富化只消费这些已定义接口，Task 8/10 区分 Gateway 服务与公开目录 options。
- 五个 Review Focus 均在对应任务的测试中落地；最重要的分支反转与 known-kind 检查分别在入队、确认前和 C 段覆盖。
- 自审修正：纯富化不预测含服务端 id 的字节数，大小原子性放在 Task 8；steer 使用 turn 起始偏移与真实提交分支，不只依赖 append promise；Task 9 列明全部队列参数类型。测试片段中的临时目录、counter、exists/invokeText 等均是各测试文件的本地 fixture helper，不是遗漏的生产接口。
- loader 外部能力尚未实际验证，Task 3 是停止式能力门槛；不在计划阶段假称依赖支持所有特性。
- 没有实现任务在本轮开始；没有远端 CI 证据。

计划待用户审阅。沿用已批准设计要求的 TDD 与独立任务审查，推荐 subagent-driven 顺序实施：每任务新实现者和新审阅者，完成后再进入下一任务，最后整阶段独立审查。不得把历史阶段的“一次集中修复波”限制自动解释成本阶段已获同样授权；最终审查处置按届时约定执行。

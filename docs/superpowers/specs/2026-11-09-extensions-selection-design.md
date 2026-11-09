# 扩展系统与透明选择闭环：阶段设计

**状态：设计与 Plan A/B 均已获用户授权并完成：A 代码验收 `e57f793`，B 代码验收 `ce1281d`；两个阶段的独立任务审查与阶段整体审查均通过，完成交接见 [当前交接](../handoffs/2026-11-09-extensions-selection-a-to-b.md)。远端 CI 未运行，未交付 providers/clients 扩展装配、CLI 与沙箱等能力；不得据本文声称这些已可用。原有设计约束未放宽。**

## 1. 目标、权威与范围

在已经完成的 Linux daemon 上，交付“发现扩展 → 展示可用条目 → 声明入队 → 用户审查/修改/删除 → turn.start 确认 → 固化声明及内容 → 按需执行”的协议级闭环。不新增具体 UI。

依据：HLD §2.1–2.2、§5.2、§5.4、§6.6；DDS §2.3/2.5、§3.4–3.6、§4.2–4.3、§5.5、§6.7。阶段起点为 dev-pi 的 `38a089befbc51461422f6d126eb839c88ff5b491`。

文档中的“本阶段未实现”描述是前一阶段的状态，不是永久禁令；本阶段接通后需更新状态说明。下文对缺省格式和冲突的裁定是**本阶段已批准的设计决定，不是此前实现已具备的能力**。

### 交付

- 服务层 Extensions：本地发现、配置读取、冻结 inventory、稳定哈希、选择定义生成、工具/包装器/技能/上下文来源适配。
- TS/TSX 按需装载：扩展自身依赖解析、宿主包单实例映射、失败隔离。
- Gateway：`entries.snapshot`、非空初始扩展选择、声明入队、`queue.edit/remove/clear`。
- 最小 Core 接口补充：将已持久化选择与实际执行资格分开；不让 Core 读取文件或依赖 daemon/protocol。
- 真实 Unix socket 验收与设计文档状态同步。

### 不交付

- CLI、配置写命令、CredentialStore、OAuth、模板、工作区初始化、ClientRegistry/客户端启动、跨平台传输。
- 真实供应商网络验收、包安装/更新管理、沙箱、远程扩展目录、热重载、依赖锁定系统。
- `session.list`：不作为扩展闭环依赖，留为独立小任务，不捎带实施。
- 完整 provider/client 扩展装配：本阶段识别这些清单字段，但不装载或对外假装可用；provider 继续通过既有显式注入。公开说明这是**可选择条目子集**的 Extensions，而非全类型装配完成。

## 2. 方案比较与采用方向

1. **先 CLI**：较快提供命令行入口，但仍只能使用手动注入的注册表，无法实现声明审查及扩展来源；后续需再次调整宿主装配。
2. **先清点与队列、完全不接执行**：变更较小，但用户可以选择无法执行的条目，闭环不成立。
3. **扩展选择纵向闭环（采用）**：复用已有 Core 与 daemon，把声明元数据、选择、固化和运行接通；工作较大，但直接体现 HLD 的核心创新点。

用户已选择扩展优先，并批准本文的具体接口方向、配置格式与冲突处理；实施任务以本设计为依据。

## 3. 现状与复用边界

- `packages/core/src/context/{queue,declarations,materialize,context}.ts` 已实现内部可信 declaration、分支异或选择、确认前缀、来源/技能固化、取消与锁外解析/锁内重校验。
- `packages/core/src/tools/tools.ts` 已有声明注册、inventory 分类 facade、惰性包装器工厂、调用结果映射。其 facade **共享父注册表**，不能把一个全局 Tools 的 facade 当成跨工作区隔离。
- `ContextEntries.kind()` 只有分类；目前缺少定义/配置哈希匹配与 stale 排除。driver 当前将 assemble 的完整 selection 传给 Tools.invoke。
- Gateway 目前拒绝所有非空初始 extensions 和客户端 control，工具/entries/skills/sources 是全局注入。
- 不重写持久化、事件时钟、turn 状态机、锁、认证、marker 恢复或停机排序。

## 4. Extensions 服务与生命周期

### 4.1 宿主接入

新增 daemon 的 `extensions/` 模块，由宿主构造一个 Extensions 服务。建议公开启动选项增加 `extensions: { configDir: string; builtinDir?: string }`；目录由嵌入程序显式指定，不新引入平台路径推断。未提供时保留既有无扩展模式及其拒绝行为。

配置驱动模式与现有 `defaults/createTools/entries/skills/sources` 手动注入模式互斥：混用时启动失败，不做含糊的优先级合并。`providers/providerHost` 仍由调用者提供；配置只负责从已注册模型中选择默认组合。

内部服务形态（命名可在计划中细化）：

- `readGlobalConfig()`：只读取全局默认工作区及配置。
- `prepare(workspace)`：解析配置、发现并冻结该次新会话的 inventory，返回独立的会话 binding。
- binding 包含 inventory、kind 查询、技能快照、惰性来源、独立 Tools、声明构造与定义匹配函数；不暴露可修改的注册表给协议。

启动时可清点内置/全局来源；工作区确定后清点工作区来源。绑定创建不得执行扩展代码。坏扩展收集为安全的结构化 issue，不阻断其他健康扩展或 daemon；无效用户配置则让相应创建操作失败，不能默默使用旧值。

### 4.2 缓存与冻结

以 `realpath(workspace)` 标识工作区；每次新建会话重新扫描，缓存不可变内容对象可以复用，但不得因缓存路径而省略重扫。并发扫描结果不得覆盖已绑定的会话。

每个会话 binding 独立持有 Tools 注册表、配置快照及装载 promise；不同工作区同名条目不共享实现。现有会话不被新扫描替换。不建立后台 watcher。

重启后第一次加载已落盘会话时，按其 meta.workspace 重新清点，与记录中的旧定义比较，不改写历史。workspace 不可访问时返回相应失败，不退回 daemon cwd。

## 5. 发现、元数据与文件约定

- 来源：`builtinDir`、`<configDir>/extensions/`、`<workspace>/.pisces/extensions/`。内置目录缺省指随产品发布的资源目录，不以进程 cwd 推断。
- 根目录中的普通包目录与指向本地安装包的目录链接均可发现；包根 realpath 去重。同一 `package#name` 来自不同实体时全部标不可用，不实行“工作区覆盖同名包”规则。
- 解析 `package.json` 的 `name` 与 `pisces`；允许 scoped npm 包名。条目选择键按 DDS 为包名加 sidecar name，而非运行时 id。
- 声明路径支持 glob 和 `!` 排除；确定性排序、排除元数据文件、同一路径去重。实现者可选择成熟 glob 库，不自制通用 glob 引擎。
- **约定**：无 `pisces` 字段时，从包根 `tools/`、`wrappers/`、`skills/`、`context/` 发现同类资源；不递归扫描任意目录，不把依赖目录当成条目目录。显式清单优先于约定目录。
- **sidecar 命名**：入口 `foo.ts` 对应 `foo.ts.meta.json`；技能目录 `foo/` 对应其相邻 `foo.meta.json`。不同时猜测两种脚本 sidecar 命名。
- 元数据提供 name/description/parameters/config；无 sidecar 时名称取基名，tool/wrapper 的 description 默认为空串，parameters 默认为 `{}`，可在确认前完整看到这一缺省声明。
- **技能格式**：技能目录以 `SKILL.md` 为正文；读取 UTF-8 文本，不自动把目录中每个文件都插入系统提示词。其他资源供技能正文引用，不隐式进入请求。
- 显式入口必须落在所属包根内，包外依赖通过 Node 模块解析处理；支持包根本身为 npm/pnpm 符号链接。此规则限制清单歧义，不宣称扩展代码被沙箱隔离。
- 扩展缺失/重复/坏 JSON/非法元数据标记相应扩展或条目不可用并保留 issue；不将原始文件内容或异常消息推送客户端。

## 6. 配置与哈希

### 6.1 配置格式

全局 `<configDir>/config.json` 与工作区 `.pisces/config.json` 使用：

```json
{
  "defaultWorkspace": "/absolute/path",
  "defaultProvider": "provider-id",
  "defaultModel": "model-id",
  "extensions": ["example#tool"],
  "entryConfig": { "example#wrapper": { "option": true } }
}
```

`defaultWorkspace` 仅全局允许；未知键、类型错误沿用 `config.unknown_key/config.invalid`，错误文案不包含配置值。凭据不允许放入这个配置模型。providers 的详细配置及管理留待其独立阶段。

优先级为内置默认 < 全局 < 工作区；对象配置按键递归合并，数组与标量由高优先级整体替换。`defaultProvider/defaultModel` 作为一对解析，各层若提供必须成对，避免拼接两个层级的 provider/model。显式 session.create 的 provider/model 同样必须成对；显式 extensions 替换默认列表，空数组禁用全部默认选择。

解析顺序：全局默认工作区 → 校验/realpath 工作区 → 读取工作区配置 → 清点 → 解析默认 provider/model 与选择 → 校验 → 创建临时会话。既有会话 meta 的 provider/model/workspace 不随配置变化。

### 6.2 包装器配置冲突裁定

HLD §6.6 说选中时导入包装器、读取模块 config；DDS §4.3.2/5.5.4 和现有 Core 在 invoke 时才加载。若依赖执行模块才能得到默认配置，则无法同时做到“清点不执行代码”和“确认前已有完整 configHash”。

**统一为 DDS 的首次 invoke 加载**：将确认所需的默认值与 schema 放在 sidecar.config（形态 `{ defaults, schema }`），清点阶段读取，合并用户覆盖并校验，然后冻结 configHash。模块 `config` 导出可保留为兼容性校验，不作为隐藏默认值来源；若与 sidecar 不一致，调用失败而非静默改变已确认配置。不得在第一次 invoke 时读取新的用户覆盖并改变哈希。

schema 使用明确版本的 JSON Schema 校验器（建议 draft-07），不执行自定义校验代码。完整配置留在本地，声明只保存哈希。**本阶段仅 wrapper 支持 sidecar.config/entryConfig**，通过包装器工厂参数得到冻结配置；tool/context/skill 的这些配置按 config.invalid 拒绝，而非读取后忽略。它们保持 §7 的既有调用签名，不偷偷扩充 ToolInvocationContext 或 resolve 参数。其他类型的配置注入留待单独设计。

这一已批准裁定需随实施同步 HLD/DDS 冲突句及元数据格式。

### 6.3 哈希语义

daemon 使用 SHA-256；JSON 递归排序对象键，保持数组顺序；相同输入不依赖扫描顺序、时间或绝对安装路径。哈希函数及规范化格式必须有确定性测试。

- tool/wrapper `definitionHash`：名称、kind、确认可见的 description/parameters，以及入口源码字节指纹；configHash 单独计算。
- `configHash`：确认时冻结的合并配置；不输出配置正文。
- inventory.hash：按名称排序的条目种类、定义/资源指纹与配置哈希。不将 provider 凭据或客户端进程配置放入协议清点。
- 本阶段不递归锁定或哈希整个 node_modules/传递依赖树，不承诺旧依赖可重放，也不承诺对恶意同 UID 文件修改防护。
- 首次装载前检查入口字节仍匹配冻结指纹；不匹配时不得执行新的入口。已装载实现继续使用缓存，不热替换。新会话/重启重扫才能采用新内容。

## 7. 惰性装载与贡献契约

装载器使用 jiti 或经验证的等价方案；确切依赖版本由实施计划查证，不在设计中臆造。必须实测 `.ts/.tsx`、tsconfig paths/JSX、扩展自身 node_modules 和从 node_modules 中加载 TS。

宿主已存在的 `@pisces/core`、`@pisces/protocol`、`@pisces/daemon` 必须映射到宿主模块实例，包含 loader 支持的动态导入路径；无法确保时显式失败，不退回第二份宿主包。测试至少验证 ToolDeniedError 等运行时身份。

**模块 ABI**：

- tool 默认导出 ToolFunction；注册声明由 sidecar 产生，execute 使用异步代理首次加载模块并调用函数，模块不得替换已确认元数据。
- wrapper 默认导出 `(config) => ToolWrapper`，允许 Promise 结果；工厂 promise 在首次 invoke 缓存，同 binding 并发只导入/建厂一次，失败也缓存。
- context 默认导出与 ContextSource.resolve 同签名的函数；代理只在已选来源需要固化时异步导入并调用。
- skill 无代码；为满足现有同步 Skills.selected，清点读取并冻结正文，只有装配时才把已选正文固化为节点。

模块命名、类型别名可由实施计划调整，但不再支持多套启发式导出格式。装载异常分别走既有 tool.failed/tool.wrapper_invalid/context.source_failed 语义，不传播原始 adapter/扩展异常到协议错误事件。

## 8. 声明、快照与 stale

### 8.1 协议到内部可信声明

客户端 declaration 只允许单 text 块 JSON `{ "toggle": ["package#name"] }`。拒绝任何内联 definitions、未知载荷字段、重复/非法名称及非 declaration 的 control。source 不能成为客户端指定 definition 或实现的通道。

daemon 在会话锁内按队列顺序计算“持久化选择 XOR 全部待处理声明”的有效选择，用于验证未知名称与显示选择变化；**定义富化不依赖开/关方向**：每个 toggle 中可用的 tool/wrapper 都附加当前 binding 的完整 DefinitionSnapshot，包括当前看似关闭的 toggle。DDS 要求开启携带定义，但未禁止关闭时携带；这样不会因删除前序声明或改用历史分支而让幸存 toggle 缺定义。

若条目已缺失/不可用，可为关闭已有名称附加分支重放所得的旧完整快照；不生成虚假新哈希。类型已变化时同样沿用旧快照来关闭，不把新类型当成旧实现。技能与来源不伪造 tool/wrapper 定义；未知且未选名称不能开启。

任一 declaration 一旦入队，正文不因其他条目被删除、取消确认或 turn.start(nodeId) 改变而更新。每次工具/包装器重新开启都使用该条目自身携带的快照，不依赖已删除的其他队列声明。没有分支绑定或新的协议分支参数：toggle 仍是相对于最终执行分支的异或，不升级成绝对 enable/disable 操作。

缺失且只有关闭用途的名称，切到不同分支后若成为开启，不补新定义、不装载新代码：有旧工具定义时标 stale；是无法固化的内容来源时按 §8.4 返回 context.source_failed。允许用户删除该声明，绝不把这种合法队列/分支组合误报成存储损坏。

对整批请求先完成解析、选择重放、定义构造与大小校验，再只调用一次 Context.enqueue；任何失败不改变队列。已有未确认/已确认条目不在这里被悄悄改写。用户要更新定义必须删除旧声明，再显式重新选择；已确认内容永不改写。

初始 extensions 生成一条同样的 declaration，与 prompts 一次入队；失败不得留下 runtime 或空会话目录。templateId 仍拒绝。

### 8.2 entries.snapshot

返回 `{ entries, selection, effective }`；selection 为默认分支已持久化选择，**不包含队列 toggle**，临时会话为空。entries 取冻结的会话 binding，可见声明不包含 execute、绝对入口路径或配置正文；effective 来自分支重放的定义，不混入待确认声明。

建议增加 Core 的纯分支定义重放查询（如 Context.effectiveFor），复用现有 replayDeclarations；不要由 daemon 再实现另一份选择算法。所有会话视图读取遵循现有会话锁与 seq 一致性。无需新增独立订阅事件。

### 8.3 执行资格不是选择状态

tool/wrapper 的当前 definitionHash/configHash 与最近一次持久化（或本次幸存声明）的快照不匹配时 stale。缺失实现同样不可执行。stale 不自动关闭选择、不改历史，不出现在请求 tools 中，也不参与包装；通过关闭后重新开启并确认更新定义。

**最小 Core 补充方向**：ContextEntries 增加纯同步的资格判断，输入为名称和重放的 definition；assemble 在最终锁内重校验后产生 executionSelection，driver 只将该集合传给 Tools.invoke。公共 selection/snapshot/selection.updated 仍保持真实异或选择。请求工具仍从已确认快照投影，禁止改读实时 Tools 声明。缺失/结构错误的必要历史定义仍按 storage.corrupt，而非一律隐藏为 stale。

可选新接口字段对手动注入模式保持原行为；不得引入 Core 的文件访问或异步装载。最关键的测试是 stale wrapper 绝不执行，即使供应商返回对应工具调用。

执行资格及历史 kind 判定使用同一份纯重放结果，不在 Gateway/Context/Tools 中分别猜测；具体分类见 §8.4。

**持久化格式限制需明确**：当前 DefinitionSnapshot 只覆盖 tool/wrapper。skill/context 没有持久化定义/配置哈希，不能声称已经支持其跨重启哈希陈旧判定。本阶段遵守其 source-based 分支内容复用语义；effective 对它们可报告名称/当前可用性，不捏造旧哈希。选择内容已固化时仍复用历史内容；旧来源零片段且需重试时使用本会话冻结的实现。若要对四类条目统一做跨重启哈希判定，应另行批准公共/持久化格式扩展，不混入本阶段。

### 8.4 缺失条目与类型变化的确定规则

本阶段不新增持久化 kind 字段，也不声称可以从现有格式恢复所有历史类型。按以下证据优先级处理：

1. 有最近的合法 DefinitionSnapshot：历史类型由 definition.kind 确定。当前缺失、kind 不同或哈希不符均 stale，不按新类型执行，也不因此报告 storage.corrupt。
2. 无 DefinitionSnapshot，但分支中存在 `kind=agent, role=system, source=该名称` 的历史节点：认定为内容来源类别，继续复用选中来源的历史正文，即使扩展已移除也不执行代码。当前名称若被改作 tool/wrapper，不用新工具代替旧内容。
3. 无历史定义、无历史内容，当前是 skill/context：按当前冻结来源固化；这包括零片段来源在重启后的重试。skill 与 context 之间的历史类型变化无法可靠检测，明确不提供这项保证。
4. 无历史定义/内容、当前也缺失：无法判定历史类别；选中时 effective 标不可用，assemble 在任何持久化或供应商请求前返回固定安全的 context.source_failed。不得默认它是工具并报 storage.corrupt，也不得静默忽略它。
5. 当前明确是 tool/wrapper、但必要定义缺失：若没有第 2 项的历史内容证据，仍按 DDS 的缺失必要定义规则报告 storage.corrupt。畸形已持久化载荷/定义始终 storage.corrupt，不能被 stale 掩盖。

队列富化必须保留原历史类别：同一会话已知的 tool/wrapper kind 变化，或内容来源与 tool/wrapper 之间转换，不作为“重新选择更新定义”接受。关闭允许；尝试按新类型重新开启时以 queue.invalid_control 拒绝，需扩展发布新名称或创建新会话。客户端可见 entry 当前类型与 effective 旧类型/不可用状态不得被混为同一可执行条目；EffectiveEntry 公共字段不扩充历史 kind，相关判断内部保存。

这项限制避免同名工具重新开启时让旧技能正文随名称选择再次注入，或把旧工具无定义地当作来源执行。相同 kind 的定义/配置更新仍可以关闭→开启并确认。没有历史证据的 skill/context 变化仍受上一段的格式限制，不能声称全部检测。

跨分支重放也执行此校验，不能只在入队时检查默认分支：若 pending declaration 的定义在目标分支发生上述已知跨类型换义，turn.start 在 confirm/marker/registerTurn 之前以 queue.invalid_control 拒绝，保持队列原样。assemble 的最终幸存窗口在 C 段再次校验，禁止删除/取消确认竞争绕过类型规则；拒绝时不追加节点、不出队。不要先用最新 definitions 覆盖历史证据再检查类型。对于正常同类工具的分支反转不新增限制。

## 9. 队列路由、事件与并发

- queue.edit：仅未确认 agent 可编辑；已确认返回 queue.entry_locked，未确认 control 沿用 Core 的 queue.invalid_control；未知 id 返回 queue.entry_not_found。
- queue.remove：允许删除任何仍在队列的条目，含已确认 declaration；不删除记录或建立墓碑。
- queue.clear：存在登记 turn（含 cleanup/cleanup_failed）时整请求拒绝，无活跃 turn 才清空。
- 每个路由在会话锁内 initialize/操作；成功变化沿用完整 queue.updated，保持单调 seq。Core 已有行为不能被 Gateway 的重复通知再触发一次。
- 不在持有会话锁时执行插件、转译 TS、解析来源、运行工具。prepare 的文件 I/O 在创建 runtime 前完成，加载持久会话的绑定创建可以串行协调，但不能引入 runExclusive 嵌套。
- 声明入队/删除与 assemble 锁外解析竞争时继续依赖现有确认代际和 C 段幸存重投影，不扩大确认窗口。
- 沿用协议/事件字节预算；大 inventory 的 snapshot 在发送前显式报安全错误，不能先提交状态再因超帧断连。分页 inventory 暂不新增协议。

## 10. 兼容与失败边界

- 无扩展模式保留现有嵌入式入口；原生认证、Linux-only、连接级订阅、安全错误投影和不完整停机保锁语义不变。
- 工具/包装器失败不能阻断 daemon 或其他会话；不把异常 cause、源码、配置正文拼入 wire message。
- 不自动重放工具、不自动启用新增扩展、不把来源或技能静默塞入请求。
- SessionMeta/schemaVersion 不增加扩展选择、运行状态或 inventory 字段。已固化定义只留在 declaration 节点中。
- 旧会话定义哈希原本只是字符串，不能假设都由本阶段规范产生；无法匹配就显示 stale，不能偷偷覆盖。
- 设计批准后同步 HLD/DDS 的 wrapper 加载时机、配置格式、技能资源约定、snapshot 返回形态与当前路由状态。不要把 deferred provider/client 装配描述为已完成。

## 11. 验证与实施分解边界

后续计划按可验收任务拆分：配置/规范化哈希 → 声明式发现和冻结 → 装载器身份/惰性测试 → Core executionSelection → 会话 binding 与安全声明富化 → snapshot 与队列路由 → 真实 socket 验收/文档。

至少包含：

1. 恶意 top-level 副作用探针证明清点、创建、快照和确认都不导入工具/包装器代码；只在首次实际调用导入。
2. 显式空选择覆盖默认；全局/工作区配置优先级、非法值原子失败；跨工作区同名条目执行不同实现。
3. 内联 definitions/未知 control/重复名整批拒绝；默认/显式选择生成可见、未确认且正文完整的队列条目。
4. 未确认条目不固化不执行；移除已确认声明、装配期间取消确认、steer 竞争不扩大装配窗口。单测覆盖 A 开启/B 关闭后删除 A、以及在默认已选/旧分支未选之间切换：B 使用原已审查定义，不补写或误报损坏；缺失来源的分支反转安全失败且可删除声明恢复。
5. request.tools 与持久声明逐字段一致，stale tool 不进请求、stale wrapper 不执行；重启/代码或配置变更显示 stale，重新选择才能恢复。
6. skill/context 首次固化、取消选择过滤、重新选择复用、零片段重试、取消不提交。
7. 加载 TS/TSX、本地依赖与宿主身份一致；并发首次调用只加载一次；坏扩展隔离且安全错误不泄漏。
8. 真实 Unix socket 上 snapshot → 入队 → 编辑/移除 → 确认 → 多 step 工具/包装器/来源执行 → 事件与持久记录核对；保留跨 UID 及停机回归。

实施使用 TDD 和独立任务审查；每次提交前原生构建、完整 Vitest、两项 tsc、Biome、Core/protocol 边界扫描；显式暂存本次文件。远端 CI 需真实执行后才能声明通过。

## 12. 批准门槛

用户已批准下列设计范围与取舍；本次批准要求进入计划阶段，不等同于已批准实施计划：

- 阶段仅完成可选择条目，不同时接通 provider/client 扩展启动。
- wrapper 统一为 invoke 时加载，确认所需配置默认/schema 改为声明式 sidecar。
- 沿用既有持久化格式：tool/wrapper 完成哈希 stale，skill/context 明确维持来源内容复用的边界。
- 接受本文标明的配置/sidecar/技能正文/模块 ABI 约定；本阶段条目配置仅支持 wrapper。
- 所有 tool/wrapper toggle 均携带可用的定义快照，避免删除/分支反转缺定义；保留相对异或语义。
- 历史类型按 §8.4 的可用证据判定；同会话不允许已知条目跨类型换义，无法判定的缺失内容来源安全失败，不擅自升级持久化格式。

独立 builder check 已完成一次，提出四个问题（声明删除、跨分支确认、配置注入 ABI、历史类型判定）；本修订分别以 §8.1、§6.2/§7、§8.4 明确处理。规则经作者对照现有 replayDeclarations、queue.remove、projectTools 核对；未声称审阅者已复审或批准本次修订。

已进入 writing-plans；实施计划需另行交付用户审阅。为控制智能体上下文，实施拆为 [Plan A：Tasks 1–6](../plans/2026-11-09-extensions-selection-a-foundations.md) 与 [Plan B：Tasks 7–11](../plans/2026-11-09-extensions-selection-b-integration.md)，统一入口及门禁见 [计划索引](../plans/2026-11-09-extensions-selection.md)。A 以可独立测试的 binding/Core 接口交付，B 在受版本控制的交接记录 READY 后接入协议，不改变本文设计范围。不建立 worktree，不向 main 提交，不 push/merge，保留此前阶段资料。

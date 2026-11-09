# 扩展 Loader 修订：jiti 实例级局部补丁

**状态：用户已批准设计，并要求修订实施计划。用户已确认 [Task3 修订计划](../plans/2026-11-09-extension-loader-jiti-patch.md) 并授权开始正式实现；验收尚未通过。**

本修订仅补充 [原设计 §7](2026-11-09-extensions-selection-design.md#7-惰性装载与贡献契约)，解除 Plan A Task 3 的 CJS 宿主身份阻塞，不改变模块 ABI、指纹配方、Core/Gateway 边界或 Plan B 授权。依据：[本地选型验证报告](../research/2026-11-09-extension-loader-selection.md)。

## 1. 目标与不交付

目标：普通扩展 JS/TS/CJS 依赖图的 import/require 始终经过实例级解析；三个宿主包保持真实运行时身份；JavaScript/JSON 不通过原生缓存跨求值图共享；无法支持的加载明确失败而非回退第二份宿主。

不交付：沙箱、全局 Node hook、依赖树扫描/冻结、热重载、完整 Node/ESM 等价性、新 loader ABI、额外上下文参数或本阶段以外的 provider/client 装配。Linux 认证、锁、marker、停机策略不动。

显式 `createRequire`、`process.getBuiltinModule` 等绕过 loader 的原生能力不在身份隔离承诺内；任意扩展仍与宿主同进程、同权限。这是非沙箱边界，不得描述成恶意扩展隔离。

## 2. 方案取舍

| 方案 | 结论 |
|---|---|
| 未修补 jiti 2.7.0 | `.cjs` 传递依赖绕过 virtualModules，原产品两个身份断言失败；不可用 |
| esbuild 0.25.10 打包求值 | 可解决身份问题，但模块目录/URL 改义，TLA 与计算型本地 import 不支持；本次不选 |
| 固定 jiti 2.7.0 + 局部补丁 | **用户选择的方向**；保留更多现有运行语义，接受可审计第三方补丁的维护成本 |

选型原型在本机 Node 22.19.0/24.11.0/26.13.0 各通过 17 个共用测试与 6 个额外独立断言，但不是产品验收。下文增加的补丁标记、关闭模式兼容性、JSON 值覆盖与原生回退拒绝必须正式实现/测试，不能照搬原型并引用旧绿结果。

## 3. 依赖与补丁交付

- daemon 继续精确依赖 `jiti: 2.7.0`，不增加 esbuild，不复制整个发行包到产品源码。
- 使用 pnpm 12.8.1 原生 patch 机制：补丁文件 `patches/jiti@2.7.0.patch`；workspace 的 `patchedDependencies` 精确登记 `jiti@2.7.0`，lockfile 保存对应补丁元数据/hash。仅修改必要的发行运行时和类型声明，MIT LICENSE 保持不变。
- 在补丁说明中记录上游版本、原始/修补后文件 hash、语义变化与可读的旧/新锚点。压缩 bundle 的大段单行 diff 不是充分审查材料；不得夹带无关格式化或其他依赖升级。
- 安装不依赖手动修改 node_modules、未跟踪文件、postinstall 文本替换或临时原型。缺文件、hash 不符或补丁未应用必须使安装或独立门禁失败，不容忍警告后运行未修补版本。
- 当前 workspace/packages 均为 private；脱离仓库的 npm 发布不在本次保证内。未来发布必须单独保证补丁随依赖分发，不能只发布 daemon/dist 而假定消费者有本仓库的 pnpm 配置。

### 运行时缺补丁也要安全失败

启用扩展模式的 jiti 实例带只读、非枚举标记 `piscesExtensionModeVersion: 1`；默认/关闭模式不要求该标记。adapter 在求值入口之前检查精确值，缺失/不匹配直接报固定 `ExtensionLoadError`。因此误装上游原版时不能静默重新走原生 CJS 回退。标记不是对恶意依赖篡改的安全证明，安装完整性仍由锁文件、补丁与验收保证。

该标记和下文选项均在补丁类型中明确标为 Pisces 私有扩展，不冒充上游公开能力。对外 `ExtensionLoader` 接口不变。检查只发生在 `.load` 缓存未命中、创建私有 jiti 实例之后、执行入口之前；`createExtensionLoader()` 不因此读取扩展或抛缺补丁错误。缓存命中不创建/重验引擎实例。

正式补丁不限于原型的两个语义改动：本设计明确授权转译模式、JSON 缓存/互操作、格式回退拒绝及实例标记这四类必要改动与类型声明；新增 hunk 必须记入可读锚点、hash 和独立审查材料，不得沿用原型 patch hash 冒充最终产物。

## 4. 实例级扩展模式

补丁保留原型中的 `transformAll?: boolean` 作为私有模式开关；adapter 固定启用，不对用户配置开放。

- **只有 `transformAll === true` 才启用新模式。** 缺省和显式 false 均保持上游原有决策，不能把 false 当成“强制不转译”。同 workspace 的 Vite/Vitest 等其他 jiti 消费者不受默认行为变化影响。
- 开启后，允许的脚本文件后缀为 `.js/.mjs/.cjs/.jsx/.ts/.mts/.cts/.tsx`；入口只支持这组脚本，依赖另支持 `.json`。它们均经过实例解析链，`.cjs` 不再无条件原生求值，计算型 require/import 也使用同一规则。
- 后缀以解析后的实际文件判定；无后缀 specifier 可解析到这些文件或目录 index，但实际无后缀文件、`.wasm`、`.node` 及其他后缀不支持。package.json 为 type/exports 等解析而被读取不算执行模块；显式作为依赖导入则按 JSON 处理，仍受宿主子路径规则约束。
- `forceTranspile:true` 必须实际执行调用方已验证的入口字节；路径只用于模块身份、相对解析与模块元信息，不再原生重读入口代码。扩展模式内相反的 forceTranspile 设置不得恢复普通脚本的原生回退，可拒绝冲突设置。
- adapter 保留 `fsCache:false`、`moduleCache:false`、`tryNative:false`、空 nativeModules 等禁用旁路设置。补丁必须在 jiti 自身解析/求值的原生分支之前校验格式，而非 adapter 扫描依赖树；同步/异步、语法探测或 native 正则分支都不能绕开它。
- 运行时确认是 Node builtin 的裸名与 `node:` 名均允许，例如 `fs` 和 `node:fs`；另外允许 adapter 的三个真实宿主 namespace。**扩展入口和依赖中的 `.node` 与未知格式一律明确拒绝原生回退**，失败只隔离对应条目。宿主自身加载的 N-API/peer-credential 绑定不经过扩展解析器，不受影响。

最后一条是本设计的新增安全裁定：原型可加载 `.node`，但未证明其进程级状态/缓存隔离；正式版本不把这一未经证明的能力当作支持。若实现者无法在实例模式内拦截这些分支，停止并报告，不增设全局 hook 或包名白名单。

## 5. 求值图、JSON 与缓存

缓存有两个层次：

1. `ExtensionLoader` 按 entryPath + entryDigest 缓存 promise，包括失败；同实例并发同入口只求值一次。
2. 每次未命中的入口求值均创建新的私有 jiti 根实例及图缓存，不跨入口/摘要复用根实例；图内循环/重复依赖保持身份，子上下文共享本图缓存。新的图不共享扩展 JS/JSON 实现或可变值。它不是跨整个 binding 强制共享所有依赖的模块缓存。

JSON 在扩展模式下直接读取/解析，缓存挂在求值图私有容器上并传给子上下文，不读写 Node require.cache。新 loader/图必须读取更新字节且不观察上一图的 mutation；同图重复 require 保持对象身份。

正式实现覆盖对象、数组、字符串、数字、布尔、null，以及已有 `default` 键的数据。缓存只存 JSON.parse 的原值；CommonJS require 返回它，JSON 的 ESM default import 取得同一个值。**不允许在缓存原值上添加自引用 default 属性，即使不可枚举**；namespace 包装另行生成，不覆盖用户键，不对标量做对象属性操作。选型补丁的原地 decoration 不满足此要求，必须调整并测试，不能照抄。具体 jiti 内部接线留给实现者。

仅入口摘要冻结。相同 loader、相同入口摘要继续使用已装载实现，即使依赖磁盘更新；新图读取当前依赖不是依赖树可重放承诺。原型的 JSON 私有缓存机制是参考，不保证其现有互操作代码可原样投入产品。

## 6. 宿主映射、错误与兼容

- `@pisces/core`、`@pisces/protocol`、`@pisces/daemon` 精确映射到本进程实际已加载 namespace。静态、动态、参数计算型加载和嵌套 CJS 使用同一规则；扩展自己的副本和 tsconfig 同名 alias 不能取代宿主。
- 当前三个宿主包仅导出 `.`。它们的未支持子路径在解析前固定拒绝，即使扩展目录存在相应文件；不尝试扩展本地回退。
- virtualModules 使用 null-prototype 私有映射，必要时以 Proxy 拒绝子路径；继承键不能被视为虚拟模块。无需新增导出启发式。
- 保留原函数默认导出 ABI、模块 config 处理、skill 不导代码和构造 loader 不读取/执行扩展的行为。包内 tsconfig 查找、extends/baseUrl/paths 与 automatic JSX + pragma 的已测范围不变；不扩大为任意 JSX compiler options 支持。
- load 阶段错误均为 `ExtensionLoadError`，但允许以下固定消息区分类别：缺失/版本不匹配标记为 `Extension loader patch is unavailable`；格式回退拒绝为 `Unsupported extension module format`；JSON 解析失败为 `Extension module JSON is invalid`；其他解析/求值沿用 `Extension module failed to load`。既有 digest/skill/default 类别保持不变，不附原始路径、值、cause/data，不新增协议错误码。
- 补丁可用私有静态 reason code 将格式/JSON 失败传到 adapter，由 adapter 映射上述固定消息；不得透传任意原始异常文本。测试使用对应类别、相邻成功控制与不执行 sentinel 共同证明分支，不能仅断言“抛了任意错误”。执行阶段沿用 Tool/Wrapper/Context 现有边界；不得把合法 `ToolDeniedError` 身份抹成通用装载异常。
- 保持各模块自己的 `__filename`、`__dirname`、`import.meta.url`、TLA 与计算型本地 import 的已验证行为。完整 ESM live-binding 等仍不声称完全等价；不静默引入已知改义。

## 7. 正式验收门槛

| 范围 | 必须证明 |
|---|---|
| 原有能力 | 原 loader、CJS 与安全错误测试保留并通过；不 skip/todo/fails，不以导入失败冒充行为 RED |
| 实际身份 | 三个宿主运行时导出、ToolDeniedError 的 ===/instanceof；嵌套/计算型/static/dynamic；本地副本、同名 alias 与子路径不得取胜 |
| 字节与求值次数 | 直接传入字节与磁盘不同仍执行所传字节；摘要不匹配不执行；并发一次；不同 loader 不复用陈旧 JS/CJS/JSON |
| JSON | 同图身份、跨图隔离/更新、所有合法值类型、已有 default 键、坏 JSON 安全失败 |
| 兼容与边界 | 各模块元信息、TLA、计算型本地 import；默认/false 上游行为；builtin 可用；扩展 `.node`/未知格式拒绝且不执行其 sentinel |
| 缺补丁/安装 | 隔离临时 workspace 副本以冻结 lockfile 安装，实际采用补丁；原版/错误标记安全失败且无扩展副作用 |
| 真 dist | 编译后的 Pisces loader 在有界原生子进程运行，不依赖 Vitest alias 或临时原型；child 清理/环境隔离沿用既有模式 |

正式 loader 测试与原生子进程在本地 Node 22.19、24、26 分别运行并保存真实版本/退出码；不可用则报告缺证据，不当成通过。每次提交仍执行共同 G；没有运行远端 CI 就明确未运行。

实现必须把补丁/JSON/子路径等新增生产差异的行为 RED 记录清楚。选型探针是历史参考，不能替代正式测试或篡改成新实现的 TDD 证据。

## 8. 升级、停机点与后续授权

补丁固定版本，不自动随依赖升级。升级必须重新核对上游变化、更新可读说明与安装验证，重跑完整 loader 矩阵及共同 G；补丁无法应用、必须扩大为新模块系统或需要全局修改时停止，不回滚到无补丁 jiti 来隐藏错误。

这项修订的实现范围是 daemon loader、精确 jiti 补丁及其 workspace/lock/类型/测试/安装验证，不提前修改 Core、Gateway 或 binding。Task 3 最终独立审查从其原始 BASE `e4776e6f5d73055afc79ed07a14c9166b714f7d6` 生成完整 diff，保留此前 I1 已接受证据与其他延期 Minor；不得只审最后一个补丁提交。

用户批准本设计后，先修订 Task 3 的实施计划，再按已选 deepseek-flash SDD 执行。硬门槛、完整 G 和独立审查通过后才能继续 Tasks 4–6；A 完成整体审查和实际交接后停止，Plan B 仍需单独授权。

当前产品两个 CJS 身份断言仍 RED。本设计及修订计划已批准，仍保持未提交；待同一 Task 3 的正式修补使完整 G 转绿后，与实现按显式文件清单提交。批准记录先保存在会话/本地台账，Task 3 的原始审查 BASE 不变。没有文档专用排除测试或门禁豁免，也不删除失败测试。

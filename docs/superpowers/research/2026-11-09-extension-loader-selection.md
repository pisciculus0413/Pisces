# 扩展 Loader 选型与临时验证

日期：2026-11-09。状态：**选型验证完成；用户已批准 jiti 局部补丁设计并确认 Task3 修订计划，正式实现进行中，产品验收尚未通过。**

本报告不是实施计划或 Task 3 验收。所有原型、临时依赖和完整日志位于 git-ignored 的 `.superpowers/sdd/2026-11-09-extensions-selection-a-foundations/loader-selection/`，必须保留。产品 HEAD 仍为 `e7d937db06a8a9a4fa4b5e4401889957fc735672`，没有修改产品源码、依赖清单、lockfile 或原始测试。

## 1. 结论

**推荐继续设计“精确固定 jiti 2.7.0 + 受版本控制的实例级局部补丁”方案，不采用本轮 esbuild CJS 打包原型直接替换。**

两个原型都能解决当前 CJS 传递依赖的宿主身份问题。但 esbuild 方案还会悄然改变依赖的模块路径语义，并丢失已可支持的顶层 await / 计算型本地 import；它不是无需额外设计就能替换的等价实现。jiti 补丁原型在本轮检查中保留了这些能力，代价是维护第三方补丁。

用户已批准 [替换设计](../specs/2026-11-09-extension-loader-jiti-patch-design.md)，要求修订 [Task3 实施计划](../plans/2026-11-09-extension-loader-jiti-patch.md)。计划已确认，当前进入正式实现与后续独立验收；下文原型通过不等于产品通过。

## 2. 比较范围与方法

两个独立子智能体均为 `deepseek-flash`；controller 没有委托它们决定最终架构。每个候选使用独立目录，不修改共享安装或 Node 全局加载器/cache。

共用 17 个原有断言：原 loader 14 测试、未提交 CJS 身份回归 2 测试、装载前安全错误回归 1 测试。只在临时副本中重写模块/fixture 路径以及子进程候选入口，controller 验证三个副本没有其他内容变化。

Controller 另外编写 6 个独立、有实际正向断言的边界检查，并亲自运行两个最终候选：

1. 嵌套 CJS 通过参数计算的 require/import，比较三个实际宿主包的运行时导出身份。
2. JSON 同求值图保持对象身份，新 loader 则对象隔离、磁盘更新可见、无先前 mutation 泄漏。
3. 依赖自己的 `__dirname`、`__filename`、`import.meta.url`。
4. 入口顶层 await。
5. 参数计算的本地 import，按定义模块解析。
6. 不支持的宿主子路径必须拒绝，不能加载扩展本地副本。

运行时为本机 Linux 上的 **Node 22.19.0、24.11.0、26.13.0**。22/24 使用 Node 官网二进制，下载后与对应 SHASUMS256 核对；没有运行远端 CI，也没有在这些版本上宣称整个产品测试集通过。

## 3. Controller 实测矩阵

下表在三个 Node 版本上结果一致；jiti 行对应 JSON 修补与子路径 guard 完成后的最终原型，而不是早期结果。

| 检查 | esbuild 0.25.10 | jiti 2.7.0 局部补丁 |
|---|---|---|
| 共用 17 测试 | 17/17 | 17/17 |
| 嵌套 CJS / 计算型导入，三个宿主实际导出身份 | 通过 | 通过 |
| JSON 同图身份 / 跨实例隔离与更新 | 通过 | 通过 |
| 依赖模块文件/目录/URL 语义 | **失败**：目录变成入口目录；URL 为空 | 通过 |
| 顶层 await | **失败**：CJS bundle 不支持 | 通过 |
| 计算型本地 import | **失败**：运行时被拒绝 | 通过 |
| 未支持宿主子路径 | 拒绝，无副本回退 | 固定 ExtensionLoadError 拒绝，无副本回退 |
| 独立边界检查总计 | 3/6 | 6/6 |

因此 jiti 候选在本轮每个版本上通过 **17 + 6 项检查**；这不是对所有 Node/ESM/CJS 行为的穷尽证明，也不代表正式产品的 dist 已被替换。

原产品失败回归仍保留并重新运行：

```bash
pnpm exec vitest run packages/daemon/test/extensions-loader-cjs.test.ts
```

结果仍是 exit 1、**2 个实际身份断言失败**，日志 `loader-selection/product-baseline-red.log`。不删除、不跳过、不改成 expected-failure。不能把临时原型的绿结果记为产品门槛通过。

## 4. 候选机制与代价

### A. esbuild 打包 + 受控 CommonJS 求值

- esbuild **0.25.10** 仅安装于临时 prefix，未加入仓库依赖。
- 打包整个 JS/TS/CJS 依赖图；入口 onLoad 返回已验证字节，支持入口自引用。
- 三个保留宿主包外部化到真实已加载 namespace；计算型 import 降为 require；普通残余 require 若不是宿主或 builtin 则拒绝，不进行原生依赖回退。
- 必须显式传包内 tsconfig 或空配置；探针发现默认向上搜索会泄漏祖先 paths。
- 本轮实测问题：模块路径/URL 语义错误、顶层 await 和计算型本地 import 不支持；`.node` 也显式失败。修改这些将需要更复杂的模块级变换/加载设计，不能靠通过现有 17 测试掩盖。

### B. jiti 固定版本实例级补丁

保留 jiti 解析/转译链，仅在复制出来的私有包中做了两个运行时改动：

1. `eval_evalModule` 增加实例级 `transformAll` 默认转译路径，使普通 JS/.cjs 依赖也通过 jiti wrapper 与 virtualModules，而不是原生 CJS require。
2. `jitiRequire` 的 JSON 分支在该模式下改用求值图私有缓存，避免 Node require.cache 的跨实例共享，同时保留图内身份。

原型 adapter 另将宿主映射改为 null-prototype + Proxy：仅精确的三个已支持宿主名返回真实 namespace，保留宿主子路径在解析前固定拒绝。未增加 Node 全局 hook、共享身份 registry 或依赖树扫描器。

局部包保留 MIT LICENSE；精确旧/新替换锚点、类型声明变化和 hash 见 `jiti-patch/PATCH.md`。Controller 从未修改的已安装 jiti 逐一应用文档中的三个替换锚点，复原结果与候选运行时逐字相同，无隐藏额外运行时改动。原安装包 runtime SHA-256：`a0b3b8d5e06a0519c66b62179e29200533057920f6f11370546e979dacd24c49`。

**维护风险：** 上游发行文件为压缩 bundle；固定版本补丁可复现，但升级需要重新审查锚点与回归。若选此路线，正式设计必须交代补丁如何随 pnpm/lockfile 安装、默认/关闭选项的兼容测试及升级策略，不能假装这是上游已经提供的功能。当前包为 private；脱离仓库的发布/分发尚未验证。

## 5. 尚未证明或不承诺的边界

- 两个方案都不是沙箱：显式使用 `createRequire` 等 Node 原生逃逸仍可加载另一份包。本轮保的是 **loader 介导的导入/require**，不新增恶意扩展隔离承诺；若要求拦截所有原生逃逸，两个方案都不满足，需要单独架构决策。
- jiti 仍原生处理 builtin、`.node` 及某些未知扩展；原生模块进程级缓存/状态不在本轮独立图隔离证明内。不能把 JavaScript/JSON 检查外推到 native addon。
- JSON 隔离检查覆盖对象；标量 JSON、复杂循环图、完整 ESM live-binding 等未穷尽验证。正式设计/测试必须按兼容承诺补齐，不能称“完全 Node 等价”。
- 仅入口字节与冻结摘要核对；不冻结或递归校验依赖树。同 loader 相同 entryPath+digest 保留既有模块；新 loader 重读依赖。这与原批准缓存边界一致，不是热重载。
- 共用测试的 JSX 证据仍是 automatic runtime + pragma；没有因此新增“支持任意 tsconfig JSX 选项”的承诺。
- 字节供应、路径语义等额外代理探针有些是观察型输出；本报告明确区分它们与 controller 6 项实际断言，不采信仅打印 PASS 的包装器。

## 6. 复跑与证据索引

令 `BASE=.superpowers/sdd/2026-11-09-extensions-selection-a-foundations/loader-selection`：

```bash
bash "$BASE/validate_candidates.sh" esbuild
bash "$BASE/validate_candidates.sh" jiti-patch
node "$BASE/parent-probes.mjs" "$BASE/esbuild/candidate.mjs"
node "$BASE/parent-probes.mjs" "$BASE/jiti-patch/prototype.mjs"
```

Node 22/24/26 的具体原生可执行文件在 `$BASE/runtimes/` 与当前 PATH；controller 已逐一运行，不只是使用配置名模拟版本。

- `make_harness.py`：只生成临时副本，不改产品测试。
- `{esbuild,jiti-patch}/parent-runtime-summary.log`、`parent-node{22,24,26}.log`：最终 17 测试复跑。
- `{esbuild,jiti-patch}/parent-boundaries-node{22,24,26}.log`：独立 6 项边界的完整 JSON 与实际真假值。
- `esbuild/REPORT.md`、`jiti-patch/REPORT.md`：各候选探针、版本、维护风险。
- `jiti-patch/parent-json.log`：最初 JSON cache 漏洞的真实失败状态；后续修补后的正向证明见 controller 边界日志。
- 原有 Plan A `progress.md` / `task-3-fix1-review.md` 继续有效；Task 3 **OPEN/BLOCKED**，不启动 Tasks 4–6 或 B。

参考资料：[jiti 2.7.0](https://github.com/unjs/jiti/tree/v2.7.0)、[esbuild API](https://esbuild.github.io/api/)、[Node 22.19.0 发布文件](https://nodejs.org/dist/v22.19.0/)、[Node 24.11.0 发布文件](https://nodejs.org/dist/v24.11.0/)。本报告的通过/失败结论来自本地运行记录，不是这些页面的能力宣传。

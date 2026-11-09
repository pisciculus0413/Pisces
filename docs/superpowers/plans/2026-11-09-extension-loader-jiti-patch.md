# Task 3 Revision: jiti Local Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使正式 loader 在嵌套 CJS/计算型导入中保留宿主身份，并交付可复现的实例级 jiti 补丁。

**Architecture:** 精确版本 pnpm patch 负责模式、图私有缓存、JSON 互操作、格式拒绝和实例标记；现有 daemon adapter 负责入口字节、宿主映射、安全错误与 promise 缓存。作为原 Task 3 的一次完整修订交付，不另建模块系统，不拆成无法通过完整 G 的中间提交。

**Tech Stack:** TypeScript/ESM、jiti **2.7.0**、pnpm **12.8.1**、Vitest；正式 loader 矩阵使用本地 Node **22.19.0 / 24 / 26**。

**Spec:** [已批准的补丁设计](../specs/2026-11-09-extension-loader-jiti-patch-design.md)；原 [Plan A](2026-11-09-extensions-selection-a-foundations.md) Tasks 1–2 已完成，Tasks 4–6 不改。**本修订计划已获用户确认，当前处于正式实现阶段；Task3 硬门槛与独立审查尚未通过，不推进 Task4。**

## Global Constraints

- 在现有 `dev-pi` checkout 顺序工作；不建 git worktree、不向 main 提交、不 push/merge，保留全部旧 `.superpowers/sdd/`。实施者、审阅者、fixer 均显式 `model="deepseek-flash"`，不嵌套派 agent。
- 当前 HEAD `e7d937db06a8a9a4fa4b5e4401889957fc735672`。Task 3 最终完整审查 BASE 为 `e4776e6f5d73055afc79ed07a14c9166b714f7d6`；不可用 HEAD~1。此前 I1 已关闭，I2 仍阻塞。
- 保留实际未跟踪 `packages/daemon/test/extensions-loader-cjs.test.ts` 及其两个正向身份断言；不删除、skip/todo/fails 或以 collection failure 冒充行为 RED。原型 17+6 通过只是历史能力证据。
- `transformAll === true` 才启用补丁模式；缺省/false 保留上游行为。实例标记 `piscesExtensionModeVersion: 1` 为只读、非枚举；缺失/错误只在 load 阶段安全失败。
- 支持脚本 `.js/.mjs/.cjs/.jsx/.ts/.mts/.cts/.tsx`，依赖另支持 `.json`；按最终文件格式判断。允许 runtime-known builtin 的裸名和 node: 名、三个真实宿主 namespace；扩展实际无后缀文件、`.wasm`、`.node` 与其他格式拒绝原生回退。
- 每个未命中 entryPath+entryDigest 的 load 创建新 jiti 根实例；同图共享私有 JS/JSON 缓存，跨图不共享。缓存 JSON.parse 原值，不添加自引用 default，不改写原生 require.cache。
- 保持 `fsCache:false/moduleCache:false/interopDefault:false/tryNative:false/nativeModules:[]`、已验证入口字节求值、包内 tsconfig 和既有 JSX 测试范围；不递归锁定依赖树、不承诺热重载/沙箱。
- 不用全局 loader/cache monkeypatch、身份 registry、逐包白名单或依赖树扫描；显式 createRequire 等逃逸不在保证内。宿主自己的 N-API 不受扩展格式拒绝影响。
- 不改 Core、protocol、Gateway、binding 或哈希配方。Linux 认证/锁/marker/停机与大小边界沿用 Plan A；Plan B 未授权。
- 每次提交前运行 [完整 G](2026-11-09-extensions-selection.md#共同提交门禁-g)，无文档豁免；当前 RED 未解决前所有计划/设计保持未提交，仅显式暂存本任务归属文件。

## Review Focus

1. 误装原版/错误补丁不得悄然恢复 native CJS；构造不能求值，缺标记与错误版本在 load 前置检查中失败（Step 10）。
2. JSON 的 false/0/null、已有 default 键和非枚举属性不得被互操作破坏，同图 require 与 ESM default 必须拿同一原值（Steps 6/10）。
3. 异步/native 正则路径、实际无后缀与 package exports 不得绕过格式拒绝；合法无后缀 specifier、目录 index 和 builtin 仍可用（Steps 6/10）。
4. 两个入口即使同目录/共用依赖也不能共用求值图；循环依赖必须终止，同入口成功/失败 promise 保持缓存（Steps 2/10）。
5. 异常带秘密、任意 code 或抛错 getter 不能逃出固定错误边界；身份异常 ToolDeniedError 不能被泛化（Step 10）。

## 文件职责

| 路径 | 操作 / 职责 |
|---|---|
| `patches/jiti@2.7.0.patch`、`patches/jiti-2.7.0.md` | 新建：发行运行时/类型的局部 diff；版本、hash、旧新锚点、升级说明，保留 MIT |
| `pnpm-workspace.yaml`、`pnpm-lock.yaml` | 修改：精确 patchedDependencies 与补丁 hash；daemon 已固定 jiti2.7.0，不做无关升级 |
| `packages/daemon/src/extensions/loader.ts` | 修改：模式启用、标记检查、null-prototype 宿主 guard、安全错误分类 |
| `packages/daemon/test/extensions-jiti-patch.test.ts` | 新建：直接引擎契约；类型、字节、图、关闭模式、JSON、拒绝分支 |
| `packages/daemon/test/extensions-loader-patch-guard.test.ts` | 新建：仅测试内 mock jiti；缺/错标记与 eval 不执行 |
| `packages/daemon/test/extensions-loader-boundaries.test.ts` | 新建：正式 adapter 的宿主/格式/模块语义/安全错误与缓存 |
| `packages/daemon/test/extensions-loader-json.test.ts` | 新建：正式 adapter 的 JSON 值与隔离 |
| `packages/daemon/test/extensions-loader-dist.test.ts`、`packages/daemon/test/fixtures/extensions-loader-child.mjs` | 新建：实际 dist 子进程，非原型/alias |
| `packages/daemon/test/fixtures/extensions-loader-native/{binding.gyp,sentinel.c}` | 新建：最小 N-API 正控，initializer 将1写到环境变量指定路径；仅测试，不碰宿主 binding.c |
| `packages/daemon/test/verify-extension-loader-install.mjs` | 新建：隔离副本冻结安装、补丁缺失/损坏负控、真实 dist 验证；不是全局安装脚本 |
| 原有三个 loader 测试、`extensions-fixtures.ts` | 保留；新测试复用 writeText/writeJson，必要补充小型 fixture，不弱化原断言 |
| 本计划、补丁设计、Plan A/索引/交接/研究报告 | 状态同步；不把候选通过写成产品验收 |

### Task 3R: 正式补丁、adapter 和完整能力门槛

**证据目录：** `.superpowers/sdd/2026-11-09-extensions-selection-a-foundations/`（下称 STATE）。先读 `STATE/task-3-review.md`、`STATE/task-3-fix1-review.md`；新报告为 `STATE/task-3-jiti-patch-report.md`，独立审查为 `STATE/task-3-jiti-patch-review.md`，新日志加 `task-3-jiti-patch-` 前缀，不覆盖历史记录。除补丁可读 provenance 外不要求继承整段 spike 输出。

**Interfaces:**
- Consumes `DiscoveredEntry`、`sha256`、Task 2 `writeText/writeJson`；不要求未来 binding 接口。
- Preserves `ExtensionModule { default: unknown; config?: unknown }`、`ExtensionLoader { load(entry: DiscoveredEntry): Promise<ExtensionModule> }`、`createExtensionLoader(): ExtensionLoader`、`ExtensionLoadError`。
- Patched types: `JitiOptions.transformAll?: boolean`；返回 Jiti 实例 `readonly piscesExtensionModeVersion?: 1`。私有 reason code 固定为 `ERR_PISCES_EXTENSION_FORMAT`、`ERR_PISCES_EXTENSION_JSON`；冲突模式可用 `ERR_PISCES_EXTENSION_MODE`，在 adapter 按通用失败处理，不新增协议 code。
- `loader.ts` 私有 `loadFailure(error: unknown): ExtensionLoadError` 仅从安全读取的静态 reason 映射固定消息；其他输入统一 generic，不透传 error.message/cause/data。
- 子进程 fixture CLI：`node packages/daemon/test/fixtures/extensions-loader-child.mjs <case> <packageRoot>`；case 为 `hosts|json|semantics|formats`，stdout 单个断言结果 JSON。入口使用该 root 下 `entry.ts`，自行读字节计算摘要；导入真实 daemon/dist loader 与实际三个宿主包。
- 安装验证 CLI：`node packages/daemon/test/verify-extension-loader-install.mjs`；成功 exit0，失败非零，输出实际安装/运行时/子命令退出码，finally 清理临时目录。不挂 postinstall 或默认 Vitest 测试，作为补丁/manifest/lock 改动后的额外必跑门禁。

- [ ] **Step 1: 核对基线与所有权。** 读取本计划/补丁设计/原 Task 3 review 与 I1 scoped review，保存 git status、完整 SHA、index。运行 `node packages/daemon/native/build.mjs`、`pnpm exec tsc -b tsconfig.build.json`，再运行 `pnpm exec vitest run packages/daemon/test/extensions-loader-cjs.test.ts`，预期只有两个真实身份断言 RED；若出现别的阻塞先诊断。不重做 Tasks1/2。

- [ ] **Step 2: 写引擎模式测试。** 在 `extensions-jiti-patch.test.ts` 写以下实际断言；只 import 已有 createJiti，私有类型用测试交叉类型允许补丁前收集，不能 import 尚不存在的新 named export。命名测试 `marks enabled instance`、`evaluates verified bytes rather than disk`、`preserves upstream transform when omitted or false`、`terminates a private CJS cycle`、`rejects conflicting forceTranspile false`。fixture 局部 helper `exists(path: string): Promise<boolean>` 仅 ENOENT 返回 false，其他错误抛出；`counter(): Promise<number>` 读取本测试计数文件。
  ```ts
  expect(Object.getOwnPropertyDescriptor(enabled, "piscesExtensionModeVersion")).toEqual({ value: 1, writable: false, enumerable: false, configurable: false });
  expect(verifiedModule.default()).toBe("verified"); // 磁盘代码返回disk并写sentinel，传入字节返回verified
  expect(await exists(diskSentinel)).toBe(false);
  expect(cycleResult).toEqual({ a: "a", b: "b", seenA: "a" });
  ```
  另以 omitted/false/true 参数化转译 TSX 依赖（本地 JSX runtime），三者都应返回同一 view；false 不能阻止上游转译。enabled 的嵌套 `.cjs/.js` 得到传入的宿主实际导出。显式 forceTranspile:false 与扩展模式冲突时拒绝 `ERR_PISCES_EXTENSION_MODE`，不得执行磁盘 sentinel。

- [ ] **Step 3: 记录模式 RED。** `pnpm exec vitest run packages/daemon/test/extensions-jiti-patch.test.ts`；记录缺标记/错误身份/字节的具体行为失败；关闭模式与现有成功控制应能执行，不把未收集/类型检查失败算 RED。

- [ ] **Step 4: 生成第一版正式 patch。** 用 `pnpm patch jiti@2.7.0 --edit-dir <私有临时目录>` 提取原版；先读完整 jitiRequire/eval_evalModule/createJiti 相关控制流，再实现 true-only 模式、实例只读标记、嵌套转译与图内循环缓存；默认/false 不改。经 `pnpm patch-commit` 登记 `patches/jiti@2.7.0.patch`、workspace 与 lock；不直接编辑已安装包。更新补丁说明，不导入整个旧原型。后续每次扩展 patch 均通过 pnpm 原生编辑/提交机制再生成，不能手工改安装目录。

- [ ] **Step 5: 证明模式 GREEN。** 重跑 Step3；只有已写模式测试全部通过才继续。现有 adapter 尚未开启模式，原 CJS 产品 RED 仍可存在，不据此提交或声称 Task3 完成。

- [ ] **Step 6: 写引擎 JSON/格式测试。** 命名测试 `keeps raw JSON identity`、`isolates fresh graph JSON`、`rejects unsupported formats before native fallback`，输入表逐行展开。参数化 `{x:1}`、`[1,2]`、`"x"`、`0`、`2`、`false`、`true`、`null`、`{default:7}`；同图 require 与 ESM default ===、返回值深等于输入、对象 ownKeys 无额外 default。跨新根实例修改磁盘后见 v2、无 v1 mutation。坏 JSON 抛固定私有 JSON reason。格式表覆盖全部八种脚本、JSON 依赖、bare/node builtin；nativeModules 命中的 JS/CJS 依赖在扩展模式也必须取得传入的宿主导出，不能恢复原生副本；extensionless specifier/目录index/package exports 正常解析到支持后缀，实际无后缀/.wasm/.node/.txt 与通过 evalModule(filename为.json) 求值的 JSON代码入口均在 native fallback 前拒绝 `ERR_PISCES_EXTENSION_FORMAT`，同步和异步路径都测；每个拒绝用可通过的脚本邻接控制。

  `.node` 使用最小有效 N-API fixture：target 名 sentinel，initializer 只按 `PISCES_EXTENSION_NATIVE_SENTINEL` 写1并返回 exports。将 C/gyp 复制到临时目录，用现有 daemon node-gyp（通过 createRequire 解析）构建；原生独立 child require 必须成功并写 sentinel，清除后扩展模式拒绝且不写。工具链失败应报失败，不 skip；不可用无效 .node 的 dlopen 错误冒充主动拒绝。

- [ ] **Step 7: 记录 JSON/格式 RED。** 重跑引擎文件，记录字段、标量或 reason 的实际失败，不能把此前 JSON mutation 探针改称本轮原始 RED。

- [ ] **Step 8: 扩展正式 patch。** 加图私有 raw-JSON 缓存及独立 namespace 互操作；在 jiti 自身同步/异步解析及 eval 原生分支之前加入格式检查。不得新增扫描器/白名单。更新类型与每个新增锚点/hash；默认/false 分支保持原样，适用的 MIT 文件不变。

- [ ] **Step 9: 证明引擎 GREEN。** 同一引擎文件全部通过；直接供应字节、关闭模式、JS/CJS 循环、JSON 标量和两类拒绝 reason 都有实际结果。在补丁说明中记录 patch 文件、最终运行时与类型文件的 SHA-256，不能引用原型 hash。

- [ ] **Step 10: 写正式 adapter 与 dist 回归。** 保留原三个 loader 测试，新建表中四个 adapter/dist 测试与 child；核心测试名为 `keeps all three transitive host exports`、`retains graph and failure cache boundaries`、`keeps raw JSON values through loader`、`rejects missing or wrong patch before eval`、`normalizes hostile error metadata`、`checks actual dist cases`；断言如下，每个 load 入口均有正确摘要，依赖不递归哈希。
  ```ts
  expect(result.core).toBe(ToolDeniedError);
  expect(result.protocol).toBe(encodeFrame);
  expect(result.daemon).toBe(bootstrapGateway);
  expect(result.error).toBeInstanceOf(ToolDeniedError);
  expect(repeatedLoad).toBe(firstLoad); // 同一promise，含失败；另比module身份/执行次数
  expect(await counter()).toBe(1);
  ```
  hosts 覆盖 static/dynamic/计算型 require/import 经两层 CJS 的三包导出，扩展 vendored 副本和 tsconfig 同名 alias 不得取胜。子路径 guard 与继承键 `toString/constructor/__proto__` 不得误映射；子路径固定拒绝。semantics 比较依赖自己的 dirname/filename/metaURL、TLA 返回17、计算型相对导入返回19；双入口共用依赖但独立图，旧入口保持缓存，新 loader 见更新。坏 JSON 必须在顶层 import 触发失败；只修好依赖且不改入口摘要后，旧 loader 仍返回同一失败 promise，新 loader 则能成功，且其他入口不被污染。

  JSON 用 Step6 同一值矩阵，检查 require/default === 与 ownKeys；坏 JSON 应为 `Extension module JSON is invalid`。格式矩阵用正式 load 拒绝入口/依赖，builtin 有正控。guard 测试仅在独立 test 文件 mock jiti 返回缺标记/0/2，fake evalModule 若被调用会写 sentinel；`.load` 必须拒绝 `Extension loader patch is unavailable` 且 eval 未调用，构造本身不失败。格式错误为 `Unsupported extension module format`；带 secret/任意 code/抛错 code getter 的异常一律 generic 且无 cause/data/secret，不新增生产注入接口。

  child 仅导入实际 dist，无 Vitest alias；四个 case 必须自己 assert，退出0才输出成功。spawn 清除 NODE_OPTIONS/VITEST，用 process.execPath，15秒 SIGKILL 并等待 close、finally 清理 fixture；测试不能只看未抛错或输出 PASS。

- [ ] **Step 11: 记录 adapter RED。** `pnpm exec vitest run packages/daemon/test/extensions-loader*.test.ts`；新补丁已安装但 adapter 尚未启用，记录确实缺失的模式/guard/分类行为；dist 先重新构建，不能用旧 dist 人为制造 RED。

- [ ] **Step 12: 实现 adapter 接线。** 只修改 `loader.ts`：hostModules 签名不变，返回 null-prototype guard；保留 prep 的 I1 安全 try。缓存未命中创建新 jiti，设置 transformAll:true，安全检查标记后才 evalModule 已验字节。loadFailure 将两种私有 reason 映射为 Step10 固定消息，其他统一 `Extension module failed to load`；不读取不可信异常文本，读取分类元数据本身抛错也必须归一化。保留 kind/digest/default/config 与失败缓存行为，不动 Core/协议。

- [ ] **Step 13: 证明正式 GREEN。** 重建 dist，运行 `pnpm exec vitest run packages/daemon/test/extensions-jiti-patch.test.ts packages/daemon/test/extensions-loader*.test.ts`，原 CJS 两个正向断言必须通过；不使用私有原型。再对实际 Node22.19.0/24/26 分别运行 `"$NODE" node_modules/vitest/vitest.mjs run packages/daemon/test/extensions-jiti-patch.test.ts packages/daemon/test/extensions-loader*.test.ts`；先执行 `"$NODE" --version`，child 继承相同 execPath。现有私有目录内已校验的22.19.0/24.11.0二进制可作验证工具（不是产品依赖），26使用实际安装版本；保存版本/命令/退出码，不可用明确缺证据，远端 CI 不宣称已跑。

- [ ] **Step 14: 实现安装验证器。** 新建 `verify-extension-loader-install.mjs`：由当前 workspace 制作临时副本（不是 git worktree），包含尚未提交的本任务所有源/测试/patch/manifest/lock；不复制 node_modules/dist/旧spike。在那里以 pnpm12.8.1执行 frozen-lockfile 安装、新 native build/tsc build，并运行真实 dist case 和类型检查。采用独立临时 store 防止本机已修补缓存掩盖缺补丁；另用独立负控副本删除 patch 文件、修改 patch 内容但不更新 lock，组合安装/完整性子门禁必须非零；若 pnpm 未直接拒绝，独立检查按补丁说明的 SHA-256 拒绝，不能以 install0 当作通过。每个子进程设置超时、等待结束，finally 清理。补丁标记/host身份实际检查通过才报成功，不能只 grep 配置。

- [ ] **Step 15: 运行安装门禁。** `node packages/daemon/test/verify-extension-loader-install.mjs` 必须 exit0；冻结安装、真实 dist/类型检查成功，两个独立安装/完整性负控必须各自失败。记录实际命令/退出码，负控仅证明验证敏感性，不伪称原始行为 RED。

- [ ] **Step 16: 完整 G 与提交。** 运行索引中原始 G（两个 rg 分别 exit1，不能吞错）；记录实际结果/跳过项。审核 git status、补丁说明、测试/文档归属；设计/计划与首次使 G 转绿的实现一并显式暂存，不能先做 RED 文档提交。
  ```bash
  git add patches/jiti@2.7.0.patch patches/jiti-2.7.0.md pnpm-workspace.yaml pnpm-lock.yaml packages/daemon/src/extensions/loader.ts
  git add packages/daemon/test/extensions-jiti-patch.test.ts packages/daemon/test/extensions-loader-patch-guard.test.ts packages/daemon/test/extensions-loader-boundaries.test.ts packages/daemon/test/extensions-loader-json.test.ts packages/daemon/test/extensions-loader-dist.test.ts packages/daemon/test/fixtures/extensions-loader-child.mjs packages/daemon/test/fixtures/extensions-loader-native/binding.gyp packages/daemon/test/fixtures/extensions-loader-native/sentinel.c packages/daemon/test/verify-extension-loader-install.mjs packages/daemon/test/extensions-loader-cjs.test.ts
  git add docs/superpowers/specs/2026-11-09-extension-loader-jiti-patch-design.md docs/superpowers/plans/2026-11-09-extension-loader-jiti-patch.md docs/superpowers/plans/2026-11-09-extensions-selection-a-foundations.md docs/superpowers/plans/2026-11-09-extensions-selection.md docs/superpowers/specs/2026-11-09-extensions-selection-design.md docs/superpowers/research/2026-11-09-extension-loader-selection.md docs/superpowers/handoffs/2026-11-09-extensions-selection-a-to-b.md
  git diff --cached --stat
  git diff --cached --check
  git commit -m "fix(daemon): preserve host identity through patched extension loading"
  ```
  以上为预期清单：若实现确实修改公共fixture或原测试，只能在确认本任务归属后额外列出其精确路径，不扩大暂存范围。

- [ ] **Step 17: 独立完整 Task 3 审查。** 新 deepseek-flash reviewer 读取原始 BASE 到实际验收提交的完整 diff、补丁可读锚点、逐组 RED/GREEN、多运行时/dist/安装/G 记录及 I1 接受结论。Critical/Important 按既有有界修复/限定复审关闭；延期 Minor 留账交 A 整体审查。Task3 硬门槛被 controller 接受后才更新状态并接回 Tasks4–6，不自动开始 B。

## 自审与交接

- Spec§1–2/8 的边界与版本约束在 Global/Steps1/16/17；§3 分发/标记在 Steps2–5/10/14–15；§4 模式/格式在 Steps2–9/10–13；§5 缓存/JSON在 Steps2/6–10；§6 宿主/错误在 Steps10–13；§7 全矩阵在 Steps13–17。五项 Review Focus 均有明确测试，无延期到 B 的能力门槛。
- 保留一个独立审查交付单元：补丁与 adapter 不能单独让原产品 G 变绿，故不制造假“完成”的中间任务/提交。内部各 TDD 周期分别保存证据，不改写历史 RED。
- 用户已确认计划并要求开始工作；保持 deepseek-flash SDD，不重新询问模式。按以上 TDD/门禁实施，不在 G 转绿前提交。

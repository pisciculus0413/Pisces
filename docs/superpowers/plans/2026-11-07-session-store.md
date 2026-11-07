# SessionStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付真实 Node 文件后端 SessionRepository，支持整批提交、树/分支读取、元数据更新及文件级启动恢复。

**Architecture:** daemon 的 SessionStore 实现现有 core 契约，不修改 Sessions 接口。JSONL 文件保存节点，commit 文件保存已提交 UTF-8 字节数；内存索引仅保存节点父指针和字节位置。同会话仓库写操作串行，显式初始化先恢复文件，再由未来 Gateway 开始监听。

**Tech Stack:** TypeScript、Node >=22.19.0、ESM、node:fs/promises、Vitest；不新增第三方依赖。

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §5.3、§6.5；`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §4.1、§5.4、§6.5、§7.3、§7.5、§8.1。执行者同时阅读现有 `packages/core/src/sessions/`。

## Global Constraints

- 核心层不得依赖服务层、客户端或运行环境。
- 会话树只追加，不删除、不改写。
- 所有持久化记录都带 `schemaVersion`；当前版本为 `1`。
- 时间戳为 RFC 3339 UTC 字符串，精确到毫秒，例如 `2026-11-06T13:00:00.000Z`。
- 未出现的可选字段表示未设置；不使用 `null` 表示“未设置”。
- 本批只支持版本 1；没有历史格式，不建迁移注册框架。
- 不实施 Gateway、活跃 turn 恢复/中断节点、Context、Concurrency 服务、项目/模板记录、配置加载或网络监听；保留已有 `active-turn.json` 与 `projects.json`。
- 在现有 `dev-codex` 原地实施；用户已选择子智能体开发、主智能体验收；不创建 worktree，不 push、不 merge，不再询问执行方式。
- 使用真实 Node 临时目录测试；故障注入只替换指定 I/O 步骤，其余调用真实文件系统。

## Review Focus

- UTF-8 中文/emoji 和半字符尾部：commit/offset 必须是字节，不是 JS 字符数；由 Step 1、5 覆盖。
- 同名并发 create：失败调用不能删除成功调用的目录；不同会话应能同时推进；由 Step 3 覆盖。
- meta 已存在但 commit 丢失/损坏：报告 corrupt 并保留证据，不能按孤儿删除；由 Step 5 覆盖。
- rename 已完成但目录同步失败：调用可能报错且整批已提交，不能截断或删除该批；由 Step 3 覆盖。
- session 目录或文件是符号链接：拒绝跟随并保留链接目标，避免恢复删除越界；由 Step 5 覆盖。

## 已批准的接口与语义裁定

主智能体已批准以下细化；实现时同步少量修订 HLD/DDS 的矛盾表述，不扩展本里程碑。

```ts
// packages/daemon/src/session-store/session-store.ts，由 daemon/src/index.ts 导出
interface SessionStoreOptions { dataDir: string }
interface RecoveryIssue { sessionId: SessionId; error: PiscesError }
interface SessionStore extends SessionRepository {
  initialize(): Promise<RecoveryIssue[]>;
}
function createSessionStore(options: SessionStoreOptions): SessionStore;
```

- 工厂只构造对象，不读写文件。`initialize()` 创建 sessions 根目录、扫描恢复；同实例并发初始化共用一次 promise，成功后再次调用返回原报告，不重复清理。初始化前调用仓库方法（含开始迭代）抛 TypeError。根目录不可读/创建失败返回 `storage.io` 并拒绝初始化；每会话故障收集为 RecoveryIssue，其他会话仍可用。失败初始化可丢弃实例后重试。
- 初始化发现损坏会话后，其读取/append/updateMeta 抛该错误；`list()` 遇损坏会话整体拒绝，不静默跳过、不返回部分列表。调用者仍能直接读取健康会话。恢复报告不代表 Gateway turn 恢复已完成。
- `dataDir` 由调用者显式注入；当前无 daemon 配置实现，本批不引入默认路径或配置服务。
- 同实例为每个 sessionId 建轻量 promise 队列，覆盖 create/append/updateMeta 的校验、磁盘提交和缓存更新；拒绝不会毒化后续队列，不同 id 无全局写锁。未来 `Concurrency` 还必须覆盖 `Sessions.append` 读取父节点到写入的整个操作；仓库写锁不声称解决该复合操作的竞争。不支持多进程/多实例共享目录并发写。
- 单个读取先取得稳定的已提交边界/索引快照，不把 append 中的新行混入已开始的迭代；更新/失败淘汰缓存不修改旧快照。首次加载完整校验后才 yield，损坏记录不能先返回部分节点。

### 文件、校验与错误

- 路径为 `<dataDir>/sessions/<sessionId>/{meta.json,events.jsonl,events.commit}`，临时文件为对应文件名加 `.tmp`。sessionId 限制为 `/^[A-Za-z0-9_-]+$/`；非法 id 在任何路径访问前抛 TypeError。NodeId 只用于索引，不拼入路径。
- commit 格式为十进制非负安全整数的 ASCII 文本，写出 `${C}\n`，读取允许无最后换行；拒绝符号、小数、空文本、额外内容、超出安全整数。校验 `0 <= C <= stat.size`，C>0 时前一字节必须为 LF。C=0 但有 meta 的空会话属于 `storage.corrupt`。
- 每节点 `JSON.stringify(node) + "\n"` 编码为 UTF-8 Buffer，偏移/行长均按 Buffer 计算。只解析 `[0,C)`；UTF-8 无效、完整行 JSON 无效或非对象属于 `storage.corrupt`；空白行按 DDS 忽略且仍计入字节偏移。
- 用本模块小型函数校验 meta/node 必需字段和 ContentBlock 判别字段（含嵌套 toolResult），不加通用 schema 库。meta 校验 id 与目录名一致、model/provider/workspace 为非空字符串、createdAt 为毫秒 UTC 时间、schemaVersion===1；node 校验非空 id/parentId、合法 kind/role、content 数组、source 字符串、createdAt/schemaVersion、synthetic 可选值。控制消息 content 仅接受一个含 JSON 对象文本的 text 块；不在此实施 Context 的 declaration/compaction/cancel 语义。
- 一个非空会话只能有首节点自指的根；其余节点父节点必须已在同会话的更早记录中，id 不重复。这样拒绝缺父、多根、自环、长环及前向引用。内存索引为 `Map<NodeId, {parentId, offset, length}>`，另保存 commit 和末节点 id，不常驻整棵节点内容。
- 磁盘格式/版本/拓扑损坏返回 PiscesError `storage.corrupt`；磁盘 I/O 故障返回 `storage.io` 并保留 cause。不存在会话 `session.not_found`；显式分支末端或 append 的首父节点不在该会话 `session.node_not_found`。内部非法写入参数（空批、重复 id、批内链不连续、非法形状）用 TypeError，必须在写盘前拒绝。create 已有目录用 TypeError，绝不覆盖。
- updateMeta 仅采用输入 model/provider，保留已有 id/workspace/createdAt/schemaVersion；即便输入这些字段不同也忽略。先读取已有有效 meta，再校验新 model/provider。
- sessions 根目录、受控名称会话目录和已知文件必须是普通目录/普通文件；lstat 发现符号链接/错误文件类型报告 `storage.corrupt`，不跟随链接。sessions 根目录为符号链接时初始化整体拒绝，不沿其扫描或清理；不扩展到敌对进程竞态防护。无关文件和不受控名称条目忽略，不递归清理用户数据。

### 提交点、故障和恢复

- create 用非 recursive mkdir 独占创建 session 目录，写并 fsync 三个 tmp，依次 rename events → commit → meta；meta rename 是可见提交点。提交前失败只删除**本调用成功创建且尚未提交**的目录，使同进程能重试；mkdir EEXIST 的失败方不得清理任何东西。提交后绝不删除会话目录。
- append 在写锁内读取/校验 C，先截断未提交尾部到 C，写入并 fsync 本批完整 JSONL，写并 fsync commit.tmp 后 rename 为 commit；commit rename 是提交点。更新内存索引只能发生在提交后。旧 C 前字节保持不变，不重写整文件；失败尾部由读取忽略、下次 append/启动截断。
- updateMeta 写并 fsync meta.tmp 后 rename；rename 是提交点。所有替换都使用同目录临时文件，禁止先 unlink 旧目标来兼容 rename。
- rename 后 fsync 会话目录；create 还同步 sessions 父目录以持久化新目录项。POSIX 目录同步错误上抛；Windows 对目录 open/sync 的已知不支持错误 EPERM/EACCES/EINVAL/ENOTSUP 使用可用语义，不能吞掉普通文件的同步错误或一般 EIO。不声称不同平台、文件系统或断电下具有相同持久性。
- 提交点之前故障保证新批不可见；提交点之后发生目录同步失败时返回 `storage.io`，可能已经整批提交。此时失效索引/meta 缓存，下次操作重读 commit/meta；绝不回滚截断已提交数据。无论哪种情况都不能看到半批；调用者不能仅因 storage.io 就盲目重试造成重复节点。
- 启动对拥有 meta 的目录先验证 meta/commit/events，再做截尾；commit 缺失、非法、越界或不在换行边界均报告 corrupt，保留原始数据，不截断。没有 meta 的受控普通会话目录才可作为 create 遗留孤儿删除（包含已有 commit 的情况）。无 meta/无 commit 同样可删；有 meta/无 commit 不可删。
- 对健康会话清理本模块拥有的三个 `.tmp` 文件，截断 events 至 C 并同步；对损坏会话保留文件以便诊断。初始化文件恢复不触碰 active-turn 标记、项目记录，不合成任何节点。再次初始化新实例结果幂等。

---

### Task 1: 完整文件 SessionRepository、恢复与集成验收

这是一个整体任务：格式、事务、索引与恢复共同组成可交付后端，不把中间半成品作为单独交付或提交。

**Files:**
- Create: `packages/daemon/src/session-store/session-store.ts` — 工厂、初始化、仓库方法、按会话队列和索引。
- Create: `packages/daemon/src/session-store/session-store-format.ts` — UTF-8/commit/meta/node 校验与索引建立的内部纯函数。
- Create: `packages/daemon/src/session-store/session-store-io.ts` — Node I/O 薄封装及同步/原子替换原语，测试注入故障的唯一 seam。
- Modify: `packages/daemon/src/index.ts` — 导出工厂和公共接口，内部 I/O/格式工具不作包导出。
- Modify: `packages/daemon/package.json` — 添加 `"@pisces/core": "workspace:*"` 到 dependencies；源码通过 `@pisces/core` 导入，不跨包相对导入。
- Modify: `pnpm-lock.yaml` — 只同步 daemon 的本地 core workspace link，不升级外部包；确认实际 workspace lock 文档位置，不改 package-manager 自举段。
- Create: `packages/daemon/test/session-store.test.ts` — 正常路径、边界、core 集成。
- Create: `packages/daemon/test/session-store-recovery.test.ts` — 文件故障、重启与恢复隔离。
- Modify: `docs/1 High-Level Design/1 High-Level Design.md` — 只澄清存储提交点后失败的不确定性。
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` — 在 §4.1/§5.4/§6.5/§7.5 同步提交点、保留损坏会话和初始化报告约定，不改 Gateway 恢复流程。

**Interfaces:**
- Consumes: 现有 `SessionRepository` 六方法、`SessionMeta`、`SessionNode`、`NodeId`、`SessionId`、`PiscesError`、`createSessions`。
- Produces: 上述 `createSessionStore`、`SessionStore`、`SessionStoreOptions`、`RecoveryIssue`；六个仓库方法签名保持 core 原样。
- 内部 `sessionStoreIo` 对象只包装实际需要的 node:fs/promises 调用，加 `writeSynced(path: string, bytes: Uint8Array): Promise<void>`、`appendSynced(path: string, bytes: Uint8Array): Promise<void>` 和 `syncDirectory(path: string, platform?: NodeJS.Platform): Promise<void>`。二者文件写方法负责打开、完整写入、fsync、finally close；平台参数默认 process.platform，只供平台分支测试。保留 rename/truncate 等 Node 原签名，不建可替换存储框架。
- 测试 `vi.spyOn(sessionStoreIo, ...)` 单次注入故障并转发其他调用；部分 append 测试在 seam 中先真正追加部分 Buffer 再抛 EIO。每例独立 mkdtemp(tmpdir())、finally/afterEach rm，spy 恢复；不并行运行共享 spy 的用例。

- [ ] **Step 1: 编写正常路径失败测试。** 在 session-store.test.ts 从 daemon 公共入口导入工厂；每例初始化新目录。meta 使用 s1/m/p、workspace=/workspace、createdAt=`2026-11-06T13:00:00.000Z`、schemaVersion=1。节点依次 n1→n2→n3，再从 n1 append n4，文本包含 `中文🐟`。断言 create 两节点、append 一节点批次成功；树为 [n1,n2,n3,n4]，默认分支 [n1,n4]，指定 n3 为 [n1,n2,n3]；读旧分支不改默认。events.commit 数字等于真实 JSONL Buffer.byteLength，严格大于字符串 length；offset 对中文节点仍能精确读取。updateMeta 输入其他不可变字段被改变时只更新 model/provider，list 返回落盘 meta 且顺序无要求。新实例 initialize 后结果一致；尚未 create 的会话不在列表且无目录。
- [ ] **Step 2: 运行红灯并实现最小完整读写路径。** 运行 `node_modules/.bin/vitest run packages/daemon/test/session-store.test.ts`，确认缺少公开工厂失败。完成依赖/link、三模块和公开导出，按已裁定流程实现；内部格式函数自行命名，不作公开 API。用 node:fs 文件句柄确保完整写入/同步并及时关闭。复跑单文件，预期通过。
- [ ] **Step 3: 编写事务故障与并发失败测试。** 在 recovery 测试中对 create 三次文件写/同步、三次 rename 各边界参数化注入 EIO；提交前 list 无该会话且同实例可完整重试，已有其他会话字节不变。已有目录 create 和 Promise.allSettled 同 id 两次 create 断言一成功一失败，成功方 meta/events/commit 均保留。append 在实际写入半批后、commit tmp 同步、commit rename 前失败均只能读旧整批；重试后只得到一次完整新批。rename 已成功后同步目录失败的 create/append/updateMeta 报 storage.io，但同实例重读及重启看到完整新值，绝不看到半批、旧缓存或删除目录。updateMeta 提交前失败保留旧 meta。对同会话并发 append/updateMeta 用延迟的 I/O gate 确认串行且 commit/索引一致，失败后的后续写仍执行；对两个 sessionId 延迟 s1 写入，s2 能在释放 s1 gate 前完成。测试按目标 sessionId/路径匹配故障，避免误伤根目录初始化。
- [ ] **Step 4: 确认新增红灯并完成事务实现。** 运行 `node_modules/.bin/vitest run packages/daemon/test/session-store-recovery.test.ts`，失败必须对应预期事务/缓存/锁缺口；若已有覆盖直接通过则记录。补每会话队列、提交阶段标记、严格目录所有权、故障缓存失效，重跑两文件至全绿。保持提交后错误的整批可见断言，不把它改为虚假回滚。
- [ ] **Step 5: 编写格式、恢复及隔离测试。** 参数化验证缺失会话/外会话节点错误；空批和非法 sessionId（`../x`、`/tmp/x`、`a/b`、`a\\b`、`.`、`..`、空字符串）拒绝且目标外哨兵文件不变；写入重复 id/错误链预校验失败，旧文件不变。手工构造有效 C 后的完整未提交行、坏 JSON、半个 UTF-8 字符：普通读取忽略且 stat 不变，下一 append/新实例初始化截尾，已提交前缀逐字节不变。空白行合法；提交区坏 JSON/非法 UTF-8、重复 id、缺父、多根、环、schemaVersion=0/2、错误 meta 字段都 corrupt。commit 缺失/空/负数/小数/溢出/越界/非换行边界必须保留有效 meta 和原 events，初始化返回 RecoveryIssue，read/list 拒绝且没有部分结果。无 meta 孤儿目录被删，健康会话三个 tmp 清除；active-turn.json、projects.json、无关文件保留。坏会话旁的健康会话能直接读取。sessions 根目录符号链接使初始化整体拒绝且不扫描或清理目标；会话目录/文件符号链接不会被跟随/递归删除，链接目标哨兵保留（平台无权限创建 symlink 时显式 skip）。初始化前方法拒绝；并发 initialize 只执行一次，根目录注入 EACCES 返回 storage.io；重启恢复幂等。直接测 syncDirectory 的 Windows 不支持错误允许降级，一般 EIO 和 POSIX 同错误传播。
- [ ] **Step 6: 验证红灯并补齐恢复/校验。** 运行上述两个测试文件，确认故障检查针对预期不变量；完成初始化报告、文件类型检查、UTF-8/结构/拓扑校验和安全清理。每次恢复先验证、后截尾，坏 commit 不作为删除依据；无需磁盘持久化索引或迁移框架。复跑目标文件至通过。
- [ ] **Step 7: 添加真实 core 集成并同步文档。** session-store.test.ts 使用 `createSessions({repository: store,newId,now})` 完成 create/默认 append/从旧节点分支 append；新 store 重启后树和分支相同。用 seam 提交前故障证明 Sessions 不返回部分结果、读取仍为旧快照。确认该测试先针对缺口失败或记录已有行为后通过。修订上面列出的 HLD/DDS 文句：首次落盘失败无节点仅限提交前；提交后 I/O 失败整批可能存在；meta 存在但 commit 缺失/非法须保留报告，初始化报告是按会话收集；不扩写后续运行时功能。
- [ ] **Step 8: 完整验收。** 依次运行 `node_modules/.bin/vitest run`、`node_modules/.bin/tsc -p tsconfig.json`、`node_modules/.bin/tsc -b tsconfig.build.json`、`node_modules/.bin/biome check packages/daemon/src packages/daemon/test packages/daemon/package.json`，全部退出 0。从构建产物直接 `import('./packages/daemon/dist/index.js')` 确认 workspace core 运行时解析，不依赖 Vitest alias。核对 append 不重写旧 JSONL，readBranch 在索引就绪后只读取分支对应行；用 I/O spy 验证读取字节范围，避免耗时基准测试。检查 core 无 Node/daemon 新依赖，git diff 无无关变更。
- [ ] **Step 9: 主智能体整体验收后提交。** 主智能体审查提交点/恢复/锁/测试证据；修复发现的问题再重复受影响检查。`git branch --show-current` 必须为 dev-codex；`git status --short` 验证归属，只显式 `git add` 本任务实际创建/修改的文件（及本计划若由主智能体决定一并提交），提交 `feat(daemon): implement file session repository`。不 push、不 merge。

## 验收边界

交付物为能真实落盘、重启恢复并满足 core 仓库契约的 Node 后端；必须一次交付全部格式/事务/索引/恢复能力。文件恢复不等于活跃 turn 恢复。测试模拟明确 I/O 故障及进程重启后的文件状态，不宣称已验证硬件断电或 Windows 原生文件系统行为。计划已按上述规范覆盖自检；发现与这里已批准裁定不同的实现需要先交主智能体审查，不自动扩大范围。

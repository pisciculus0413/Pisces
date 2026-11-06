# P0 决策表

## 1 目的

本表只记录详细设计开始前必须确定的实现级决策，不重复 HLD 已定原则。

判定标准：

- 影响两个以上章节的公共类型、线上格式或持久化格式；
- 一旦正文展开后再修改，会波及大量接口与流程；
- HLD 已给出方向，但尚未给出可实现的精确形态。

本表不修改 HLD。若结论与 HLD 冲突，以 HLD 为准；确需修改 HLD 的条目单独列出。

## 2 已定基线

以下内容来自 HLD 或前序评审，不再作为未定项：

1. 系统提示词、扩展声明、用户消息一律先进入消息队列，经用户审查、修改、确认后才参与装配；上述内容不得通过 `session.create`、`session.configure` 或 CLI 参数绕过队列直接写入请求体或 `SessionMeta`。
2. `SessionMeta` 不含 `systemPrompt`、扩展选择、活动分支或运行状态。系统提示词是 `role=system` 的智能体消息，扩展选择是 `role=declaration` 的控制消息。
3. 会话树只追加、不删除；根节点父指针指向自身；默认活动分支为记录末行节点所在分支；不保存 `headNodeId`。
4. 临时会话只存在于服务层内存；首次 `turn.start` 产生节点后，`SessionRepository.create` 原子写入 meta 与初始节点；空会话不落盘，不进入 `session.list`。
5. `SessionNode.id`、`parentId` 由 `Sessions` 统一分配；队列条目的临时 `id` 由 `Context` 分配，出队后作废，不写入节点。
6. 声明选择不保存完整快照；由会话记录与队列中的声明类控制消息按异或计算。
7. 裁剪与压缩是确定性的，不额外调用模型；裁剪不新增节点，压缩写入控制消息。
8. `ContentBlock` 使用 `text`、`reasoning`、`toolCall`、`toolResult` 四种形态；控制消息的 `content` 也使用 `ContentBlock[]`。
9. 队列不持久化；daemon 崩溃时未装配队列随之丢失，不做 WAL 或恢复。
10. 退订不等于中止；连接断开清除该连接订阅，但不终止活跃 turn。

## 3 P0 决策

| ID | 决策点 | 结论 | 理由与影响 |
|---|---|---|---|
| P0-01 | `ContentBlock` 与 `Message` 的精确形状 | `ContentBlock = {type:"text",text} \| {type:"reasoning",text} \| {type:"toolCall",id,name,arguments:JsonValue} \| {type:"toolResult",toolCallId,content:ContentBlock[],isError?}`；`Message = {role:"system"\|"user"\|"assistant"\|"tool", content:ContentBlock[]}` | HLD 将辅助类型留给详细设计。工具参数必须归一化为 `JsonValue`，工具结果用 `toolCallId` 关联；不引入供应商专用字段，方言差异由适配器处理。 |
| P0-02 | 声明、压缩、中止控制消息的载荷编码 | 控制消息的 `content` 恰好一个 `text` 块，块内为规范 JSON：`declaration` 为 `{"toggle":string[]}`；`compaction` 为 `{"from":string,"to":string,"summary":string}`；`cancel` 为 `{"turnId":string,"reason":string,"at":string}`。`role` 决定解析哪个 schema；`toggle` 内 id 不得重复 | 保持 `ContentBlock` 四形态，不新增控制专用 block；JSON 可直接持久化、导出和审阅。`declaration.toggle` 是“状态变更记为 1”的直接编码，避免 add/remove 与异或语义冲突；重复 id 会让异或结果失真，必须在入队时拒绝。已同步 HLD §7.1、§5.2。 |
| P0-03 | `SelectionState` 的线上形状与队列叠加规则 | `selection` 为已启用条目 id 的 `string[]`，去重、按字典序排序；`session.read` 与 `entries.snapshot` 的 `selection` 只反映已持久化记录，临时会话为空数组；待装配队列的声明 `toggle` 由客户端叠加，`Context` 仅在装配时应用并持久化 | HLD 明确临时会话 `selection` 全 false、客户端自行从队列计算。服务端若把队列算进 `selection`，会与 `session.read` 的“记录视图”语义冲突，也会让客户端重复计算。 |
| P0-04 | 队列条目的物化粒度与更新边界 | 先入队已定；本项只定粒度。`session.create.systemPrompt` 生成一条 `kind=agent, role=system` 的队列条目；`session.create.extensions` 与默认扩展选择生成一条 `role=declaration`、`toggle` 为所选 id 的控制条目，所选为空则不生成。`session.configure.systemPrompt` 优先更新最近一条尚未装配的 system 队列条目，没有则新入队；一旦已装配，只追加新条目，绝不改写历史节点。`session.configure` 不接受扩展选择，扩展变更走声明类控制消息 | 系统提示词和扩展选择只以队列条目表达，不写入 meta、不保存快照。`session.configure` 的更新必须区分“尚未装配”和“已装配”，否则会破坏只追加记录和用户已确认内容不可变的原则。 |
| P0-05 | `session.create.extensions` 的类型与默认选择优先级 | `extensions?: string[]` 为显式启用条目 id 列表：省略表示使用配置默认值，空数组表示不启用，显式列表替换默认值而非追加。配置优先级为工作区配置 > 软件配置目录 > 内置默认；CLI 的 `--enable` / `--disable` 在客户端解析为最终 id 列表后入队 | 避免协议同时承载 enable/disable 两套语义；模式匹配留在 CLI，协议只传确定的 id。扩展选择仍只以声明类控制消息表达。 |
| P0-06 | `session.configure` 修改 `model` / `provider` 后如何持久化 | 在 `SessionRepository` 增加 `updateMeta(sessionId, meta: SessionMeta): Promise<void>`，原子替换 `meta.json`；`id`、`workspace`、`createdAt`、`schemaVersion` 不变；`create` / `append` 仍不改写 meta。临时会话只改内存 meta；已落盘会话才调用 `updateMeta`。活跃 turn 在启动时已快照模型与供应商，下一次 turn 读取新 meta | HLD 允许 `session.configure` 修改会话设置，但原有 `SessionRepository` 只有 `create` / `append` / 读 / `list`，无法持久化 `model` / `provider`。已写入 HLD §6.5、§7.2、§6.1。 |
| P0-07 | `meta.json` 与 `events.jsonl` 的原子写入、fsync 与尾部损坏恢复 | `create`：写 `events.jsonl.tmp` 与 `meta.json.tmp`，fsync 后先 rename events、再 rename meta，最后 fsync 目录（POSIX；Windows 使用可用的 flush/rename 语义）。中途崩溃只会留下无 meta 的孤儿目录，启动时清理。`append`：一次批量写入完整行缓冲，写满后 fsync。读取时忽略末尾不完整行且不修改文件；下一次 `append` 前截断到最后一个完整换行；完整行 JSON 损坏则报 `storage.corrupt`，不返回部分结果 | HLD 将 fsync 与批量策略留给详细设计，同时要求 `create` / `append` 原子、失败不留半条记录。先 rename events 后 rename meta，保证 `session.list` 只看到完整会话；读取不写盘，避免只读查看产生副作用。 |
| P0-08 | `session.subscribe` 的连接级基数与幂等语义 | 一个连接可订阅多个会话；同一连接重复订阅同一会话幂等，只保留一个订阅；`session.unsubscribe` 移除该会话订阅，重复退订幂等；连接关闭清除该连接全部订阅。事件按 `sessionId` 路由，不中止 turn | HLD 的“按连接订阅一个会话”与“连接断开清除全部订阅”存在单复数歧义。多会话订阅符合多客户端/多会话界面，也不引入新的订阅方法。 |
| P0-09 | 协议传输的分帧方式 | 默认 Unix domain socket 上使用 NDJSON：一行一个 UTF-8 JSON 对象，请求、响应、事件共用同一连接；`id` 关联请求与响应；单帧上限 8 MiB，超限拒绝并关闭连接；`protocol.hello` 必须是连接上的第一个请求 | HLD 要求传输无关、分帧由适配器实现，但未定具体帧格式。NDJSON 最简单，便于 CLI 与调试；长度前缀会增加实现与抓包成本。 |
| P0-10 | `entries.snapshot` 的可选条目范围与 `EntryInfo` 形状 | `entries.snapshot` 返回 `{entries: EntryInfo[], selection: string[]}`；`EntryInfo = {id,type:"tool"\|"skill"\|"context",source,name,description?}`；工具、技能、上下文来源均可选；`wrappers`、`providers`、`clients` 不是可选条目，不进入 `entries` | HLD 只写了 `entries` 与 `selection`，未定义条目形状。工具、技能、上下文来源都需要用户显式启用；包装器、供应商、客户端按各自规则生效，不参与选择。已同步 HLD §7.1、§5.2、§6.4。 |

以上决策中，P0-04、P0-05 只确定“队列条目的具体形态”，不改变 HLD 的“先入队”原则；P0-02、P0-06、P0-10 对应的 HLD 改动已写入第 4 节。

## 4 HLD 改动记录

以下改动已写入 HLD，待确认：

| 位置 | 改动 |
|---|---|
| §6.5 `SessionRepository` | 增加 `updateMeta`，用于 `session.configure` 持久化 `model` / `provider` |
| §7.2 存储布局 | 补充 `updateMeta` 的原子替换与并发约束 |
| §7.1 `declaration` | 改为记录工具、技能、上下文来源等可选条目的状态翻转 delta |
| §5.2 选择段 | 把选择变更表述为声明类控制消息，并把上下文来源纳入可选条目 |
| §6.4 上下文来源 | 补充 `entries.snapshot` 的 `selection` 与声明类控制消息记录 |
| §6.1 `session.configure` | 明确 `model` / `provider` 写 meta，`systemPrompt` 只入队，`extensions` 不在该方法中 |

以上改动已完成，待确认后进入详细设计正文。

## 5 延后到 P1/P2 的事项

以下事项不阻塞 P0，但正文必须给出结论：

- `session.create` 的 `workspace`、`provider`、`model` 默认值解析与错误码；
- 完整错误码表与协议错误映射；
- `turn.started` / `turn.step` / `turn.ended` / `session.updated` 等事件载荷；
- turn/step 状态机、工具并行度、steer 的具体装配点；
- 上下文裁剪阈值、token 估算、压缩摘要的确定性生成算法；
- 扩展清单发现、配置合并、宿主包映射与加载器细节；
- `session.list` 排序、id 生成算法、日志与导出格式；
- 客户端启动环境变量与 CLI 输出格式。

## 6 签核

- [ ] P0-01 至 P0-05、P0-07 至 P0-10 确认；
- [ ] HLD 改动（§5.2、§6.1、§6.4、§6.5、§7.1、§7.2）确认；
- [ ] 确认“已定基线”无遗漏或误读；
- [ ] 确认后才开始详细设计正文。

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
9. 队列不持久化；daemon 崩溃时消息队列随之丢失，不做 WAL 或恢复。
10. 退订不等于中止；连接断开清除该连接订阅，但不终止活跃 turn。

## 3 P0 决策

| ID | 决策点 | 结论 | 理由与影响 |
|---|---|---|---|
| P0-01 | `ContentBlock` 与 `Message` 的精确形状 | `ContentBlock = {type:"text",text} \| {type:"reasoning",text} \| {type:"toolCall",id,name,arguments:JsonValue} \| {type:"toolResult",toolCallId,content:ContentBlock[],isError?,code?,synthetic?}`；`Message = {role:"system"\|"user"\|"assistant"\|"tool", content:ContentBlock[]}`；`ToolCall.name` 记录层为 `EntryName`，`WireToolCall.name` 仅 adapter 边界 | 保持供应商无关记录；wireName 不进入会话树；恢复合成结果用 `synthetic="interrupted"` 标记，避免把中断误报为工具失败 |
| P0-02 | 声明、压缩、中止控制消息的载荷编码 | 控制消息的 `content` 恰好一个 `text` 块：`declaration` 为 `{toggle: EntryName[], definitions?: DefinitionSnapshot[]}`；`compaction` 为 `{from,to,summary}`；`cancel` 为 `{turnId,reason,at}`。definition 由 daemon 附加，客户端不能内联 | 选择增量与声明正文分离；definition 只在选中/更新时携带，支持既有会话复现；压缩/中止只由运行框架写入 |
| P0-03 | `SelectionState` 的线上形状与队列叠加规则 | `selection` 为已启用条目名称的 `string[]`，去重、按字典序排序；`session.read` 与 `entries.snapshot` 的 `selection` 只反映已持久化记录，临时会话为空数组；待装配队列的声明 `toggle` 由客户端叠加，`Context` 仅在装配时应用并持久化 | HLD 明确临时会话 `selection` 全 false、客户端自行从队列计算。选择以名称为准，不使用动态分配的 id |
| P0-04 | 队列条目的物化粒度与更新边界 | `session.create.systemPrompt` 生成 `kind=agent, role=system` 队列条目；`extensions` 生成 `role=declaration` 条目，所选为空不生成。`session.configure.systemPrompt` 用于在消息队列中新增或更新已有的`kind=agent, role=system, source="instruction"` 消息；所有消息离开消息队列进入会话记录后不可编辑 | 系统提示词和扩展选择只以队列条目表达，不写 meta、不保存快照 |
| P0-05 | `session.create.extensions` 类型与默认选择 | `extensions?: EntryName[]`：省略用配置默认，空数组不启用，显式列表替换默认；工作区配置 > 软件配置 > 内置默认；CLI `--enable/--disable` 解析为最终名称后入队 | 协议只传确定名称；模式匹配留在 CLI |
| P0-06 | `session.configure` 修改 `model`/`provider` | `SessionRepository.updateMeta` 原子替换 meta；`id/workspace/createdAt/schemaVersion` 不变；临时会话只改内存；下一步 turn 使用新 meta | 原接口无法持久化；HLD §6.5/§7.2/§6.1 已同步 |
| P0-07 | `meta.json`、`events.jsonl` 的批量原子与恢复 | 增加 `events.commit` 侧车保存已提交偏移；`append` 前 truncate 到 commit，写批后 fsync，再原子更新 commit；读取只看 commit 之前；create 按 events→commit→meta rename，无 meta/commit 均为孤儿 | 裸 JSONL append 不能保证整批原子；侧车把“崩溃只丢整批”变成可实现约束 |
| P0-08 | `session.subscribe` 的连接级基数与幂等语义 | 一个连接可订阅多个会话；同一连接重复订阅同一会话幂等，只保留一个订阅；`session.unsubscribe` 移除该会话订阅，重复退订幂等；连接关闭清除该连接全部订阅。事件按 `sessionId` 路由，不中止 turn | 多会话订阅符合多客户端/多会话界面；客户端先订阅再 read |
| P0-09 | 协议分帧与内容上限 | NDJSON；`MAX_ENTRY_BYTES=256KiB`、`MAX_NODE_CONTENT_BYTES=256KiB`、`MAX_QUEUE_BYTES=1MiB`、`MAX_RESPONSE_BYTES=MAX_EVENT_BYTES=4MiB`、`MAX_FRAME_BYTES=8MiB`；队列超限拒绝，`session.updated` 按事件预算拆分 | 保证 queue.updated/响应/批事件不因上限断连；单节点截断规则见详细设计 |
| P0-10 | `entries.snapshot` 的条目与 effective 形状 | `entries.snapshot` 返回 `{entries: EntryInfo[], effective: EffectiveEntry[]}`；`EntryInfo` 含 `package#name`、definition/definitionHash；`effective` 含会话已固化名称、configHash、stale；`providers/clients` 不进入 | 确认前需看到声明正文；当前清点与会话已固化定义分离 |
| P0-11 | 确认状态与队列编辑/清空 | `QueueEntry.confirmedAt` 由 turn.start 服务端写入；装配只消费已确认前缀；未确认可 edit/remove，已确认可 remove/clear 但不可 edit；turn.cancel 清除未装配确认；结束条件为“无可装配已确认条目” | 实现“确认后才发送”；避免 steer 绕过 |
| P0-12 | 工具身份三层 | `EntryName=package#name` 用于选择/记录；`wireName` 由 adapter 确定性编码，仅 WireRequest/parseChunk；记录中 `ToolCall.name` 始终 EntryName；编码碰撞拒绝 | 解决 provider 函数名字符集限制，且保持记录稳定 |
| P0-13 | compaction 与 cancel 的写入者 | compaction 仅 Context 自动生成，cancel 仅 driver 写入；queue.enqueue 拒绝二者；压缩范围只引用已持久化节点 | 防止客户端伪造摘要/中止标记 |
| P0-14 | 来源/技能节点身份 | `SessionNode.source` 取条目名（`package#name`）；过滤/去重按 `source`；`SessionNode` 不携带 `entry`；零片段来源每 step 重试 | 解决 source 多义与过滤失配 |

以上决策中，P0-04、P0-05 只确定“队列条目的具体形态”，不改变 HLD 的“先入队”原则；P0-02、P0-06、P0-10 对应的 HLD 改动已写入第 4 节。

## 4 HLD 改动记录

以下改动已写入 HLD：

| 位置 | 改动 |
|---|---|
| §6.5 `SessionRepository` | 增加 `updateMeta`，用于 `session.configure` 持久化 `model` / `provider` |
| §7.2 存储布局 | 补充 `updateMeta` 的原子替换与并发约束 |
| §7.1 `declaration` | 改为记录工具、包装器、技能、上下文来源等可选条目的状态翻转 delta，并以名称为选择标识 |
| §5.2 选择段 | 把选择变更表述为声明类控制消息，并把包装器、上下文来源纳入可选条目 |
| §5.1、§5.4 工具流水线 | 明确只有被选中的包装器进入工具流水线，未选中的不执行 |
| §6.4 上下文来源 | 补充 `entries.snapshot` 的 `selection` 与声明类控制消息记录 |
| §6.1 `session.configure` | 明确 `model` / `provider` 写 meta，`systemPrompt` 只更新或新增 system 队列条目，`extensions` 不在该方法中 |

以上改动已完成。

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

- [x] P0-01 至 P0-05、P0-07 至 P0-10 确认；
- [x] HLD 改动（§5.1、§5.2、§5.4、§6.1、§6.4、§6.5、§7.1、§7.2）确认；
- [x] 确认“已定基线”无遗漏或误读；
- [x] 确认后才开始详细设计正文。

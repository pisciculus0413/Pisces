# 详细设计

## 1 范围与约定

### 1.1 范围

本文档把 HLD 中未定义的公共类型、协议形状、状态机、持久化格式与算法落实到可实现程度。

本批次只覆盖：

- 第 2 章公共类型；
- 第 3 章协议层。

核心层与服务层的模块细节、端到端流程、CLI 与错误恢复在后续批次编写。

### 1.2 与 HLD 的关系

HLD 是架构与语义的唯一来源；本文档只补充 HLD 明确留给详细设计的内容。

- 本文档不新增模块，不改变 HLD 的分层与依赖方向。
- 本文档与 HLD 冲突时以 HLD 为准。
- P0 决策表用于固定公共类型与协议形状；本文档执行 P0 的结论，不重新讨论已定项。

### 1.3 命名与格式约定

- 协议 JSON 使用 camelCase。
- 时间戳为 RFC 3339 UTC 字符串，精确到毫秒，例如 `2026-11-06T13:00:00.000Z`。
- 未出现的可选字段表示未设置；不使用 `null` 表示“未设置”。
- id 是运行时分配的字符串，不能作为跨会话的稳定标识。
- 条目名称是稳定、可复现的选择标识；`selection`、声明类控制消息和 `session.create.extensions` 均使用名称，不使用 id。
- 所有持久化记录都带 `schemaVersion`；当前版本为 `1`。
- 控制消息的 `content` 恰好包含一个 `text` 块，文本内容是 JSON 对象；控制消息不直接写入请求体。

### 1.4 HLD 追溯

| 本文档 | HLD |
|---|---|
| 2 公共类型 | §1.6、§5.2、§6.1、§6.3、§6.4、§6.5、§7.1 |
| 3 协议层 | §3.4、§5.2、§6.1、§6.7、§6.8、§6.9、§8.6 |
| 后续核心层章节 | §4.1、§5.1、§6.2、§6.3、§6.4 |
| 后续服务层章节 | §4.2、§5.4、§5.5、§6.6、§8 |

## 2 公共类型

### 2.1 基础类型

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Brand<T extends string> = string & { readonly __brand: T };

type SessionId = Brand<"SessionId">;
type NodeId = Brand<"NodeId">;
type TurnId = Brand<"TurnId">;
type QueueEntryId = Brand<"QueueEntryId">;
type RequestId = Brand<"RequestId">;
type ProjectId = Brand<"ProjectId">;
type ClientId = Brand<"ClientId">;
type EntryName = Brand<"EntryName">;
```

- `SessionId` 由服务层生成；`NodeId`、`TurnId`、`QueueEntryId` 由核心层生成；`RequestId` 由客户端生成。
- `EntryName` 是条目名称的字符串类型；JSON 序列化后仍是普通字符串。
- `schemaVersion` 使用数字，当前固定为 `1`。

### 2.2 内容与消息

```ts
interface ToolCall {
  id: string;              // 本次工具调用的 id，由供应商或适配器产生
  name: string;            // 工具名称，不是条目 id
  arguments: JsonValue;    // 已解析的工具参数
}

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | ({ type: "toolCall" } & ToolCall)
  | { type: "toolResult"; toolCallId: string; content: ContentBlock[]; isError?: boolean };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

type StopReason = "stop" | "toolCall" | "length" | "contentFilter" | "error";
```

- `ToolCall.id` 与 `SessionNode.id`、条目 id 无关；它只用于把工具结果关联回调用。
- `toolCall.arguments` 统一为已解析的 `JsonValue`；方言驱动负责把供应商返回的参数字符串解析为该值。
- `toolResult.toolCallId` 必须对应同一次工具调用的 `ToolCall.id`。
- `reasoning` 只保存文本；供应商专用签名或加密内容不进入通用类型。
- `Message` 不带 `sessionId`、`nodeId`；这些是会话记录层字段。

### 2.3 控制消息载荷

控制消息的 `role` 决定载荷 schema。载荷放在一个 `text` 块中：

```ts
interface DeclarationPayload {
  toggle: EntryName[];
}

interface CompactionPayload {
  from: NodeId;
  to: NodeId;
  summary: string;
}

interface CancelPayload {
  turnId: TurnId;
  reason: string;
  at: NodeId;
}

type ControlPayload = DeclarationPayload | CompactionPayload | CancelPayload;
```

控制消息的文本块直接序列化对应的 payload 对象，不额外包裹 `role`/`payload` 字段；`role` 已由 `SessionNode.role` 或 `QueueEntry.role` 表示。

约束：

- `declaration.toggle` 中名称不得重复；每个名称出现一次表示状态翻转一次，选择按异或计算。
- `declaration` 只表达选择状态，不表达包装器或条目的顺序。
- `compaction.from`、`compaction.to` 是同一活动分支中的节点 id，范围包含两端；`summary` 是确定性摘要，不通过额外模型调用生成。
- `cancel.at` 是中止发生时最后写入的节点 id；`reason` 用于用户展示与审计。
- 控制消息的 `content` 不得为空，且不得包含多个块；解析失败按 `storage.corrupt` 处理。
- 控制消息不直接写入请求体。

### 2.4 会话记录与队列

```ts
interface SessionMeta {
  id: SessionId;
  model: string;
  provider: string;
  workspace: string;
  createdAt: string;
  schemaVersion: number;
}

interface SessionNode {
  id: NodeId;
  parentId: NodeId;        // 根节点指向自身
  kind: "agent" | "control";
  role: "system" | "user" | "assistant" | "tool" | "declaration" | "compaction" | "cancel";
  content: ContentBlock[];
  source: string;
  createdAt: string;
  schemaVersion: number;
}

interface QueueEntry {
  id: QueueEntryId;        // 仅在队列阶段有效
  kind: "agent" | "control";
  role: SessionNode["role"];
  content: ContentBlock[];
  source: string;
  createdAt: string;
}

type QueueEntryInput = Omit<QueueEntry, "id" | "createdAt">;
type SelectionState = EntryName[];
```

- `SessionMeta` 不包含活动分支、`status`、`systemPrompt`、扩展选择或运行状态。
- `SessionNode` 只追加，不删除；每个节点都有父指针；根节点的 `parentId` 等于自身。
- `kind` 与 `role` 必须匹配：
  - `agent`：`system`、`user`、`assistant`、`tool`；
  - `control`：`declaration`、`compaction`、`cancel`。
- `QueueEntry.id` 由 `Context` 在入队时分配，出队后作废；不写入 `SessionNode`。
- `QueueEntry` 不包含 `parentId`、`schemaVersion`；入队时不能由客户端指定 `id`、`createdAt`。
- `SelectionState` 是已启用条目名称的集合表示，去重后按字典序排列；不使用动态 id。
- 条目名称在 `entries.snapshot` 范围内必须唯一；重名条目由扩展清点阶段标记为不可用，不能参与选择。

### 2.5 条目与协议公共类型

```ts
interface EntryInfo {
  type: "tool" | "wrapper" | "skill" | "context";
  source: string;
  name: EntryName;
  description?: string;
}
```

- `tool`、`wrapper`、`skill`、`context` 是可选择条目。
- `providers`、`clients` 不进入 `entries`，不参与选择。
- `EntryInfo` 不含 id；客户端以 `name` 作为选择键。
- `name` 采用 `package#name` 的格式。

```ts
interface ModelInfo {
  id: string;              // provider 作用域内唯一
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
  pricing?: { input: number; output: number; currency: string };
}

interface ProviderInfo {
  id: string;
  ready: boolean;
  models: ModelInfo[];
}

interface ActiveTurn {
  sessionId: SessionId;
  turnId: TurnId;
  startedAt: string;
}

interface TemplateInfo {
  id: string;
  name: string;
  description?: string;
}

interface TemplatePreview {
  directories: string[];
  files: { path: string; content: string }[];
  initScript?: { command: string; args: string[] };
}

interface ProjectRef {
  id: ProjectId;
  templateId: string;
  workspace: string;
  createdAt: string;
}

interface ClientRegistration {
  id: ClientId;
  source: string;
  entry: string;
}
```

- `ProviderInfo.ready` 表示凭据有效且至少有一个模型；具体原因由 CLI `providers check` 提供。
- `ModelInfo.id` 只在所属 provider 内唯一；选择单位是 `(provider, model)`。
- `TemplateInfo` 只包含列表展示所需字段；完整模板由 `template.preview` 解析。

### 2.6 协议信封

```ts
interface Request<P = JsonValue> {
  id: RequestId;
  method: string;
  params: P;
}

interface Response<R = JsonValue> {
  id: RequestId;
  result?: R;
  error?: ProtocolError;
}

interface ProtocolError {
  code: string;
  message: string;
  data?: JsonValue;
}

interface Event<E = JsonValue> {
  event: string;
  data: E;
}
```

- 每个 `Response` 恰好包含 `result` 或 `error` 之一。
- `Request.id` 在同一条连接内由客户端保证唯一；服务端按原样回传。
- 事件不带 `id`；事件按连接推送。
- 错误消息不得包含凭据、请求头或供应商密钥。

## 3 协议层

### 3.1 传输与分帧

- 默认传输为 Unix domain socket；Windows 使用命名管道。
- 使用 NDJSON：一条 UTF-8 JSON 对象占一行，以 `\n` 结束；请求、响应和事件共用同一连接。
- 单帧上限为 8 MiB；超限时关闭连接，并尽可能发送 `protocol.frame_too_large` 错误。
- 不支持在 JSON 对象内嵌裸换行；字符串内的换行必须转义。
- 客户端可以在同一连接上并发发送多个请求；响应通过 `id` 关联。
- 事件可以与响应交错；客户端不得依赖事件与某个响应的固定先后顺序。
- 连接建立后，`protocol.hello` 必须是第一个请求；在此之前收到其他请求返回 `protocol.hello_required`。

### 3.2 握手与版本

```ts
interface HelloParams {
  versions: string[];
}

interface HelloResult {
  version: string;
  compatible: boolean;
}
```

- 版本使用 `MAJOR.MINOR.PATCH`。
- 客户端在 `versions` 中列出自己支持的版本，按优先级从高到低排列。
- 服务端选择主版本相同、次版本不高于服务端、优先级最高的版本；没有可用版本时 `compatible` 为 `false`。
- 主版本不同或没有公共版本时，服务端发送 `protocol.incompatible` 事件，随后关闭连接。
- 成功后该连接固定使用协商出的版本；后续不再接受版本参数。
- 协议版本与软件包版本独立管理。

### 3.3 方法总览

| 方法 | 参数 | 结果 |
|---|---|---|
| `protocol.hello` | `HelloParams` | `HelloResult` |
| `session.create` | `CreateSessionParams` | `SessionMeta` |
| `session.list` | `{}` | `{ sessions: SessionMeta[] }` |
| `session.read` | `SessionReadParams` | `SessionReadResult` |
| `session.configure` | `ConfigureSessionParams` | `SessionMeta` |
| `session.subscribe` | `{ sessionId }` | `{ sessionId }` |
| `session.unsubscribe` | `{ sessionId }` | `{ sessionId }` |
| `turn.list` | `{}` | `{ turns: ActiveTurn[] }` |
| `turn.start` | `TurnStartParams` | `TurnStartResult` |
| `turn.cancel` | `{ turnId }` | `{ cancelled: boolean }` |
| `provider.list` | `{}` | `{ providers: ProviderInfo[] }` |
| `queue.enqueue` | `QueueEnqueueParams` | `{ ids: QueueEntryId[] }` |
| `queue.edit` | `{ sessionId, id, content }` | `{ id }` |
| `queue.remove` | `{ sessionId, id }` | `{ id }` |
| `queue.clear` | `{ sessionId }` | `{ ids: QueueEntryId[] }` |
| `entries.snapshot` | `{ sessionId }` | `{ entries: EntryInfo[]; selection: SelectionState }` |
| `template.list` | `{}` | `{ templates: TemplateInfo[] }` |
| `template.preview` | `{ templateId, workspace }` | `TemplatePreview` |
| `template.apply` | `{ templateId, workspace, confirmed: true }` | `{ projectId, sessionId }` |
| `client.list` | `{}` | `{ clients: ClientRegistration[] }` |
| `client.start` | `{ id }` | `{ pid: number }` |

### 3.4 会话方法

#### 3.4.1 `session.create`

```ts
interface CreateSessionParams {
  workspace?: string;
  templateId?: string;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  extensions?: EntryName[];
}
```

- 服务层创建临时 `SessionMeta`、`Context` 与空消息队列；不写盘，不进入 `session.list`。
- `systemPrompt` 生成一条 `kind=agent`、`role=system` 的队列条目；不写入 `SessionMeta`。
- `extensions` 是显式启用条目名称列表：
  - 省略：使用配置中的默认选择；
  - 空数组：不启用任何条目；
  - 显式列表：替换默认选择，不与默认值合并。
- `extensions` 生成一条 `kind=control`、`role=declaration` 的队列条目，`toggle` 为所选名称；所选为空时不生成。
- `workspace`、`model`、`provider` 省略时的默认值由服务层配置解析；未配置可用模型时返回 `session.model_required`。
- 若提供 `provider`/`model`，必须来自 `provider.list`，否则返回 `session.invalid_model`。
- `templateId` 只用于解析模板级初始配置；不创建目录、不写文件、不执行脚本。工作区初始化只能经 `template.preview`/`template.apply`。
- 返回临时 `SessionMeta`，客户端通过 `session.read` 取得队列。

#### 3.4.2 `session.list`

- 只返回已落盘会话的 `SessionMeta`。
- 临时会话不出现。
- 返回顺序不构成协议契约；客户端自行按 `createdAt` 排序。

#### 3.4.3 `session.read`

```ts
interface SessionReadParams {
  sessionId: SessionId;
  nodeId?: NodeId;
}

interface SessionReadResult {
  meta: SessionMeta;
  records: SessionNode[];
  queue: QueueEntry[];
  selection: SelectionState;
}
```

- 无 `nodeId`：`records` 为完整会话树，按追加顺序扁平返回；`selection` 按默认活动分支的声明类控制消息 delta 异或。
- 有 `nodeId`：`records` 为该节点到根的线性分支，按根到该节点排列；`selection` 按该分支异或。
- 临时会话没有节点：`records` 为空，`selection` 为空数组；带 `nodeId` 返回 `session.node_not_found`。
- `queue` 始终是当前消息队列；`selection` 只反映已持久化记录，不包含队列中的声明 delta。客户端自行叠加队列中的 `toggle`。
- `session.read` 不改变活动分支，不是 turn 启动。
- 读取在同一会话锁内完成，返回一致快照。

#### 3.4.4 `session.configure`

```ts
interface ConfigureSessionParams {
  sessionId: SessionId;
  model?: string;
  provider?: string;
  systemPrompt?: string;
}
```

- `model`/`provider` 必须成对校验；校验通过后通过 `SessionRepository.updateMeta` 写入已落盘会话的 `meta.json`。
- 临时会话只更新内存 `SessionMeta`；不调用持久化。
- 活跃 turn 使用启动时的模型与供应商快照；新设置在下一次 turn 生效。
- `systemPrompt` 只操作消息队列：
  - 已有 `role=system` 队列条目：更新该条目；
  - 没有：新增一条 `kind=agent`、`role=system` 的队列条目；
  - 不写 `SessionMeta`，不修改会话记录。
- `session.configure` 不接受扩展选择；扩展选择只能通过声明类控制消息改变。
- 返回更新后的 `SessionMeta`。
- 队列变化推送 `queue.updated`。

#### 3.4.5 `session.subscribe` / `session.unsubscribe`

```ts
interface SessionSubscribeParams {
  sessionId: SessionId;
}

interface SessionSubscribeResult {
  sessionId: SessionId;
}
```

- 一个连接可订阅多个会话；每次调用订阅一个会话。
- 同一连接重复订阅同一会话幂等，只保留一个订阅。
- 订阅成功后，该连接接收该会话的 `session.updated`、`queue.updated`、`selection.updated` 与 turn 事件。
- `session.unsubscribe` 只移除当前连接的该会话订阅，重复调用幂等，不发送事件。
- 连接断开自动清除该连接的全部订阅。
- 退订或断开连接不中止活跃 turn，不影响其他客户端。
- 订阅不重放历史事件；客户端应先 `session.read` 取得初始快照。

### 3.5 消息队列方法

```ts
interface QueueEnqueueParams {
  sessionId: SessionId;
  entries: QueueEntryInput[];
}

interface QueueEditParams {
  sessionId: SessionId;
  id: QueueEntryId;
  content: ContentBlock[];
}
```

- `queue.enqueue` 只入队，不确认，不写会话记录。
- 队列按入队顺序排列；不提供重排方法。
- `queue.edit` 只允许 `kind=agent` 的条目；控制消息不能编辑，只能整条删除后重新入队。
- `queue.remove` 可删除任意尚未出队的条目。
- `queue.clear` 清空当前队列，返回被清除的 id。
- 已被装配取走的条目不再接受 `edit`/`remove`。
- 控制消息入队时校验 `role` 与载荷：
  - `declaration`：`toggle` 为名称数组，名称去重；
  - `compaction`：`from`、`to` 为节点 id，`summary` 为字符串；
  - `cancel`：`turnId`、`reason`、`at` 完整。
- 每次队列变化后推送 `queue.updated`，载荷为当前完整 `QueueEntry[]`。
- 多客户端并发写由服务层按会话串行化，最后写入者获胜。

### 3.6 条目与 turn 方法

#### 3.6.1 `entries.snapshot`

- 返回当前可用的工具、包装器、技能、上下文来源，以及已持久化记录计算出的 `selection`。
- `selection` 不包含队列中尚未装配的声明 delta；客户端按队列叠加。
- 临时会话返回可用条目和空 `selection`。
- `providers`、`clients` 不进入结果。
- 条目名称必须唯一；重名条目不可选择。

#### 3.6.2 `turn.start`

```ts
interface TurnStartParams {
  sessionId: SessionId;
  nodeId?: NodeId;
}

interface TurnStartResult {
  turnId: TurnId;
  mode: "new" | "steer";
}
```

- 无活跃 turn：
  - 启动新 turn，`mode` 为 `new`；
  - `nodeId` 仅对已落盘会话有效，用于选择新 turn 的分支起点；
  - 省略 `nodeId` 时从节点记录最后一个节点继续；
  - 临时会话带 `nodeId` 返回 `session.node_not_found`；
  - 首次 turn 必须产生至少一个节点，否则报错且不落盘。
- 已有活跃 turn：
  - `turn.start` 只确认队列中新增条目，作为 steer 在下一个 step 边界装配；
  - 不启动第二个 turn，`mode` 为 `steer`；
  - 不得带 `nodeId`，否则返回 `turn.node_id_forbidden`；
  - 返回已有 turn 的 `turnId`。
- 并发 `turn.start` 由服务层按会话串行化；后到者按 steer 处理。

#### 3.6.3 `turn.list` / `turn.cancel`

- `turn.list` 返回当前活跃 turn 快照；会话是否在运行由成员资格表示。
- `turn.cancel` 按 `turnId` 中止当前供应商流：
  - 正在执行的工具不被强制终止；`ToolInvocationContext.signal` 置为中止；
  - 中止后不再发起新 step，当前工具结果回填后结束；
  - 已产生的回复与控制消息写入会话并标记中断；
  - 找不到活跃 turn 时返回 `{ cancelled: false }`。
- 连接断开或 `session.unsubscribe` 不触发中止。

### 3.7 供应商、模板与客户端方法

#### 3.7.1 `provider.list`

- 返回 `ProviderInfo[]`，只包含协议展示所需字段。
- 不返回 `dialect`、`baseUrl`、`auth`、`headers`。
- `ready` 由凭据状态计算；无模型时 `models` 为空。
- 模型选择单位是 `(provider, model)`。

#### 3.7.2 模板方法

- `template.list` 返回 `TemplateInfo[]`，不返回文件内容。
- `template.preview` 解析模板，返回将创建的目录、文件与可选的初始化脚本；无副作用。
- `template.apply` 必须带 `confirmed: true`；流程为：
  1. 校验模板与工作区；
  2. 服务层创建目录与文件；
  3. 执行 `initScript`（如有）；
  4. 记录 `ProjectRef`；
  5. 创建临时会话并返回 `{ projectId, sessionId }`。
- 模板的提示词仍按队列与确认流程进入会话，不直接写入请求体。
- 初始化脚本失败时返回 `template.init_failed`，不创建会话；已创建的文件由用户处置，不自动回滚。

#### 3.7.3 客户端方法

- `client.list` 返回已注册客户端，不返回进程状态。
- `client.start` 校验客户端 id，按注册信息启动进程，返回 pid。
- 启动时通过环境变量传入 daemon socket 路径与客户端 id。
- 客户端进程的 stdout/stderr 不进入协议流。

### 3.8 事件

```ts
interface SessionUpdatedEvent {
  sessionId: SessionId;
  nodes: SessionNode[];
}

interface TurnStartedEvent {
  sessionId: SessionId;
  turnId: TurnId;
  mode: "new" | "steer";
  startedAt: string;
}

interface TurnStepEvent {
  sessionId: SessionId;
  turnId: TurnId;
  step: number;
  stopReason: StopReason;
  usage?: Usage;
}

interface TurnEndedEvent {
  sessionId: SessionId;
  turnId: TurnId;
  reason: "completed" | "cancelled" | "failed";
  endedAt: string;
  error?: { code: string; message: string };
}

interface QueueUpdatedEvent {
  sessionId: SessionId;
  queue: QueueEntry[];
}

interface SelectionUpdatedEvent {
  sessionId: SessionId;
  selection: SelectionState;
}

interface ClientLaunchedEvent {
  clientId: ClientId;
  pid: number;
}

interface ProtocolIncompatibleEvent {
  supported: string;
  received: string[];
}

type ProtocolEvent =
  | Event<SessionUpdatedEvent> & { event: "session.updated" }
  | Event<TurnStartedEvent> & { event: "turn.started" }
  | Event<TurnStepEvent> & { event: "turn.step" }
  | Event<TurnEndedEvent> & { event: "turn.ended" }
  | Event<QueueUpdatedEvent> & { event: "queue.updated" }
  | Event<SelectionUpdatedEvent> & { event: "selection.updated" }
  | Event<ClientLaunchedEvent> & { event: "client.launched" }
  | Event<ProtocolIncompatibleEvent> & { event: "protocol.incompatible" };
```

事件规则：

- `session.updated` 只携带本次追加的节点；客户端按 `id`/`parentId` 合并。
- `queue.updated` 携带当前完整队列；客户端整体替换本地队列。
- `selection.updated` 携带已持久化记录的完整名称集合；队列声明 delta 通过 `queue.updated` 传递，客户端自行叠加。
- `turn.started`、`turn.step`、`turn.ended` 均带 `sessionId` 与 `turnId`；客户端按会话路由。
- `turn.step` 的 `step` 从 1 开始；`usage` 在供应商提供时出现。
- `turn.ended.reason` 为 `failed` 时带 `error`。
- `client.launched` 在客户端进程成功启动后推送。
- `protocol.incompatible` 在握手失败时推送，随后关闭连接。
- 事件只发送给订阅该会话的连接；`client.launched` 与 `protocol.incompatible` 是连接级事件，不受会话订阅限制。
- 事件不重放；重连后客户端重新 `session.read`。

### 3.9 错误码

| 类别 | 错误码 | 场景 |
|---|---|---|
| 协议 | `protocol.invalid_json` | 行不是合法 JSON |
| 协议 | `protocol.invalid_request` | 方法或参数不合法 |
| 协议 | `protocol.unknown_method` | 方法不存在 |
| 协议 | `protocol.hello_required` | 握手前发送其他请求 |
| 协议 | `protocol.version_mismatch` | 无兼容协议版本 |
| 协议 | `protocol.frame_too_large` | 单帧超过 8 MiB |
| 会话 | `session.not_found` | 会话不存在 |
| 会话 | `session.model_required` | 未提供且无默认模型 |
| 会话 | `session.invalid_model` | provider/model 不在清单中 |
| 会话 | `session.node_not_found` | `nodeId` 不属于该会话 |
| 队列 | `queue.entry_not_found` | 队列条目不存在 |
| 队列 | `queue.entry_locked` | 条目已出队，不能再编辑 |
| 队列 | `queue.invalid_control` | 控制消息载荷不合法 |
| 队列 | `queue.duplicate_name` | `toggle` 中名称重复 |
| turn | `turn.not_found` | 活跃 turn 不存在 |
| turn | `turn.node_id_forbidden` | 活跃 turn 的 `turn.start` 带 `nodeId` |
| 存储 | `storage.io` | 持久化 I/O 失败 |
| 存储 | `storage.corrupt` | 记录或 meta 损坏 |
| 供应商 | `provider.transport` | 网络/传输错误 |
| 供应商 | `provider.timeout` | 请求超时 |
| 供应商 | `provider.invalid_response` | 响应无法解析 |
| 供应商 | `provider.refusal` | 供应商拒绝 |
| 工具 | `tool.failed` | 工具执行失败 |
| 工具 | `tool.denied` | 工具拒绝执行 |
| 模板 | `template.not_found` | 模板不存在 |
| 模板 | `template.invalid` | 模板解析失败 |
| 模板 | `template.init_failed` | 初始化脚本失败 |
| 客户端 | `client.not_found` | 客户端未注册 |
| 客户端 | `client.launch_failed` | 客户端启动失败 |
| 配置 | `config.invalid` | 配置值不合法 |
| 配置 | `config.unknown_key` | 未知配置键 |

- 请求级错误通过 `Response.error` 返回。
- turn 进行中的供应商或工具错误通过 `turn.ended.error` 或工具结果回填，不伪造成请求错误。
- 错误消息不得包含凭据；需要附加结构化信息时使用 `data`。

### 3.10 校验、并发与一致性

- 所有方法先校验 `sessionId` 是否存在；临时会话与已落盘会话都允许读、订阅和队列操作。
- `session.create`、`session.configure`、`queue.*`、`turn.start` 按会话串行化；`session.read` 在同一会话锁内取快照。
- 多客户端同时编辑队列时按服务端处理顺序最后写入者获胜；客户端以 `queue.updated` 整体替换本地状态。
- `selection` 只由已持久化记录计算；客户端看到队列声明 delta 后自行叠加，不在协议层合并。
- 会话记录只追加；`session.updated` 只推送本次追加节点。
- 事件是状态通知，不是事务日志；断线重连必须重新 `session.read`。
- 单个请求/事件帧上限为 8 MiB；超过限制的连接关闭。
- 协议不提供全局配置、凭据和扩展安装写方法；这些只经 CLI。

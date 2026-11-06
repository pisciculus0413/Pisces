# 详细设计

## 1 范围与约定

### 1.1 范围

本文档把 HLD 中未定义的公共类型、协议形状、状态机、持久化格式与算法落实到可实现程度。

本批次覆盖：

- 第 2 章公共类型；
- 第 3 章协议层；
- 第 4 章核心层；
- 第 5 章服务层；
- 第 6 章端到端流程与恢复；
- 第 7 章 CLI 与数据迁移；
- 第 8 章非功能设计、错误与可测试性。

剩余待确认项在文末汇总。

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
- 条目名称采用 `package#name` 格式：`package` 是扩展包名，`name` 是包内条目名。包名构成命名空间；不同包可以同名，同一包内的 `name` 必须唯一。
- `selection`、声明类控制消息和 `session.create.extensions` 均使用 `package#name`，不使用 id。
- 所有持久化记录都带 `schemaVersion`；当前版本为 `1`。
- 控制消息的 `content` 恰好包含一个 `text` 块，文本内容是 JSON 对象；控制消息不直接写入请求体。

### 1.4 HLD 追溯

| 本文档 | HLD |
|---|---|
| 2 公共类型 | §1.6、§5.2、§6.1、§6.3、§6.4、§6.5、§7.1 |
| 3 协议层 | §3.4、§5.2、§6.1、§6.7、§6.8、§6.9、§8.6 |
| 4 核心层 | §4.1、§5.1、§5.2、§5.3、§6.2、§6.3、§6.4、§7.1 |
| 5 服务层 | §3.1、§3.2、§4.2、§5.4、§5.5、§6.6、§6.9、§7.2、§8.1 |
| 6 端到端流程 | §5.2、§5.3、§5.5、§5.6、§8.1、§8.4 |
| 7 CLI 与迁移 | §6.7、§6.8、§7.3、§8.6 |
| 8 非功能与质量 | §8.1、§8.2、§8.3、§8.4、§8.5、§8.6 |

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
type EntryName = Brand<"EntryName">; // package#name
```

- `SessionId` 由服务层生成；`NodeId`、`TurnId`、`QueueEntryId` 由核心层生成；`RequestId` 由客户端生成。
- `EntryName` 是 `package#name` 的字符串类型；JSON 序列化后仍是普通字符串。
- `schemaVersion` 使用数字，当前固定为 `1`。

### 2.2 内容与消息

```ts
interface ToolCall {
  id: string;              // 本次工具调用的 id，由供应商或适配器产生
  name: string;            // package#name，不是条目 id
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
- `SelectionState` 是已启用条目名称的集合表示，去重后按字典序排列；名称为 `package#name`，不使用动态 id。

### 2.5 条目与协议公共类型

```ts
interface EntryInfo {
  type: "tool" | "wrapper" | "skill" | "context";
  source: string;
  name: EntryName;         // package#name
  description?: string;
}
```

- `tool`、`wrapper`、`skill`、`context` 是可选择条目。
- `providers`、`clients` 不进入 `entries`，不参与选择。
- `EntryInfo` 不含 id；客户端以 `package#name` 作为选择键。`source` 记录来源包。

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
- `extensions` 是显式启用条目 `package#name` 列表：
  - 省略：使用配置中的默认选择；
  - 空数组：不启用任何条目；
  - 显式列表：替换默认选择，不与默认值合并。
- `extensions` 生成一条 `kind=control`、`role=declaration` 的队列条目，`toggle` 为所选名称；所选为空时不生成。
- `workspace` 显式提供时直接使用；省略时读取全局配置中的 `defaultWorkspace`。两者都没有返回 `session.workspace_required`；路径不存在、不是目录或不可写返回 `session.invalid_workspace`。默认工作区必须是绝对路径，不自动创建；不读取 daemon 工作目录。工作区配置 `.pisces/config.json` 不参与默认工作区解析。
- `provider`/`model` 只能成对出现：两者均省略时取配置中的 `defaultProvider`/`defaultModel`；只提供一个，或默认值不完整，返回 `session.model_required`；显式组合或默认组合不在 `provider.list` 中，返回 `session.invalid_model`。
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
- 活跃 turn 使用启动时的模型与供应商快照；仅携带 `model`/`provider` 的新设置在下一次 turn 生效。
- 若存在活跃 turn 且请求携带 `systemPrompt`，整个 `session.configure` 返回 `turn.active`，不更新 `model`/`provider`、队列或会话记录；不做部分更新。
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
- 条目名称采用 `package#name`，跨包同名不冲突。

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
| 会话 | `session.workspace_required` | 未提供且未配置默认工作区 |
| 会话 | `session.invalid_workspace` | 工作区不存在、不是目录或不可写 |
| 会话 | `session.node_not_found` | `nodeId` 不属于该会话 |
| 队列 | `queue.entry_not_found` | 队列条目不存在 |
| 队列 | `queue.entry_locked` | 条目已出队，不能再编辑 |
| 队列 | `queue.invalid_control` | 控制消息载荷不合法 |
| 队列 | `queue.duplicate_name` | `toggle` 中名称重复 |
| turn | `turn.not_found` | 活跃 turn 不存在 |
| turn | `turn.node_id_forbidden` | 活跃 turn 的 `turn.start` 带 `nodeId` |
| turn | `turn.active` | 活跃 turn 中修改 `systemPrompt` |
| turn | `turn.empty` | 首次 turn 未产生任何节点 |
| 上下文 | `context.source_failed` | 上下文来源解析失败 |
| 上下文 | `context.window_exceeded` | 裁剪后仍超出模型窗口 |
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

## 4 核心层

### 4.1 `Sessions`

`Sessions` 负责会话树的节点编号、父指针、批量写入与分支读取；它不创建 `SessionMeta`，不持有运行状态。

```ts
interface SessionRepository {
  create(meta: SessionMeta, nodes: SessionNode[]): Promise<void>;
  append(sessionId: SessionId, nodes: SessionNode[]): Promise<void>;
  readBranch(sessionId: SessionId, nodeId?: NodeId): AsyncIterable<SessionNode>;
  readTree(sessionId: SessionId): AsyncIterable<SessionNode>;
  list(): Promise<SessionMeta[]>;
  updateMeta(sessionId: SessionId, meta: SessionMeta): Promise<void>;
}

type SessionNodeDraft = Omit<
  SessionNode,
  "id" | "parentId" | "createdAt" | "schemaVersion"
>;

interface SessionsDeps {
  repository: SessionRepository;
  newId: () => NodeId;
  now: () => string;
}

interface Sessions {
  create(meta: SessionMeta, drafts: SessionNodeDraft[]): Promise<SessionNode[]>;
  append(sessionId: SessionId, drafts: SessionNodeDraft[], parentId?: NodeId): Promise<SessionNode[]>;
  readBranch(sessionId: SessionId, nodeId?: NodeId): AsyncIterable<SessionNode>;
  readTree(sessionId: SessionId): AsyncIterable<SessionNode>;
  list(): Promise<SessionMeta[]>;
  updateMeta(sessionId: SessionId, meta: SessionMeta): Promise<void>;
}
```

#### 4.1.1 节点编号与父指针

- `create` 要求 `drafts` 非空；第一个节点为根节点，`parentId` 等于自身；之后每个节点的父节点是前一个节点。
- `append` 要求 `drafts` 非空；第一个节点的父节点为 `parentId`；省略 `parentId` 时取该会话节点记录的最后一个节点，之后每个节点的父节点是前一个节点。
- `append` 只适用于已有节点的会话；没有节点时使用 `create`。
- 每个节点写入时分配新的 `id`；`createdAt` 取 `now()`；`schemaVersion` 固定为当前版本。
- `Sessions` 不修改已写入节点的 `id`、`parentId`、`createdAt` 或内容。
- `append` 的 `parentId` 必须属于该会话；不存在时返回 `session.node_not_found`。
- 根节点之后的所有节点构成一条从父到子的链；分支由后续 `append` 的 `parentId` 选择。

#### 4.1.2 写入与读取

- `create` 只调用 `SessionRepository.create(meta, nodes)`；不预先写 meta，不写入空会话。
- `append` 只调用 `SessionRepository.append(sessionId, nodes)`；节点已在内存中完成编号与父指针分配。
- 写入失败时，`Sessions` 不返回部分节点；由 `SessionRepository` 保证批量原子性。
- `readBranch` 直接转发 `SessionRepository.readBranch`；省略 `nodeId` 时以记录最后一个节点为分支末端。
- `readTree` 返回全部节点，按追加顺序。
- `list` 只返回已落盘会话的 `SessionMeta`。
- `updateMeta` 只允许更新已落盘会话的 `model`、`provider`；临时会话由服务层直接改内存 meta，不调用该接口。

#### 4.1.3 不变量

- 会话树只追加，不删除、不改写。
- `SessionMeta` 不保存当前分支；当前分支始终由指定节点或记录最后一个节点导出。
- 队列条目的临时 id 不进入 `SessionNode`。
- `create`/`append` 的节点批次非空；失败不留半批节点。

### 4.2 `Context`

`Context` 负责消息队列、声明选择、上下文来源、技能内容、上下文装配、裁剪与压缩控制，以及首次落盘/后续追加的持久化边界。

#### 4.2.1 组成与状态

```ts
interface ContextDeps {
  sessionId: SessionId;
  meta: SessionMeta;
  persisted: boolean;
  sessions: Sessions;
  tools: Tools;
  skills: Skills;
  sources: ContextSourceRegistry;
  newId: () => QueueEntryId;
  now: () => string;
}

interface ContextSnapshot {
  queue: QueueEntry[];
  selection: SelectionState;
}

interface AssembleOptions {
  nodeId?: NodeId;
  contextWindow: number;
  maxOutput: number;
  signal?: AbortSignal;
}

interface AssembledContext {
  request: LlmRequest;
  selection: SelectionState;
  nodes: SessionNode[];
  first: boolean;
}

interface LlmRequest {
  model: string;
  messages: Message[];
  tools?: ToolDeclaration[];
  parameters?: JsonObject;
}

interface Context {
  initialize(): Promise<void>;
  snapshot(): ContextSnapshot;
  selectionFor(nodeId?: NodeId): Promise<SelectionState>;
  enqueue(entries: QueueEntryInput[]): QueueEntryId[];
  edit(id: QueueEntryId, content: ContentBlock[]): void;
  remove(id: QueueEntryId): void;
  clear(): QueueEntryId[];
  assemble(options: AssembleOptions): Promise<AssembledContext>;
}
```

`Context` 创建后由服务层调用 `initialize`：读取默认分支并计算已持久化的选择；临时会话不读取记录，选择为空。`snapshot` 返回当前队列与选择；`selectionFor` 按指定节点或默认分支计算，不改变缓存；`assemble` 可重复调用，内部保证已初始化。

`Context` 的可变状态只有：

- `queue`：尚未出队的 `QueueEntry[]`；
- `persisted`：是否已有至少一个已写入节点；
- `selection`：已持久化记录的声明选择缓存；
- `meta`：当前会话元数据。

不保存“活动分支”“已装配标记”或完整选择快照。

#### 4.2.2 队列操作

- `enqueue` 为每个输入分配 `QueueEntryId` 与 `createdAt`，按输入顺序追加到队尾。
- `queue` 只存在内存；`Context` 不持久化队列，也不做 WAL。
- `edit` 只允许 `kind=agent` 的条目；控制消息不可编辑。
- `remove` 可删除任意尚未出队的条目；`clear` 清空队列并返回被删除的 id。
- 队列操作按会话串行化；每次变化后发布 `queue.updated`。
- 队列条目的 id 只在队列阶段有效；装配出队后作废。

#### 4.2.3 选择与声明

- 基础选择由活动分支中的声明类控制消息按异或计算。
- 队列中的声明类控制消息按队列顺序异或到基础选择上，得到本次装配的选择。
- `selection` 是 `package#name` 的集合，不使用动态 id；排序后作为稳定输出。
- 队列中的 declaration 被装配为 `SessionNode` 后，其 `toggle` 才进入已持久化记录；出队后选择缓存更新。
- `Context.snapshot().selection` 只返回已持久化记录的选择；客户端自行叠加队列中的 `toggle`。
- `selectionFor(nodeId?)` 按指定分支或默认分支计算选择，供 `session.read` 使用；不改变缓存与活动分支。
- 包装器、工具、技能、上下文来源均通过同一选择集表达启用状态；包装器的执行顺序不入选择状态。
- 技能和上下文来源的智能体消息只承载内容，不参与选择计算；内容节点存在不等于条目被选中。

#### 4.2.4 装配流程

`assemble` 按以下顺序执行：

1. 确定分支起点：`nodeId` 指定时使用该节点；否则使用记录最后一个节点。临时会话没有节点，指定 `nodeId` 返回 `session.node_not_found`。
2. 读取分支节点（临时会话为空）；计算分支的选择。
3. 将队列中的声明类控制消息异或到选择上。
4. 把队列条目按队列顺序转成 `SessionNodeDraft`；控制消息的内容保持为单个 `text` 块 JSON。
5. 对选择中尚未出现在分支里的上下文来源，按名称升序调用 `resolve`；每个 `ContextFragment` 追加为 `kind=agent`、`role=system` 的节点，`source` 使用片段的 `source`。已存在的复用，未选中的不解析、不追加。
6. 对选择中尚未出现在分支里的技能，按名称升序追加为 `kind=agent`、`role=system` 的节点，`source` 使用技能来源。已存在的复用，未选中的不追加。
7. 把分支节点、队列节点、来源节点和技能节点按顺序组成节点序列；来源/技能节点只在其 `source` 位于当前选择集时进入序列，普通 system 节点不受此过滤；未选中的内容节点保留在记录中，但不进入消息序列。控制消息参与选择、压缩或中止处理，不直接进入消息序列。
8. 对节点序列应用压缩控制：按 `from`/`to` 跳过范围，使用 `summary` 生成一条 `system` 消息；重叠或越界范围按 `storage.corrupt` 处理。
9. 将剩余节点转换为 `Message[]`；`system`/`user`/`assistant`/`tool` 直接进入消息序列，`declaration`/`compaction`/`cancel` 不进入。
10. 按窗口预算裁剪消息序列；裁剪不新增节点。
11. 构造 `LlmRequest`：`model` 取 `meta.model`，`messages` 为可见消息，`tools` 为 `Tools.selected(selection)`，不包含 `execute`。
12. 首次持久化使用 `Sessions.create(meta, drafts)`；已有节点时使用 `Sessions.append(sessionId, drafts, parentId)`。`drafts` 为空时跳过 append。
13. 持久化成功后，从队列移除本次已装配的条目，更新 `selection`，将 `persisted` 置为 `true`；失败时队列保留。
14. 返回 `LlmRequest`、选择、写入节点与 `first` 标记。

`parentId` 的取值：

- 有 `nodeId` 时为该节点；
- 否则为分支最后一个节点；
- 首次创建由 `Sessions.create` 生成根节点。

首次 turn 若没有产生任何节点（队列为空且没有来源/技能节点），返回 `turn.empty`，不调用 `Sessions.create`，队列保留。

#### 4.2.5 上下文来源与技能

```ts
interface ContextSourceContext {
  sessionId: SessionId;
  workspace: string;
  signal?: AbortSignal;
}

interface ContextSource {
  id: string;              // package#name，扩展条目的稳定名称
  resolve(context: ContextSourceContext): Promise<ContextFragment[]>;
}

interface ContextFragment {
  source: string;
  content: ContentBlock[];
}

interface ContextSourceRegistry {
  get(name: EntryName): ContextSource | undefined;
}

interface SkillEntry {
  name: EntryName;         // package#name
  source: string;
  content: ContentBlock[];
}

interface Skills {
  selected(selection: SelectionState): SkillEntry[];
}
```

- 上下文来源按名称升序解析；同一分支中已经存在相同 `source` 的节点时不再调用，避免每个 step 重复追加。
- 来源返回多个片段时按返回顺序追加；每个片段独立成节点。
- 来源解析失败返回 `context.source_failed`，本次装配失败，队列与已读节点不受影响。
- 技能内容按名称升序追加；同一分支中同一技能只追加一次。
- 技能和来源写入的节点都是 `role=system` 的智能体消息，`source` 保留来源标识。
- 来源/技能节点是内容，不是选择状态；每个 `package#name` 在分支中最多追加一次。
- 取消选择不删除已有节点，只从本次消息序列中排除；再次选择时复用已有节点，不重新解析、不重复追加。
- 普通 system 提示词节点不参与该过滤；来源/技能节点的 `source` 必须使用 `package#name`。

#### 4.2.6 裁剪与压缩

- 窗口取 `AssembleOptions.contextWindow`，预算为 `max(1024, contextWindow - maxOutput)`。
- token 估算使用 UTF-8 字节数除以 3 向上取整；这是通用估算，不依赖供应商 tokenizer。
- 裁剪按消息组进行：一条 assistant 工具调用消息与其对应的 tool 结果属于同一组，不得拆开。
- 从最旧的非 system 消息组开始丢弃，直到满足预算；裁剪不新增节点。
- 如果只剩 system 消息或单个消息组仍超过预算，返回 `context.window_exceeded`，不发送请求。
- `compaction` 控制消息由队列或已有记录提供；`Context` 不额外调用模型生成摘要。
- 压缩按 `from`/`to` 跳过节点，`summary` 作为 `system` 消息插入；压缩范围不得重叠。
- 压缩只改变本次请求的可见序列；控制消息本身已持久化，后续装配继续按其范围跳过。

#### 4.2.7 持久化与出队

- 首次 `assemble` 使用 `Sessions.create`；后续使用 `Sessions.append`。
- 持久化成功后才出队；失败时队列保留、选择缓存不更新、不产生半批节点。
- `Context` 不直接写文件；只调用 `Sessions`。
- 临时会话首次落盘后 `persisted=true`；`SessionMeta` 由服务层提供，不由 `Context` 创建。

### 4.3 `Tools`

`Tools` 负责工具与包装器的注册、选择、包装与执行；包装器不拥有独立调用入口，只包装工具执行。

#### 4.3.1 契约

```ts
type JsonSchema = JsonObject;

interface ToolDeclaration {
  readonly id: string;          // 运行时标识
  readonly source: string;
  readonly name: string;        // package#name，用于选择与调用
  readonly description: string;
  readonly parameters: JsonSchema;
  execute?: ToolFunction;
}

interface ToolInvocationContext {
  sessionId: SessionId;
  workspace: string;
  signal: AbortSignal;
}

type ToolFunction = (
  args: JsonValue,
  context: ToolInvocationContext
) => Promise<ToolResult>;

type ToolWrapper = (wrapped: ToolDeclaration) => ToolDeclaration;

class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolDeniedError";
  }
}
```

- `ToolDeclaration.id` 是运行时标识，不用于选择。
- `ToolDeclaration.name` 为 `package#name`；不同包同名由包名命名空间区分。
- 工具参数由供应商适配器解析为 `JsonValue` 后传入；工具实现自行校验参数。
- 包装器接收 `ToolDeclaration` 并返回新的 `ToolDeclaration`；包装后的 `execute` 可调用 `wrapped.execute`。
- 包装器之间必须执行顺序无关；包装器内部需要 hook 先后顺序时自行处理。
- 包装器不得替换调用 `ToolCall.id`。

#### 4.3.2 注册与选择

```ts
interface Tools {
  registerTool(declaration: ToolDeclaration): void;
  registerWrapper(name: EntryName, wrapper: ToolWrapper): void;
  selected(selection: SelectionState): ToolDeclaration[];
  invoke(
    call: ToolCall,
    selection: SelectionState,
    context: ToolInvocationContext
  ): Promise<ToolResult>;
}
```

- 注册表按 `package#name` 查找工具和包装器；同一 `package#name` 重复注册失败，不同包同名不冲突。
- `selected` 只返回被选中的工具声明，不返回包装器。
- 包装器被选中后只在工具调用时参与包装，不作为可调用工具。
- 工具声明序列化给供应商时只保留 `id`、`name`、`description`、`parameters`；`execute` 留在本地。
- 工具声明通过 `LlmRequest.tools` 提供给适配器；技能内容由 `Skills.selected` 提供并写入系统消息。

#### 4.3.3 调用流水线

`invoke` 的步骤：

1. 按 `call.name` 查找已选中的工具；找不到返回 `tool.failed`。
2. 从注册表取被选中的包装器，按注册顺序应用；包装器自身必须与顺序无关。
3. 确认包装后的工具具有 `execute`。
4. 调用 `execute(call.arguments, context)`。
5. `ToolDeniedError` 转为 `isError` 的工具结果，错误码 `tool.denied`。
6. 其他异常转为 `isError` 的工具结果，错误码 `tool.failed`；不终止 turn。

多个工具调用可以并行执行；结果按原始 `ToolCall.id` 归属，回填顺序按供应商要求处理。

### 4.4 `AgentLoopDriver`

`AgentLoopDriver` 驱动一个 turn 的 step 循环，调用 `Context`、`LLMAdapter`、`Tools`，产生引擎事件。

#### 4.4.1 输入与输出

```ts
interface RunTurnInput {
  sessionId: SessionId;
  turnId: TurnId;
  meta: SessionMeta;
  context: Context;
  sessions: Sessions;
  tools: Tools;
  adapter: LlmAdapter;
  execute: ExecuteProvider;
  nodeId?: NodeId;
  signal: AbortSignal;
}

type TurnReason = "completed" | "cancelled" | "failed";

interface TurnResult {
  sessionId: SessionId;
  turnId: TurnId;
  reason: TurnReason;
  error?: { code: string; message: string };
}

interface AgentLoopDriver {
  run(input: RunTurnInput): Promise<TurnResult>;
  cancel(turnId: TurnId): Promise<boolean>;
}
```

`LlmAdapter`、`ExecuteProvider` 与 `LlmRequest` 见 §2 与 HLD §6.2；`run` 不直接处理协议。

#### 4.4.2 状态机

```text
idle -> running -> cancelling -> ended
                \-> ended
```

- `run` 进入 `running`，发布 `turn.started`（`mode` 为 `new`）。
- `cancel(turnId)` 将当前 turn 置为 `cancelling`，abort 供应商流并置工具 signal；已执行的工具不被强制终止。
- 中止后不再发起新 step；当前工具结果回填、已产生回复写入后结束。
- 正常结束或失败进入 `ended`，发布 `turn.ended`。

#### 4.4.3 循环

1. 调用 `Context.assemble`；首次使用 `Sessions.create`，之后使用 `Sessions.append`。
2. 发布 `session.updated`（首次装配写入的节点）。
3. 用 `adapter.buildRequest` 构建供应商请求。
4. 通过 `execute` 获取流，逐块调用 `adapter.parseChunk`；累计文本、工具调用、usage 与 stop reason。
5. 若返回包含工具调用：
   - 将 assistant 文本与工具调用写入 `SessionNode`；
   - 按调用顺序/并行度执行 `Tools.invoke`；
   - 将工具结果写入 `SessionNode`；
   - 发布 `session.updated` 与 `turn.step`；
   - 回到步骤 1。
6. 若无工具调用：
   - 将 assistant 回复写入 `SessionNode`；
   - 发布 `session.updated` 与 `turn.step`；
   - 若队列非空，回到步骤 1；否则结束。

- 每个 step 结束后检查队列；用户新增条目作为 steer 在下一个 step 装配。
- turn 的首个 step 使用 `nodeId` 选择分支起点；后续 step 使用当前节点。
- 队列为空且没有工具调用时结束；用户中止按 `cancelling` 处理。
- 供应商错误转为 `turn.ended.failed`；工具错误按工具结果回填，不终止 turn。
- 存储错误立即失败，不继续请求；已写入节点保留。

#### 4.4.4 持久化与事件

- `Context` 负责首次装配节点的持久化；`AgentLoopDriver` 负责 assistant 回复、工具结果、压缩/中止控制消息的追加。
- 每批写入使用 `Sessions.append`，父节点为当前最后节点；失败不继续循环。
- 写入成功后发布 `session.updated`，只携带本批节点。
- `turn.step` 在一个 step 完成后发布；`turn.ended` 在 turn 结束后发布。
- 取消时若已有部分回复，先写入部分回复，再写入 `role=cancel` 控制消息；`at` 为当前最后节点。
- 事件通过 `EventBus` 发布，由服务层转换为协议事件；核心层不引用协议类型。

### 4.5 跨模块约束

- `Sessions` 不创建 `SessionMeta`；服务层负责临时 meta 与首次 `create`。
- `Context` 不写文件；只通过 `Sessions` 持久化。
- `Tools` 不持有会话状态；工具结果由 `AgentLoopDriver` 归属到 turn。
- `AgentLoopDriver` 不直接操作协议；事件经 `EventBus`。
- 所有节点只追加；`create`/`append` 批量原子；失败不留半批节点。
- 队列不持久化；`Context` 出队与持久化在同一临界区。
- 选择只使用 `package#name`；`selection` 不包含 id、顺序或队列条目。
- 包装器执行顺序无关；工具与包装器选择由声明类控制消息表达。

## 5 服务层

### 5.1 daemon 与 `Transport`

daemon 是用户级单实例进程，负责监听、路由、持久化、扩展装载和供应商请求执行；核心层实例由 daemon 持有。

#### 5.1.1 启动与停止

- 启动时获取数据目录下的锁文件并绑定 socket；锁或 socket 已被占用时退出。
- 启动顺序：
  1. 读取软件配置与工作区配置；
  2. 初始化 `SessionStore`；
  3. 初始化 `Extensions`、`Tools`、`Skills`、`ProviderManagement`；
  4. 初始化 `ProviderHost`、`CredentialStore`；
  5. 初始化 `Gateway` 与 `Concurrency`；
  6. 开始监听 `Transport`。
- 停止时先停止接受新连接，再中止活跃 turn、等待写盘完成、关闭 socket 与锁。
- daemon 崩溃后只恢复已落盘会话；临时会话与消息队列随进程退出丢失。
- 未完成的热会话在恢复时标记为中断，由用户决定是否继续。

#### 5.1.2 `Transport`

```ts
interface Connection {
  id: string;
  peerUid: number;
  send(message: Response | Event): void;
  close(): void;
}

interface Transport {
  start(handler: (connection: Connection, request: Request) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
```

- 默认 Unix domain socket，权限 `0600`；Windows 使用命名管道。
- 连接建立时校验 peer 凭据，要求与 daemon 同用户；不监听网络地址。
- 分帧按 §3.1 的 NDJSON 规则；超过 8 MiB 关闭连接。
- `Transport` 只负责监听、连接、分帧、发送和关闭，不解释方法语义。
- `Connection.send` 串行化同一连接上的写入，避免多请求响应交错破坏帧。
- 连接关闭时通知 `Gateway` 清理订阅；不中止活跃 turn。

### 5.2 `Concurrency`

```ts
interface Concurrency {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  registerTurn(sessionId: SessionId, turnId: TurnId): void;
  unregisterTurn(sessionId: SessionId, turnId: TurnId): void;
  activeTurn(sessionId: SessionId): TurnId | undefined;
  cancelAll(): Promise<void>;
}
```

- 每个会话一把逻辑锁；会话内队列写、配置、turn 启动与持久化按锁串行化。
- 不同会话可并行；事件发送与请求处理不共享全局锁。
- `activeTurn` 只记录正在运行的 turn；`turn.list` 从该集合生成快照。
- `runExclusive` 不跨会话持有锁；回调内不得等待其他会话的锁。
- 停止时取消所有活跃 turn，并等待其收尾写入完成。
- `Concurrency` 不持久化状态；daemon 重启后活跃 turn 集合为空。

### 5.3 `Gateway`

`Gateway` 把协议方法映射到 `Context`、`Sessions`、`AgentLoopDriver`、`Extensions` 与存储；本身不实现上下文组装或工具执行。

#### 5.3.1 会话运行时

```ts
interface SessionRuntime {
  meta: SessionMeta;
  context: Context;
  activeTurn?: TurnId;
  subscribers: Set<string>;   // connection id
}
```

- `Gateway` 维护 `sessionId -> SessionRuntime` 映射。
- 已落盘会话按需加载：读取 `SessionMeta`，创建 `Context`（`persisted=true`）并调用 `initialize`。
- `session.create` 创建临时 `SessionMeta`、`Context`（`persisted=false`）和空队列；不写盘。
- 临时会话不出现在 `session.list`；daemon 退出即丢失。
- 同一会话的运行时只创建一次；多个客户端共享。

#### 5.3.2 方法路由

- `session.create`：校验 provider/model、workspace 与 extensions；创建运行时；将 `systemPrompt` 和扩展选择物化为队列条目；返回临时 `SessionMeta`。
- `session.list`：只查 `SessionStore`；不经过运行时。
- `session.read`：在会话锁内读取 `meta`、`records`、`queue` 与 `selection`；无 `nodeId` 读全树，有 `nodeId` 读分支；临时会话没有节点。`selection` 由 `Context.selectionFor` 计算，只含已持久化记录。
- `session.configure`：带 `systemPrompt` 时先检查活跃 turn，存在则返回 `turn.active`，不修改队列/meta；仅 `model`/`provider` 时校验后更新 meta；临时会话只改内存，已落盘会话调用 `SessionStore.updateMeta`；`systemPrompt` 只更新或新增 `role=system` 队列条目。
- `session.subscribe` / `session.unsubscribe`：维护连接的订阅集合；重复订阅幂等；退订不发事件；断开清理。
- `queue.enqueue` / `edit` / `remove` / `clear`：委托 `Context`；返回队列 id；推送 `queue.updated`。
- `entries.snapshot`：从 `Extensions` 取得可用条目，从 `Context` 取得已持久化选择；不合并队列。
- `turn.start`：无活跃 turn 时生成 `turnId`，已落盘会话先写入 `active-turn.json`，临时会话在首批节点落盘后补写；注册到 `Concurrency`，异步调用 `AgentLoopDriver.run`，返回 `{turnId, mode:"new"}`；turn 结束或失败时删除标记。已有活跃 turn 时只确认队列并返回该 turn 的 `turnId` 与 `mode=steer`。
- `turn.list`：从 `Concurrency` 返回活跃 turn 快照。
- `turn.cancel`：调用 driver 的 cancel；找不到返回 `cancelled=false`。
- `provider.list`：从 `ProviderManagement` 与 `CredentialStore` 生成；`ready` 由凭据状态计算。
- `template.list` / `preview` / `apply`：委托 `TemplateStore`、`WorkspaceAccess`、`ExecHost`，并创建临时会话。
- `client.list` / `start`：委托 `ClientRegistry`。

#### 5.3.3 事件路由

- `Context` 的 `queue.updated`、`selection.updated`、`session.updated`，以及 driver 的 turn 事件进入 `EventBus`。
- `Gateway` 把引擎事件转换为协议事件，只发送给订阅该会话的连接。
- 事件都带 `sessionId` 与时间戳；`queue.updated` 携带完整队列，`selection.updated` 携带完整名称集合。
- `session.updated` 只携带本次追加节点；客户端按 `id`/`parentId` 合并。
- `client.launched` 是连接级事件，不受会话订阅限制。
- 事件不重放；重连后客户端重新 `session.read`。

#### 5.3.4 多客户端与临时状态

- 队列写操作通过 `Concurrency.runExclusive` 串行化，最后写入者获胜。
- 客户端以 `session.read` 为初始快照、`queue.updated` 为增量。
- 订阅与连接绑定，不持有全局锁。
- 临时会话可读、可订阅、可队列操作；首次 turn 落盘后进入 `session.list`。
- daemon 停止或崩溃时，未落盘的临时会话与队列不恢复。

### 5.4 `SessionStore`

`SessionStore` 实现 `SessionRepository`，负责会话目录、`meta.json`、`events.jsonl` 与项目记录。

#### 5.4.1 布局

| 路径 | 内容 |
|---|---|
| `<dataDir>/sessions/<sessionId>/meta.json` | `SessionMeta` |
| `<dataDir>/sessions/<sessionId>/events.jsonl` | `SessionNode`，一行一个 |
| `<dataDir>/sessions/<sessionId>/active-turn.json` | 活跃 turn 的恢复标记，不属于会话记录 |
| `<dataDir>/projects.json` | 模板衍生项目 `ProjectRef[]` |

- `sessionId` 只能使用受控字符集；不得包含路径分隔符、`..` 或绝对路径。
- 空会话没有目录、没有 `meta.json`。
- `active-turn.json` 是运行时恢复标记，不是 `SessionNode`，不参与列表、导出或选择。
- `meta.json`、`events.jsonl` 与 `active-turn.json` 只由 daemon 维护；用户不手工编辑。

#### 5.4.2 写入

- `create`：
  1. 确认会话目录不存在；
  2. 写 `events.jsonl.tmp` 与 `meta.json.tmp`；
  3. fsync 两个临时文件；
  4. rename events，再 rename meta；
  5. fsync 目录（POSIX；Windows 使用可用语义）。
- `append`：
  1. 取该会话写锁；
  2. 若文件末尾存在不完整行，截断到最后一个完整换行；
  3. 将本批节点写成完整 JSONL 行；
  4. 一次批量写入并 fsync。
- `updateMeta`：
  1. 读取当前 meta；
  2. 只替换 `model`、`provider`；
  3. 写临时 meta，fsync 后 atomic rename。
- `create`/`append`/`updateMeta` 失败时不留下半批节点；临时文件在启动时清理。
- 写入不修改已有节点，不修改 `meta.json` 的不可变字段。

#### 5.4.3 读取

- `SessionStore` 为每个已加载会话维护 `id -> (parentId, offset)` 的内存索引；首次加载扫描文件建立索引，`append` 成功后更新索引。
- `readTree` 按文件顺序返回全部节点；完整行 JSON 损坏返回 `storage.corrupt`。
- `readBranch` 使用索引从 `nodeId` 沿父指针上溯，再按 offset 读取对应行，避免每次从文件头扫描；省略 `nodeId` 时以最后一个完整行为分支末端。
- 索引不持久化；daemon 重启后首次读取重建。
- 末尾不完整行在读取时忽略，不修改文件；下一次 append 前截断。
- 文件中间出现空白行忽略；非法行报错。
- 节点 `parentId` 不存在、根指针异常或环返回 `storage.corrupt`。

#### 5.4.4 列表与项目

- `list` 扫描 `sessions/*/meta.json`，只返回已落盘会话；忽略临时文件与无 meta 的孤儿目录。
- 返回顺序不构成契约。
- `projects.json` 由 `TemplateStore` 维护，记录 `ProjectRef`。
- 配置、凭据、扩展目录不进入会话记录。

#### 5.4.5 并发与恢复

- 同一会话的 `create`/`append`/`updateMeta` 由 `Concurrency` 串行化。
- 不同会话可并行写。
- daemon 重启时清理 `.tmp` 文件与无 meta 的孤儿目录；`active-turn.json` 由 `Gateway` 按 §6.5 恢复或删除。
- 已落盘会话恢复为冷会话；未完成 turn 由 driver 标记中断。
- `meta.json` 不可读或 schema 不支持时报告 `storage.corrupt`，不返回部分结果。

### 5.5 `Extensions`

`Extensions` 负责发现扩展、读取清单与配置、登记内容条目，并按需装载实现代码。

#### 5.5.1 发现来源

- 内置扩展：`extensions/builtin`。
- 软件配置目录：`<configDir>/extensions/`。
- 工作区：`<workspace>/.pisces/extensions/`。
- 扩展是普通 npm 包或目录；以 `package.json` 的 `pisces` 字段或约定目录声明条目。

#### 5.5.2 清单

```ts
interface ExtensionManifest {
  tools?: string[];
  wrappers?: string[];
  skills?: string[];
  context?: string[];
  providers?: string[];
  clients?: { id: string; entry: string }[];
}
```

- 发现阶段只读取清单与资源文件，不执行扩展代码。
- 条目名称统一为 `package#name`：`package` 取扩展包名，`name` 取条目声明的名称；未声明名称时取文件/目录基名。
- 同一 `package#name` 重复出现时，该条目不可用并记录清点错误；不同包同名不冲突。
- `providers` 解析为 `ProviderDescriptor`；`clients` 登记到 `ClientRegistry`。
- `tools`、`wrappers`、`context` 的代码按需导入；`skills` 读取内容。

#### 5.5.3 配置

- 配置来源优先级：工作区 `.pisces/config.json` > 软件配置目录 > 内置默认。
- 默认 `provider`/`model` 从配置读取，供 `session.create` 使用；工作区配置可覆盖软件配置。
- `defaultWorkspace` 只来自全局配置，供 `session.create` 在省略 `workspace` 时使用；工作区配置需要先确定工作区才能读取，因此不提供 `defaultWorkspace`，也不参与默认工作区解析；若出现按未知配置键处理。
- `defaultWorkspace` 必须是绝对路径；`config` 只校验格式，存在性与可写性在 `session.create` 时检查。
- `config` CLI 只影响此后创建的会话；不修改既有会话的 `SessionMeta`。
- 新会话的默认扩展选择来自配置；`session.create.extensions` 显式列表替换默认选择。
- 配置键不存在或类型错误返回 `config.invalid` / `config.unknown_key`。
- 扩展代码不直接访问配置文件；由 `Extensions` 读取并注入。

#### 5.5.4 装载

- 使用内置 TypeScript 加载器（jiti 或等价实现）按需转译 `.ts`/`.tsx`。
- 宿主包 `@pisces/*` 映射到 daemon 内的宿主实例，扩展不打包宿主包。
- 扩展依赖从其自身目录的 `node_modules` 解析。
- 装载器不因文件位于 `node_modules` 而拒绝加载；扩展无需预构建。
- 工具、包装器、上下文来源、供应商、客户端按类型登记到对应注册表。
- 一个扩展装载失败只标记该扩展不可用，不阻断 daemon 启动。
- 包装器执行顺序无关；选择只决定是否加入工具流水线。

#### 5.5.5 清点与选择

- `entries.snapshot` 返回工具、包装器、技能、上下文来源；返回 `package#name`、类型、来源与描述。
- 工具与包装器的声明只序列化 `id`、`name`、`description`、`parameters`；实现代码留在本地。
- 技能内容作为系统消息进入装配；上下文来源片段按 `Context` 规则追加。
- `providers`、`clients` 不参与选择。
- 扩展的安装、更新与移除由 npm、git 完成，不在本软件生命周期内。

### 5.6 `ProviderHost`

`ProviderHost` 实现 `ExecuteProvider`，负责 HTTP、凭据注入、超时、重试与传输分帧。

```ts
interface ProviderHost {
  execute(providerId: string): ExecuteProvider;
  ready(providerId: string): Promise<boolean>;
}
```

- `ProviderDescriptor` 提供 `baseUrl`、`auth`、`headers` 与模型清单；`ProviderHost` 以 `baseUrl + WireRequest.path` 组合请求。
- `ExecuteProvider` 绑定到 provider；`AgentLoopDriver` 只接收注入的函数，不读配置。
- 凭据由 `CredentialStore` 提供；API key 注入请求头，OAuth 按需刷新；错误消息不含凭据。
- 请求体为 `WireRequest.body`，headers 合并描述符 headers 与适配器 headers。
- 响应使用流式读取；SSE 的 `data:` 载荷作为字符串块交给 `LLMAdapter.parseChunk`；非 SSE 响应按单块处理。
- 429 与 5xx 可重试并退避；4xx（除 429）不重试；中止不重试；流开始后不重试。
- 超时、网络错误、状态码错误映射为 `provider.transport` / `provider.timeout` / `provider.invalid_response`。
- 供应商业务错误体交给适配器解析；`ProviderHost` 不解释模型内容。
- `ready` 由凭据有效性与模型清单共同决定；`provider.list` 使用该结果。

### 5.7 `WorkspaceAccess` 与 `ExecHost`

#### 5.7.1 `WorkspaceAccess`

```ts
interface WorkspaceAccess {
  resolve(workspace: string, path: string): string;
  ensureDirectory(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}
```

- `resolve` 将相对路径限制在工作区内；拒绝绝对路径、`..` 越界与非法路径字符。
- 不跟随工作区外的符号链接；不提供沙箱。
- 模板初始化与文件创建都经该接口，核心层不接触文件系统。
- 写入失败返回 `storage.io`；已写文件由调用方处置。

#### 5.7.2 `ExecHost`

```ts
interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecHost {
  run(
    command: string,
    args: string[],
    options?: ExecOptions
  ): Promise<ExecResult>;
}
```

`ExecOptions` 见 HLD §6.5。

- 使用 `spawn` 直接执行 command/args，不经过 shell。
- `cwd`、`env`、`timeoutMs`、`signal` 由调用方提供。
- 超时或 abort 时终止子进程；已产生的 stdout/stderr 保留在结果中。
- 结果包含退出码、stdout、stderr；非零退出不抛异常，由调用方判断。
- 不继承 daemon 的敏感环境变量；只传递显式 `env` 与基础 PATH。
- 不强制终止工具；工具通过 `ToolInvocationContext.signal` 协作中止。

### 5.8 `TemplateStore` 与 `ClientRegistry`

#### 5.8.1 `TemplateStore`

- 从软件配置目录的 `templates/` 读取模板；模板是声明式目录/文件/脚本。
- `list` 返回 `TemplateInfo`；`preview` 解析并返回 `TemplatePreview`，无副作用。
- `apply` 校验模板、工作区与 `confirmed`；由 `WorkspaceAccess` 创建文件、`ExecHost` 执行脚本。
- 成功后写入 `ProjectRef` 到 `projects.json`；失败不创建会话。
- 已创建文件不自动回滚；由用户处置。
- 模板提示词作为工作区文件，进入请求体前仍须经队列与确认。

#### 5.8.2 `ClientRegistry`

```ts
interface ClientRegistry {
  register(registration: ClientRegistration): void;
  list(): ClientRegistration[];
  start(id: ClientId): Promise<{ pid: number }>;
}
```

- 客户端登记来自扩展清单的 `clients`。
- `start` 校验 id，按 `entry` 启动子进程，传入 daemon socket 路径与客户端 id。
- 启动失败返回 `client.launch_failed`；已启动进程不进入协议流。
- 客户端 stdout/stderr 由 daemon 日志接收，不混入协议。

### 5.9 服务层装配

- `Gateway` 依赖 `SessionStore`、`Extensions`、`ProviderHost`、`TemplateStore`、`ClientRegistry` 与 `Concurrency`。
- `Extensions` 依赖 `Tools`、`Skills`、`Context`、`ProviderManagement`、`ClientRegistry`。
- `ProviderHost` 依赖 `CredentialStore` 与 `ProviderManagement`。
- `TemplateStore` 依赖 `WorkspaceAccess`、`ExecHost`、`projects.json`。
- 核心层不引用服务层；服务层通过接口注入。
- 启动失败时关闭已打开的 socket、锁与子进程；不留下半初始化状态。

## 6 端到端流程

### 6.1 新建会话与首次落盘

1. 客户端发送 `session.create`，可带 `workspace`、`templateId`、`model`、`provider`、`systemPrompt`、`extensions`。
2. `Gateway` 校验 provider/model 与扩展名称；`workspace` 省略时读取全局 `defaultWorkspace`，校验路径为绝对、存在且可写；失败则不创建临时会话。通过后创建临时 `SessionMeta`、`Context`（`persisted=false`）与空队列。
3. `systemPrompt` 转成一条 `kind=agent`、`role=system` 的队列条目；`extensions` 与默认选择转成一条 `role=declaration` 的队列条目，`toggle` 为 `package#name`。
4. 返回临时 `SessionMeta`；不写盘，不进入 `session.list`。
5. 客户端直接用临时 `SessionMeta` 显示空会话；打开条目面板时调用 `entries.snapshot`，临时会话的 `selection` 为空，客户端按队列中的声明 delta 计算显示状态。
6. 用户入队首条消息并发送 `turn.start`；`Gateway` 生成 `turnId`，注册活跃 turn，调用 `AgentLoopDriver.run`。
7. `Context.assemble` 读取空分支、应用队列声明、物化队列节点、解析选中的上下文来源与技能；没有节点时返回 `turn.empty`。
8. 首次持久化调用 `Sessions.create(meta, nodes)`；`SessionStore` 原子写入 `meta.json` 与 `events.jsonl`。
9. 持久化成功后 `Context` 出队并更新选择；`session.updated` 推送首批节点；turn 开始请求供应商。
10. 之后 assistant 回复、工具结果由 `AgentLoopDriver` 使用 `Sessions.append` 追加。
11. 此时会话才出现在 `session.list`；临时会话与队列已转为已落盘记录/空队列。

失败边界：

- `Sessions.create` 失败：不写 meta/nodes，队列保留，临时会话仍在内存。
- 首次 turn 没有产生节点：`turn.empty`，不落盘，队列保留。
- 首次落盘后供应商请求失败：会话已落盘，turn 失败，队列已清空。
- daemon 在首次落盘前退出：临时 meta 与队列丢失，磁盘无空会话。

### 6.2 读取会话与选择条目

1. 客户端发送 `session.read`。
2. `Gateway` 在会话锁内加载或复用运行时；已落盘会话创建 `Context` 并 `initialize`。
3. 无 `nodeId`：返回完整会话树与默认活动分支的选择；有 `nodeId`：返回根到该节点的分支与该分支的选择。
4. `queue` 始终是当前队列；`selection` 只含已持久化记录，不含队列中的声明 delta。
5. `records` 可能保留已取消选择的来源/技能节点；`selection` 表示当前是否启用。客户端不应以节点存在推断选中，`Context` 装配时按同一选择过滤请求内容。
6. `session.read` 不改变活动分支；分支由后续 `turn.start.nodeId` 选择。
7. 客户端用 `entries.snapshot` 取得可用条目与已持久化选择，再按队列中的声明 delta 计算界面显示状态。
8. 客户端选择/取消条目时，通过 `queue.enqueue` 入队新的声明类控制消息；`queue.updated` 推送完整队列。
9. 订阅后，`queue.updated`、`selection.updated`、`session.updated` 与 turn 事件按 `sessionId` 推送。

临时会话：`records` 为空，`selection` 为空，`nodeId` 返回 `session.node_not_found`。

### 6.3 turn 执行与工具调用

1. `turn.start` 无活跃 turn：生成 `turnId`，`mode=new`；有活跃 turn：只确认队列，`mode=steer`，不启动第二个 turn。
2. `AgentLoopDriver` 调用 `Context.assemble`；首次使用 `create`，之后使用 `append`。
3. `LLMAdapter.buildRequest` 构建供应商请求；`ProviderHost` 执行 HTTP/SSE 流。
4. `parseChunk` 产出文本、推理、工具调用、usage 与 stop reason；driver 累计并发布事件。
5. 有工具调用时：
   - assistant 文本与 `toolCall` 写入节点；
   - `Tools.invoke` 执行工具；结果按 `ToolCall.id` 归属；
   - 工具结果写入 `tool` 节点；
   - `session.updated` 与 `turn.step` 推送；
   - 进入下一个 step。
6. 无工具调用时：assistant 回复写入节点；`session.updated` 与 `turn.step` 推送。
7. 队列非空时，steer 条目在下一个 step 边界装配；队列为空且无工具调用时结束，`turn.ended` 推送。
8. 供应商错误转为 `turn.ended.failed`；工具错误作为错误结果回填，不终止 turn。

### 6.4 取消与 steer

**取消**

1. 客户端调用 `turn.cancel`，`Gateway` 定位活跃 turn。
2. driver 置为 `cancelling`，abort 供应商流，置工具 signal。
3. 不再发起新 step；当前工具允许协作中止并回填结果。
4. 已产生的 assistant 回复写入节点；追加 `role=cancel` 控制消息，`at` 为当前最后节点。
5. `turn.ended` 的 `reason` 为 `cancelled`；客户端连接与订阅不受影响。

**steer**

1. 活跃 turn 中客户端入队新消息；`queue.updated` 推送。
2. `turn.start` 返回已有 `turnId` 与 `mode=steer`，不启动新 turn。
3. driver 在当前 step 结束后检查队列；下个 step 装配新增条目。
4. `nodeId` 在活跃 turn 中禁止；越界返回 `turn.node_id_forbidden`。

### 6.5 daemon 崩溃恢复

启动恢复顺序：

1. 清理 `sessions/*/` 下的 `.tmp` 文件与无 `meta.json` 的孤儿目录。
2. 扫描 `sessions/*/meta.json`，校验 schema 与节点记录。
3. 清理 `events.jsonl` 末尾的不完整行；完整行损坏则报告 `storage.corrupt`。
4. 读取活跃 turn 标记；对每个成功加载的会话，如果存在标记，追加 `role=cancel` 控制消息（`reason=daemon_restart`，`at=最后节点`），删除标记。
5. 恢复为冷会话；`turn.list` 为空；客户端重新 `session.read`。

活跃 turn 标记：

- 路径：`<dataDir>/sessions/<sessionId>/active-turn.json`。
- 内容：`{ turnId, startedAt }`；由 `Gateway` 在 `turn.start` 启动 driver 前写入，正常结束后删除。
- 标记是服务层运行时状态，不进入 `SessionMeta`、不进入 `events.jsonl`、不参与选择。
- 临时会话没有标记；首次落盘前崩溃不产生标记。临时会话在首批节点落盘后补写标记。
- 已落盘会话的 turn 启动前必须写标记；临时会话补写失败时结束 turn，不继续请求。
- 恢复时追加 `cancel` 失败则保留标记，下次启动重试；不重复追加同 turn 的 `cancel` 由 `turnId` 检查。

未完成工具：

- 工具执行不是崩溃恢复的事务边界；已写入的工具结果保留，未写入的调用丢弃。
- 恢复后不自动重放工具；用户可继续会话或重新发起 turn。
- 队列未持久化，崩溃时未出队条目不恢复。

### 6.6 模板创建

1. 用户选择模板并调用 `template.preview`；只解析与展示，不写文件。
2. 用户确认后调用 `template.apply`，必须带 `confirmed=true`。
3. `TemplateStore` 校验模板与工作区；`WorkspaceAccess` 创建目录与文件；`ExecHost` 执行初始化脚本。
4. 成功后写入 `ProjectRef`；创建临时会话，将模板配置/提示词物化为队列条目。
5. 返回 `{projectId, sessionId}`；首次 turn 仍按 §6.1 落盘。
6. 脚本失败返回 `template.init_failed`，不创建会话；已创建文件不自动回滚。
7. 模板提示词不直接写入请求体；仍须经队列与确认。

### 6.7 扩展装载与条目刷新

1. daemon 启动时发现扩展清单，不执行扩展代码。
2. 读取配置，合并默认选择；条目名称统一为 `package#name`。
3. 用户打开面板时调用 `entries.snapshot`；工具、包装器、技能、上下文来源进入结果。
4. 用户选择条目时入队声明类控制消息；`Context` 在装配时更新选择。
5. 工具/包装器/上下文代码在需要时由加载器导入；技能内容在装配时读取。
6. 扩展安装或更新后，新会话使用新清点；既有会话记录不改写。
7. 同一 `package#name` 重复出现时该条目不可用；不同包同名不冲突。

## 7 CLI 与数据迁移

### 7.1 CLI 与协议边界

| 命令 | 路径 |
|---|---|
| `start` / `stop` / `status` | 本地 daemon 生命周期 |
| `run` | 经协议创建/读取会话、入队、`turn.start` |
| `sessions list` | 经协议 `session.list` |
| `sessions export` | 经协议读取分支并输出 JSONL |
| `sessions cancel` | 先解析活跃 turn，再 `turn.cancel` |
| `client list/start` | 经协议 `client.list` / `client.start` |
| `templates list/preview/apply` | 经协议模板方法 |
| `provider.list` / `models list` | 经协议只读查询 |
| `providers check` | 仅 CLI，直接检查本地凭据与配置 |
| `extensions list` | 仅 CLI，读取扩展目录 |
| `auth` | 仅 CLI，校验凭据 |
| `config list/get/set/unset` | 仅 CLI，直接读写本地配置 |

- 管理命令不经 daemon 协议；daemon 在使用时读取配置。
- `config` 只影响此后创建的会话，不改写既有会话。
- CLI 不直接访问 `events.jsonl`；会话读取与导出经协议/服务层。

### 7.2 `run`

- `--new`：创建新会话。
- `--continue`：继续最近会话。
- `--session <id>`：指定会话；不存在时按 `--create` 处理。
- `--create`：与 `--session` 同用，不存在时新建。
- `--enable` / `--disable`：解析为 `package#name` 列表，入队声明类控制消息。
- `--system-prompt` / `--use-default-system-prompt`：设置/使用默认系统提示词；进入队列。
- `--model` / `--provider`：设置会话模型与供应商。
- `--print` / `--json`：非交互输出。
- 交互模式：用户输入入队；发送 `turn.start`；流式展示事件；Ctrl-C 等同 `sessions cancel`。
- `run` 不把提示词直接写入请求体；所有输入先入队。
- 退出码：成功 0；协议/会话/供应商错误非 0；取消按 CLI 约定返回。

### 7.3 数据迁移

- 当前 `schemaVersion` 为 `1`；`SessionMeta` 与 `SessionNode` 都带版本。
- `SessionStore` 在加载时校验版本：
  - 等于当前版本：直接读取；
  - 低于当前版本：按版本迁移函数升级；
  - 高于当前版本：拒绝加载并报告 `storage.corrupt`。
- 迁移函数按版本注册；迁移失败不返回部分结果，不写回损坏文件。
- 迁移后的 meta/nodes 在成功加载后原子写回；写回失败保留旧文件并报告。
- `events.jsonl` 逐行迁移；同一文件中的节点版本必须一致，混合版本报错。
- 当前没有历史版本，第 1 版是初始格式；新增字段必须保持向后兼容或提升版本。
- 协议版本与会话 schema 版本独立；协议次版本兼容不代表旧会话格式兼容。

### 7.4 导出

- `sessions export <id>` 输出 JSONL：首行为 `SessionMeta`，其后为默认活动分支节点，从根到当前。
- 只导出默认分支，不导出其他分支、队列、临时状态或凭据。
- 导出可能包含敏感内容；是否导出由用户决定。
- 导出不修改会话记录，不改变活动分支。

### 7.5 失败与恢复约定

- 首次落盘失败：队列保留，无 meta/nodes；客户端可重试。
- 上下文装配追加失败：队列保留，选择缓存不更新；不继续请求。
- assistant/tool/cancel 追加失败：不继续请求；已写节点保留；队列已出队，不自动恢复。
- 取消写入失败：turn 仍结束，但标记未落盘；重启时无法恢复该标记，用户可继续。
- 恢复时 `meta.json` 损坏：会话不可加载，报告 `storage.corrupt`，不影响其他会话。
- 恢复时节点损坏：不加载该会话，不返回部分记录。
- 临时会话、队列、活跃 turn 标记在 daemon 退出时按各自规则清理或保留。

## 8 非功能设计、错误与可测试性

### 8.1 性能

- `SessionStore` 的 `readBranch` 使用内存索引，复杂度与分支长度成正比；`readTree` 与节点总数成正比；`append` 只写本批节点。
- 首次加载会话需要扫描 `events.jsonl` 建立索引；索引不持久化，按会话常驻内存。
- 装配活动分支不复制整棵会话树；只有当前分支的消息进入请求。
- 供应商响应按流处理，不等待完整响应；文本、usage 与工具调用边解析边累计。
- 工具调用可以并行，并发数由 `Concurrency`/服务层限制；结果按原始调用顺序或供应商要求回填。
- 队列只在内存中驻留；装配时取走并写入会话，不为队列维护磁盘索引。
- 扩展清单只读取元数据；实现代码按需加载并缓存，避免每个请求重复转译。
- 单帧上限 8 MiB；`session.read` 全树可能很大，客户端应优先读取分支。
- token 估算只用于裁剪，不追求与供应商 tokenizer 完全一致。

### 8.2 可靠性

- `create`/`append`/`updateMeta` 批量原子；失败不留半批节点。
- `append` 前截断末尾不完整行；完整行损坏直接报错，不返回部分结果。
- `create` 先 rename events 再 rename meta；中途崩溃只留下可清理的孤儿目录。
- 队列不持久化；daemon 崩溃丢失未出队条目，这是有意的取舍，不做 WAL。
- 活跃 turn 使用 `active-turn.json` 标记；重启时追加 `cancel` 并清理。
- 供应商 429/5xx 可重试；流开始后不重试；取消不重试。
- 工具失败回填为工具结果，不终止 turn；存储失败终止 turn，不继续请求。
- `stop` 等待写盘完成；异常退出不保证未落盘数据。
- 不自动重放未完成的工具调用；用户决定是否继续。

### 8.3 安全边界

- daemon 只监听本地 socket，要求同用户；不监听网络。
- 不提供沙箱；扩展代码与工具以用户权限运行。
- 凭据只由 `CredentialStore` 管理；不进入配置、会话记录、导出或日志。
- `WorkspaceAccess` 限制路径在工作区内；不跟随工作区外符号链接。
- 模板初始化脚本由 `ExecHost` 执行，属于用户显式确认的动作。
- 会话导出可能包含敏感内容，由用户决定是否导出。
- 不实现包的安装/安装脚本拦截；安装由 npm/git 负责。

### 8.4 错误处理与日志

```ts
class PiscesError extends Error {
  readonly code: string;
  readonly data?: JsonValue;
  readonly cause?: unknown;

  constructor(
    code: string,
    message: string,
    options?: { data?: JsonValue; cause?: unknown }
  ) {
    super(message);
    this.name = "PiscesError";
    this.code = code;
    this.data = options?.data;
    this.cause = options?.cause;
  }
}
```

- 领域错误使用稳定错误码；协议错误映射见 §3.9。
- `ToolDeniedError` 单独表示工具拒绝，转为工具结果而非进程错误。
- 请求级错误返回 `Response.error`；turn 内异步错误进入 `turn.ended.error`。
- 日志为结构化记录，至少包含时间、级别、会话 id、turn id 与错误码。
- 日志默认不记录提示词正文、工具参数、凭据或供应商密钥。
- CLI 输出用户可读消息；`--json` 输出结构化结果；错误码保留。
- 不吞掉存储错误；不把损坏记录静默跳过。

### 8.5 可测试性

- 核心层不依赖文件系统、网络与协议；`SessionRepository`、`Exec`、`Credentials`、`ExecuteProvider` 均可注入替身。
- `Sessions`、`Context` 通过注入的 `now`、`newId` 与仓库实现测试，时间与 id 可确定。
- `Tools` 用内存注册表与假工具测试包装、错误与并行；包装器顺序无关。
- `AgentLoopDriver` 用假 `LLMAdapter`、假 `ExecuteProvider`、假 `Context` 测试 turn/step、取消与 steer。
- 协议层用内存连接测试分帧、握手、响应/事件交错与错误码。
- 服务层用临时目录、假 socket 与假 provider 测试 `SessionStore`、`Gateway`、恢复与迁移。
- 不做真实供应商网络测试；供应商方言由适配器单测覆盖。
- 测试不依赖具体时钟、随机 id 或执行顺序。

### 8.6 构建与分发

- pnpm 工作区；`tsc -b` 构建 `protocol`、`core`、`daemon`。
- Node 版本遵循根 `package.json`；ESM。
- 内置扩展随产品放在 `extensions/builtin`；外部扩展为普通 npm 包或目录。
- TypeScript 加载器随宿主分发，负责 `.ts`/`.tsx` 转译与 `@pisces/*` 映射。
- 客户端作为扩展包的一部分分发，经协议连接 daemon。
- 扩展依赖安装在其自身目录；安装与更新由 npm/git 完成。
- 版本号遵循 semver；协议版本与包版本独立。
- daemon 升级会断开旧连接；客户端重连后重新握手。

### 8.7 兼容性

- 协议主版本不同拒绝连接；次版本向下兼容。
- 会话 `schemaVersion` 与协议版本独立；旧会话迁移见 §7.3。
- 扩展接口版本与宿主版本独立；不兼容扩展在发现阶段标记不可用。
- 废弃字段与命令先标记、后移除；移除前至少保留一个次版本。
- 不保证旧版本 daemon 能读取新版本写入的记录；新版本读取旧记录按迁移规则处理。

### 8.8 与 HLD 的对齐

当前详细设计与 HLD 无已知待对齐项。运行时标记与 `session.create` 默认值已写入 HLD §7.2、§8.1、§6.1、§6.8。

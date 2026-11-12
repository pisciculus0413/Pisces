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
  name: EntryName;         // package#name，不是条目 id
  arguments: JsonValue;    // 已解析的工具参数
}

interface WireToolCall {
  id: string;
  name: string;            // provider 安全名，仅在 adapter 边界使用
  arguments: JsonValue;
}

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  code?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | ({ type: "toolCall" } & ToolCall)
  | {
      type: "toolResult";
      toolCallId: string;
      content: ContentBlock[];
      isError?: boolean;
      code?: string;
      synthetic?: "interrupted";
    };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

type StopReason = "stop" | "toolCall" | "length" | "contentFilter" | "cancelled" | "error";
```

- `ToolCall.id` 与 `SessionNode.id`、条目 id 无关；它只用于把工具结果关联回调用。
- 记录中的 `ToolCall.name` 始终是 `EntryName`；`WireToolCall` 只出现在 `parseChunk` 边界，driver 落盘前转换回 `EntryName`。
- `toolCall.arguments` 统一为已解析的 `JsonValue`；方言驱动负责把供应商返回的参数字符串解析为该值。
- `toolResult.toolCallId` 必须对应同一次工具调用的 `ToolCall.id`。
- `code` 保存 `tool.denied`/`tool.failed`；`synthetic="interrupted"` 表示恢复时合成的“结果未知”结果，不表示工具实际失败。
- `reasoning` 只保存文本；供应商专用签名或加密内容不进入通用类型。
- `Message` 不带 `sessionId`、`nodeId`；这些是会话记录层字段。

### 2.3 控制消息载荷

控制消息的 `role` 决定载荷 schema。载荷放在一个 `text` 块中：

```ts
interface DefinitionSnapshot {
  name: EntryName;
  kind: "tool" | "wrapper";
  description: string;
  parameters: JsonObject;
  configHash?: string;      // wrapper 合并配置的哈希
  definitionHash: string;
}

interface DeclarationPayload {
  toggle: EntryName[];
  definitions?: DefinitionSnapshot[];
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
- 任何把 tool/wrapper 条目从关闭变为启用的 declaration 必须携带该条目的 definition；缺失按 `storage.corrupt` 处理。
- definition 由 daemon 从当前清点附加；客户端只提交 `toggle` 名称，内联 definition 被拒绝。
- `declaration` 只表达选择状态与定义快照，不表达包装器或条目的执行顺序。
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
  source: string;          // 来源标识：条目名、instruction、create 等
  synthetic?: "interrupted";
  createdAt: string;
  schemaVersion: number;
}

interface QueueEntry {
  id: QueueEntryId;        // 仅在队列阶段有效
  kind: "agent" | "control";
  role: "system" | "user" | "assistant" | "tool" | "declaration";
  content: ContentBlock[];
  source: string;
  confirmedAt?: string;    // 服务端在 turn.start 置位
  createdAt: string;
}

type QueueEntryInput = Omit<QueueEntry, "id" | "createdAt" | "confirmedAt">;
type SelectionState = EntryName[];
```

- `SessionMeta` 不包含活动分支、`status`、`systemPrompt`、扩展选择或运行状态。
- `SessionNode` 只追加，不删除；每个节点都有父指针；根节点的 `parentId` 等于自身。
- `kind` 与 `role` 必须匹配：
  - `agent`：`system`、`user`、`assistant`、`tool`；
  - `control`：`declaration`、`compaction`、`cancel`。
- `instruction` 是 `source` 的取值，用于用户创建的 `role=system` 消息。
- `QueueEntry.id` 由 `Context` 在入队时分配，出队后作废；不写入 `SessionNode`，不保存已装配 id 墓碑。所有不在当前队列中的 id（含已出队、已删除）统一返回 `queue.entry_not_found`。
- `QueueEntry.confirmedAt` 由服务端 `turn.start` 写入，客户端不能提交。
- `QueueEntry` 不包含 `parentId`、`schemaVersion`；入队时不能由客户端指定 `id`、`createdAt`、`confirmedAt`。
- `SelectionState` 是已启用条目名称的集合表示，去重后按字典序排列；名称为 `package#name`，不使用动态 id。

### 2.5 条目与协议公共类型

```ts
interface EntryInfo {
  type: "tool" | "wrapper" | "skill" | "context";
  source: string;
  name: EntryName;         // package#name
  description?: string;
  definition?: DefinitionSnapshot;
  definitionHash?: string;
}

interface EffectiveEntry {
  name: EntryName;
  definitionHash?: string;
  configHash?: string;
  stale: boolean;
}

// entries.snapshot 的协议投影（Task 9 实现的契约）
interface EntrySnapshot {
  name: EntryName;
  kind: "tool" | "wrapper" | "skill" | "context";
  description?: string;
  parameters?: JsonObject;
  definitionHash?: string;
  configHash?: string;
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
  conflicts: string[];
  initScript?: { command: string; args: string[]; timeoutMs: number };
}

interface ProjectRef {
  id: string;
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
- `TemplatePreview.initScript.timeoutMs` 是该模板脚本的单次上限（缺省 `60_000`，范围
  `1..600_000`）；预览一并展示。

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
- `Request.id` 在同一条连接内由客户端保证唯一；服务端按原样回传。无法关联请求的协议错误使用 `id: ""` 哨兵，不回显原始输入。
- 事件不带 `id`；事件按连接推送。
- 本阶段线上错误对象只输出 `code` 与 `message`；DDS 中出现的 `ProtocolError.data` 与 `data.*` 字段属于后续目标设计，当前 `Gateway` 安全映射不输出结构化 `data`。
- 错误消息不得包含凭据、请求头或供应商密钥。

## 3 协议层

### 3.1 传输与分帧

- 本阶段传输仅支持 Linux Unix domain socket（`<dataDir>/run/pisces.sock`，权限 `0600`）；Windows 命名管道与 macOS 为目标设计，尚未实现。非 Linux 平台在导入原生绑定、绑定 socket 之前以 `daemon.unsupported_platform` 失败。
- 连接在读取任何协议字节前，由原生 `getsockopt(SOL_SOCKET, SO_PEERCRED)` 取内核 peer UID 并与 `process.geteuid()` 比较；不一致只销毁该连接，不发送协议字节。没有 chmod-only 或未认证回退。
- 使用 NDJSON：一条 UTF-8 JSON 对象占一行，以 `\n` 结束；请求、响应和事件共用同一连接。仅字面 `LF` 分帧，`\r` 保留在帧内，不作为分隔符。
- 上限按方向定义：
  - `MAX_ENTRY_BYTES = 256 KiB`
  - `MAX_NODE_CONTENT_BYTES = 256 KiB`
  - `MAX_QUEUE_BYTES = 1 MiB`
  - `MAX_RESPONSE_BYTES = 4 MiB`
  - `MAX_EVENT_BYTES = 4 MiB`
  - `MAX_FRAME_BYTES = 8 MiB`
- 关系为 `MAX_ENTRY_BYTES ≤ MAX_NODE_CONTENT_BYTES < MAX_QUEUE_BYTES < MAX_RESPONSE_BYTES = MAX_EVENT_BYTES < MAX_FRAME_BYTES`。
- 请求帧、响应帧、事件帧分别受 `MAX_FRAME_BYTES` 限制；发送侧保证响应不超过 `MAX_RESPONSE_BYTES`、事件不超过 `MAX_EVENT_BYTES`。完整选择事件不得分片；累计选择导致待发送事件超限时，C 段写库前以 `context.selection_too_large` 原子拒绝（§4.2.7）。
- 队列大小按完整 `QueueEntry` JSON 的 UTF-8 字节计：单条上限 262144，完整队列数组（含数组标点）上限 1048576；分别返回 `queue.entry_too_large`、`queue.too_large`。入队、编辑及确认均先计算完整候选队列，再原子替换；队列和声明不静默截断。
- `Context` 的 `session.updated` 按完整 `EngineEvent` JSON 的 UTF-8 字节预算 4194304 拆为多个事件，每帧独立分配 `seq`；客户端按 `id`/`parentId` 合并。队列与选择通知各按最终状态发布一次。
- 来源/技能单节点 `content` JSON 的 UTF-8 字节上限为 262144：仅截断 `text`/`reasoning`（包括 `toolResult` 内文本），保留 Unicode code point 边界，末尾追加可见标记 `\n[truncated]`；`toolCall.arguments` 永不截断。文本安全截断后 `content` 仍超过 262144 字节，以 `context.source_failed` 失败，不允许原样保留 256 KiB 至 4 MiB 的不可裁内容，不写入半截节点。
- 供应商输出独立采用 `MAX_NODE_CONTENT_BYTES` 文本裁剪目标，仅截断上述文本并追加可见标记，保留 code point 边界；`toolCall.arguments` 永不截断。不可裁字段可保留，但必须在写库前验证包含该完整节点的单节点 `session.updated` EngineEvent JSON 的 UTF-8 大小不超过 4194304 字节（包括节点字段与事件封装），超限以 `provider.invalid_response` 失败；不能只检查裸 `content`，也不能通过批次拆分或节点分片规避上限。
- 不支持在 JSON 对象内嵌裸换行；字符串内的换行必须转义。
- 客户端可以在同一连接上并发发送多个请求；响应通过 `id` 关联。
- 事件可以与响应交错；客户端不得依赖事件与某个响应的固定先后顺序。
- 连接建立后，任何业务方法成功分派前必须完成 `protocol.hello`；在此之前收到其他请求返回 `protocol.hello_required`，该请求被拒绝但连接仍可随后完成握手。重复 hello 返回 `protocol.invalid_request`。

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
- 服务端选择主版本相同、次版本不高于服务端、优先级最高的版本；没有可用版本时返回 `protocol.version_mismatch` 错误响应，刷出该响应后关闭连接（最多等待 1 秒），不再发送独立事件。
- 成功时 `compatible` 恒为 `true`；失败不返回 `HelloResult`。
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
| `entries.snapshot` | `{ sessionId }` | `{ entries: EntrySnapshot[]; selection: SelectionState; effective: EffectiveEntry[] }` |
| `template.list` | `{}` | `{ templates: TemplateInfo[] }` |
| `template.preview` | `{ templateId, workspace }` | `TemplatePreview` |
| `template.apply` | `{ templateId, workspace, confirmed: true, overwrite? }` | `{ projectId, sessionId }` |
| `client.list` | `{}` | `{ clients: ClientRegistration[] }` |
| `client.start` | `{ id }` | `{ pid: number }` |

- 当前阶段实际路由的 `Gateway` 方法为 `session.create`、`session.list`、`session.read`、`session.configure`、`queue.enqueue`、`queue.edit`、`queue.remove`、`queue.clear`、`entries.snapshot`、`template.list`、`template.preview`、`template.apply`、`turn.start`、`turn.cancel`、`turn.list`、`provider.list`、`client.list`、`client.start`，以及仅在请求带连接上下文时路由的 `session.subscribe`/`session.unsubscribe`；`protocol.hello` 由连接分发器处理，不进入 `Gateway`。`template.*` 仅在宿主装配了 `TemplateStore`（`startDaemon({ templates })`）时路由，未装配时返回 `protocol.unknown_method`；`client.*` 在宿主未注入 `ClientRegistry` 时同样返回 `protocol.unknown_method`，`startDaemon` 总是注入（无扩展源时列表为空）。不带连接上下文调用 `session.subscribe`/`session.unsubscribe` 仍返回 `protocol.unknown_method`。
- 方法分派只查自有属性：未识别的方法名（包括 `constructor`、`toString`、`__proto__`、`valueOf` 等原型属性名）一律返回 `protocol.unknown_method`，不会落回任何处理函数。

### 3.4 会话方法

#### 3.4.1 `session.create`

```ts
interface CreateSessionParams {
  workspace?: string;
  templateId?: string;
  model?: string;
  provider?: string;
  systemPrompt?: string[];
  extensions?: EntryName[];
}
```

- 服务层创建临时 `SessionMeta`、`Context` 与空消息队列；不写盘，不进入 `session.list`。
- `systemPrompt` 的每个元素生成一条 `kind=agent`、`role=system`、`source="create"` 的队列条目；不写入 `SessionMeta`。
- `extensions` 是显式启用条目 `package#name` 列表：
  - 省略：使用配置中的默认选择；
  - 空数组：不启用任何条目；
  - 显式列表：替换默认选择，不与默认值合并。
- `extensions` 生成一条 `kind=control`、`role=declaration` 的队列条目，`toggle` 为所选名称；所选为空时不生成。
- 目录驱动模式（`startDaemon({ extensions })`）下，daemon 在入队时用冻结清点为每个 toggle 名称附加完整定义快照（all-toggle snapshots：打开与关闭都携带；仅有内容证据且关闭名称的例外不附加新类型快照），客户端只提交 `toggle`。非空列表在创建临时会话与运行时之前整体校验：未知名称、内联 definitions 或类型变化冲突以 `queue.invalid_control` 拒绝，重复名称以 `queue.duplicate_name` 拒绝；失败不创建会话、不写队列。无扩展模式（手动注入）仍拒绝任何有效的 `extensions`（`queue.invalid_control`），空列表不生成声明条目。`templateId` 的语义见下条。
- `workspace` 显式提供时直接使用；省略时读取全局配置中的 `defaultWorkspace`。两者都没有返回 `session.workspace_required`；路径不存在、不是目录或不可写返回 `session.invalid_workspace`。默认工作区必须是绝对路径，不自动创建；不读取 daemon 工作目录。工作区配置 `.pisces/config.json` 不参与默认工作区解析。
- `provider`/`model` 只能成对出现：两者均省略时取配置中的 `defaults.provider`/`defaults.model`；只提供一个，或默认值不完整，返回 `session.model_required`；显式组合或默认组合不在 `provider.list` 中，返回 `session.invalid_model`。
- `templateId` 只用于解析模板级初始配置，作为显式字段之下的默认值（`provider`/`model`/`extensions`/`systemPromptFile`）；显式 `systemPrompt` 存在时抑制模板提示词。模板提示词以 `source="template"` 入队。不创建目录、不写文件、不执行脚本；工作区初始化只能经 `template.preview`/`template.apply`。宿主未装配 `TemplateStore` 时返回 `protocol.invalid_request`；未知模板 `template.not_found`；提示词文件不可读 `template.invalid`。
- 返回临时 `SessionMeta`，客户端通过 `session.read` 取得队列。

#### 3.4.2 `session.list`

- 无参数；只返回已落盘会话的 `SessionMeta`。
- 临时会话不出现。
- 返回顺序不构成协议契约；客户端自行按 `createdAt` 排序。

#### 3.4.3 `session.read`

```ts
interface SessionReadParams {
  sessionId: SessionId;
  nodeId?: NodeId;
  limit?: number;          // 本页序列化字节预算，至少返回 1 条
  cursor?: NodeId;         // 上一页最后一个节点 id
}

interface SessionReadResult {
  meta: SessionMeta;
  seq: number;
  records: SessionNode[];
  queue: QueueEntry[];     // 仅首屏返回
  selection: SelectionState; // 仅首屏返回
  nextCursor?: NodeId;
}
```

- 无 `nodeId`：`records` 为完整会话树，按追加顺序扁平返回；有 `nodeId`：`records` 为该节点到根的线性分支，按根到该节点排列。
- `limit` 按序列化字节计，至少返回 1 条；`cursor` 是上一页最后一个节点 id；`nextCursor` 缺省表示结束。
- `queue`/`selection` 只在首屏返回；后续页为空，避免分页响应超帧。
- `seq` 是本页读取时刻的会话事件序号。只有首屏 `seq` 用作初始状态水位；后续页不得推进事件去重水位。客户端先缓存订阅事件，取得首屏后按序应用高于首屏水位的事件；后续页仅按节点 id 合并 records，不覆盖首屏或事件更新后的 meta/queue/selection。分页期间新增节点由事件与分页结果按 id 去重。
- 临时会话没有节点：`records` 为空、`selection` 为空数组；带 `nodeId` 返回 `session.node_not_found`。
- `session.read` 不改变活动分支，不是 turn 启动；读取在同一会话锁内完成。

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
- 活跃 turn 使用启动时的模型与供应商；运行期间不允许 `session.configure`。
- 若存在活跃 turn，整个 `session.configure` 返回 `turn.active`，不更新 `model`/`provider`、队列或会话记录；不做部分更新。
- `systemPrompt` 只操作消息队列：
  - 已有 `source="instruction"` 队列条目：更新该条目；
  - 没有：新增一条 `kind=agent`、`role=system`、`source="instruction"` 的队列条目；
  - 不写 `SessionMeta`，不修改会话记录。
- `session.configure` 不接受扩展选择；扩展选择只能通过声明类控制消息改变。
- 返回更新后的 `SessionMeta`。
- 队列变化推送 `queue.updated`。

#### 3.4.5 `session.subscribe` / `session.unsubscribe`

- `session.subscribe`/`session.unsubscribe` 仅在请求带连接上下文时路由；不带连接上下文时与未识别方法一样返回 `protocol.unknown_method`。
- 订阅在校验会话（含内存中的临时会话）后才安装，且与 `session.read` 快照使用同一会话锁；成功响应发出前订阅已生效，因此事件与响应可以交错。
- 成功订阅后，该连接接收该会话的已知事件：`session.updated`、`queue.updated`、`selection.updated`、`turn.started`、`turn.delta`、`turn.step`、`turn.ended` 与 `turn.cleanup_failed`。
- 事件推送不等待 socket I/O：单个连接的编码或入队失败只关闭该连接并解除其订阅，不使已提交 turn 的 EventBus 发布失败。

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
- 订阅成功后，该连接接收该会话的 `session.updated`、`queue.updated`、`selection.updated` 与 turn 事件（含 `turn.delta`）。
- `session.unsubscribe` 只移除当前连接的该会话订阅，重复调用幂等，不发送事件。
- 连接断开自动清除该连接的全部订阅。
- 退订或断开连接不中止活跃 turn，不影响其他客户端。
- 订阅不重放历史事件；客户端应先 `session.subscribe`，再 `session.read` 取得初始快照，并按节点 id 与 `seq` 去重。

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

- `queue.enqueue` 只入队，不确认，不写会话记录；在会话锁内加载或复用运行时并 `initialize`，再委托 `Context.enqueue`，返回 `{ ids }` 并按最终队列推送 `queue.updated`。整批请求要么全部入队，要么队列保持不变。
- 大小限制沿用核心错误码：条目超过 `MAX_ENTRY_BYTES` 返回 `queue.entry_too_large`，完整队列超过 `MAX_QUEUE_BYTES` 返回 `queue.too_large`。
- `queue.enqueue` 只接受 agent/system/user/assistant/tool 与 `role=declaration`；`compaction`、`cancel` 由运行框架写入，客户端提交返回 `queue.invalid_control`。
- `declaration` 必须由 daemon 附加 definition；客户端内联 definition 被拒绝。`Context.enqueue` 是内部可信边界，接受已附完整 definitions 并校验结构，不从实时 Tools 重新获取定义。
- 当前目录驱动模式下，客户端提交的 `kind=control`/`role=declaration` 在同一会话锁内被同步富化（为每个 toggle 名称附加完整定义快照；仅有内容证据且关闭名称时不附加新类型快照）后一次入队；未知名称、内联定义或类型冲突返回 `queue.invalid_control`，重复名称返回 `queue.duplicate_name`，失败时整批不改变队列。无扩展的手动注入模式仍一律以 `queue.invalid_control` 拒绝客户端控制条目。
- 队列按入队顺序排列；不提供重排方法。
- `queue.edit` 已路由：Core 内部编辑未确认的 `kind=agent` 条目，已确认时抛 `queue.entry_locked` 并在内部 `PiscesError.data` 带 `reason="confirmed"`；本阶段线上响应不透传 `data`；对 `declaration` 条目返回 `queue.invalid_control`。
- `queue.remove` 可删除任意尚未装配的条目，包括已确认未装配条目。
- `queue.clear` 清除全部尚未装配条目并返回完整 ids；有活跃 turn 时整个请求返回 `turn.active`，不部分清除。
- 所有不在当前队列中的 id（包括已装配、已删除）在 `edit`/`remove` 时返回 `queue.entry_not_found`；不保留已装配 id 墓碑。
- 控制消息入队时校验 `role` 与载荷：
  - `declaration`：`toggle` 为名称数组，名称重复以 `queue.duplicate_name` 拒绝；definition 完整；
  - `compaction`、`cancel` 不由客户端入队。
- 每次队列变化后推送 `queue.updated`，载荷为当前完整 `QueueEntry[]`，包含 `confirmedAt`；队列总量受 `MAX_QUEUE_BYTES` 限制，保证整帧发送。
- 多客户端并发写由服务层按会话串行化，最后写入者获胜。

### 3.6 条目与 turn 方法

#### 3.6.1 `entries.snapshot`

- 返回当前可用的工具、包装器、技能、上下文来源的 `entries`，以及本会话已固化定义的 `effective` 列表；`selection` 按默认分支计算。
- `entries` 是`EntrySnapshot` 投影：只有 `name`、`kind`、`description?`、`parameters?`、`definitionHash?`、`configHash?`，供确认前审查；不含条目路径、配置正文或 `execute`。
- `effective` 含 name、`definitionHash`、`configHash`、stale；内容条目只有 name 与 stale。
- `selection` 不包含队列中尚未装配的声明 delta；客户端按队列叠加。
- 临时会话返回可用条目和空 `selection`。
- `providers`、`clients` 不进入结果。
- 条目名称采用 `package#name`，跨包同名不冲突。
- 响应按 `{id, result}` 的 JSON UTF-8 字节数与 4 MiB 预算比较；超限返回固定文案的 `protocol.frame_too_large`，不关闭连接，后续请求仍可处理。

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

- `turn.start` 在同一会话锁内完成：读取 activeTurn、校验参数、确认当前队列、注册 turn；任一步失败不置确认状态。
- 无活跃 turn：
  - 启动新 turn，`mode` 为 `new`；
  - `nodeId` 仅对已落盘会话有效，用于选择新 turn 的分支起点；
  - 省略 `nodeId` 时从默认分支继续；
  - 临时会话带 `nodeId` 返回 `session.node_not_found`；
  - 首次 turn 必须产生至少一个最终可见的 `kind=agent` 消息（仅 user 也有效，无需 system），否则以 `turn.ended.error` 返回 `turn.empty`，不落盘。
- 已有活跃 turn：
  - `turn.start` 只确认当前未确认条目，作为 steer 在下一个 step 边界装配；
  - 不启动第二个 turn，`mode` 为 `steer`；
  - 不得带 `nodeId`，否则返回 `turn.node_id_forbidden`；
  - 返回已有 turn 的 `turnId`。
- 已有登记的 turn 但运行时处于 `cleanup`/`cleanup_failed`（`turn.ended` 之后、标记尚未删除）：返回 `turn.active`，不确认队列、不 steer、不改写标记。
- 并发 `turn.start` 由服务层按会话串行化；后到者按 steer 处理。

#### 3.6.3 `turn.list` / `turn.cancel`

- `turn.list` 返回当前活跃 turn 快照；会话是否在运行由成员资格表示。
- `turn.cancel` 按 `turnId` 中止当前供应商流：
  - 正在执行的工具不被强制终止；`ToolInvocationContext.signal` 置为中止；
  - 中止后不再发起新 step，当前工具结果回填后结束；
  - 已产生的回复与控制消息写入会话并标记中断；
  - 清除尚未装配条目的 `confirmedAt`，用户需重新确认；
  - 找不到活跃 turn 时返回 `{ cancelled: false }`。
- `{ cancelled: true }` 只表示取消请求已交给登记的 turn，不表示 turn 已结束；turn 仍登记且运行时为 `running` 时每次调用都返回 `true`，但取消 handle 至多执行一次。
- turn 已进入 `cleanup`/`cleanup_failed`（包括 `turn.ended` 之后、标记清理之前），或未知、已注销时返回 `{ cancelled: false }`，不再触发取消 handle。
- 忽略中止的 driver 保持 `running` 并被 `turn.list` 列出，同会话新 turn 被阻塞，直到自然结束或重启恢复。
- 连接断开或 `session.unsubscribe` 不触发中止。

### 3.7 供应商、模板与客户端方法

#### 3.7.1 `provider.list`

- 返回 `ProviderInfo[]`，只包含协议展示所需字段。
- 不返回 `dialect`、`baseUrl`、`auth`、`headers`。
- `ready` 由凭据状态计算；空模型清单合法，此时 `models=[]` 且 `ready=false`。
- 模型选择单位是 `(provider, model)`。
- 本阶段的消费方是 CLI `provider list` 与 `models list`；两者都不新增协议方法、不改变路由或 daemon
  行为。`provider list` 逐行输出 `id  ready|unready  models=<n>`，`--json` 原样输出 `{providers}`；
  `models list` 在 CLI 侧展平为 `{provider, ...model}`（provider 按 `id` 字典序，模型保持本方法
  返回的顺序），`--provider <id>` 只保留该 provider。两个命令都列出全部 provider，不按 `ready`
  过滤；`pricing` 只出现在 `--json` 输出里（`provider list --json` 的 `models[]` 与
  `models list --json`），人类模式从不输出。
- `models list --provider <id>` 的 id 不在清单中时，`provider.not_found` 由 CLI 本地产生（见 §3.9），
  不通过本方法返回。

#### 3.7.2 模板方法

- `template.*` 仅在宿主装配了 `TemplateStore` 时路由（`startDaemon({ templates: { configDir } })`）；未装配时返回 `protocol.unknown_method`。
- `template.list` 返回 `{ templates: TemplateInfo[] }`，不返回文件内容；每次重新扫描模板目录，无效模板不出现。
- `template.preview` 返回将创建的目录、文件（含内容）、冲突列表与可选的初始化脚本（含 `timeoutMs`）；无副作用，不创建或要求工作区。
- `template.apply` 必须带 `confirmed: true`，否则在读写前返回 `protocol.invalid_request`；存在冲突且未带 `overwrite: true` 时返回 `template.workspace_conflict`。
- `template.apply` 流程前两步只读，任何失败都不写盘：
  1. 解析模板与工作区并计算冲突；
  2. 预检会话配置：provider/model（模板配置优先于宿主默认值；缺失 `session.model_required`，未注册 `session.invalid_model`）与 extensions（无扩展模式下非空即 `queue.invalid_control`）；
  3. 由 `WorkspaceAccess` 创建目录与文件；
  4. 由 `ExecHost` 执行 `initScript`（如有），使用模板的 `timeoutMs`；非零退出、超时或启动失败返回 `template.init_failed`；
  5. 读取 `systemPromptFile` 内容；
  6. 原子追加一条 `ProjectRef` 到 `projects.json`（损坏 `storage.corrupt`，写入失败 `storage.io`）；
  7. `Gateway` 用解析结果创建临时会话并返回 `{ projectId, sessionId }`；会话在首次 `turn.start` 前不落盘。
- 模板配置只映射会话初始值：`provider`/`model`、`extensions`、`systemPromptFile`；`extensions` 替换默认选择，提示词以 `source="template"` 入队，不直接写入请求体。
- 初始化脚本失败时返回 `template.init_failed`，不创建会话、不写 `ProjectRef`；已创建文件不自动回滚。

#### 3.7.3 客户端方法

- `client.list` 返回已注册客户端（`id`、`source`、`entry`），不返回进程状态，不校验会话。
- `client.start` 要求 `id` 为非空字符串，否则 `protocol.invalid_request`；未注册返回 `client.not_found`；启动失败返回 `client.launch_failed`；成功返回 `pid`。
- 注册来源只有内置扩展目录与 `<configDir>/extensions`；每次请求重新读取清单，不加载扩展代码。
- 启动时通过环境变量传入 daemon socket 路径（`PISCES_SOCKET_PATH`）与客户端 id（`PISCES_CLIENT_ID`）。
- 客户端进程的 stdout/stderr 不进入协议流；daemon 不跟踪已启动进程。

### 3.8 事件

```ts
interface SessionUpdatedEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  nodes: SessionNode[];
  meta?: SessionMeta;
}

interface TurnStartedEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  turnId: TurnId;
  startedAt: string;
}

interface TurnDeltaEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  turnId: TurnId;
  step: number;
  kind: "text" | "reasoning";
  delta: string;
}

interface TurnStepEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  turnId: TurnId;
  step: number;
  stopReason: StopReason;
  usage?: Usage;
}

interface TurnEndedEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  turnId: TurnId;
  reason: "completed" | "cancelled" | "failed";
  endedAt: string;
  error?: { code: string; message: string };
}

interface QueueUpdatedEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  queue: QueueEntry[];
}

interface SelectionUpdatedEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  selection: SelectionState;
}

interface TurnCleanupFailedEvent {
  sessionId: SessionId;
  seq: number;
  at: string;
  turnId: TurnId;
  code: "storage.io";
  message: string; // 固定安全文案，不包含原始异常
}

type ProtocolEvent =
  | Event<SessionUpdatedEvent> & { event: "session.updated" }
  | Event<TurnStartedEvent> & { event: "turn.started" }
  | Event<TurnDeltaEvent> & { event: "turn.delta" }
  | Event<TurnStepEvent> & { event: "turn.step" }
  | Event<TurnEndedEvent> & { event: "turn.ended" }
  | Event<QueueUpdatedEvent> & { event: "queue.updated" }
  | Event<SelectionUpdatedEvent> & { event: "selection.updated" }
  | Event<TurnCleanupFailedEvent> & { event: "turn.cleanup_failed" };
```

事件规则：

- `turn.delta` 在 parser 产生 text/reasoning 增量时发布，step 从 1 开始；每帧仅包含本次新增文本，按解析顺序发送，按事件字节预算拆分且不截断 UTF-8 字符。不发送未解析完成的工具参数。
- 增量仅供临时展示，不表示已持久化，不重放；客户端按 turnId/step/kind 累积。对应 `session.updated` 的 assistant 节点为最终记录，应替换临时展示，避免重复；失败或取消时仅已成功落盘内容作为最终记录，turn.ended 后清除剩余临时展示。

- 每会话单调 `seq` 在同一会话锁内分配；`session.read` 与所有会话事件携带 `seq`，客户端丢弃小于已应用值的旧事件；分页响应仅首屏建立水位，后续页不提升水位（§3.4.3）。
- `session.updated` 携带本批追加节点；超过事件字节预算时拆分为多个事件；`meta` 变化时 `nodes` 可为空。
- `queue.updated` 携带当前完整队列；客户端整体替换本地队列。
- `selection.updated` 携带已持久化记录的完整名称集合，不分片；若本次写入需通知的新集合超过双封装事件预算，在 C 段写库前以 `context.selection_too_large` 原子拒绝（§4.2.7）。队列声明 delta 通过 `queue.updated` 传递，客户端自行叠加。
- `turn.started` 在首次 assemble 之前发布，且不携带 `mode`；`mode` 只在 `TurnStartResult` 中出现。
- `turn.step` 的 `step` 从 1 开始；`usage` 在供应商提供时出现。
- `turn.ended.reason` 为 `failed` 时带 `error`；线上 `error` 只含白名单 code 与固定安全文案（当前保留 `turn.empty`），其余 code 统一替换为 `internal.error` 与固定文案，绝不透传 adapter/供应商提供的原始 code、message、cause 或任意附加字段。`completed`/`cancelled` 的 `error` 即使存在也丢弃。
- `turn.cleanup_failed` 在 `turn.ended` 之后、标记删除失败时发布，携带 `turnId`、固定 `code="storage.io"` 与固定安全文案；不携带原始异常、cause 或任意细节，也不表示 turn 已注销：标记与登记项仍会阻塞同会话新 turn，直到重启恢复。
- 本阶段只转发上列八个会话事件。
- `Gateway` 把引擎事件投影为线上事件 `{ event: type, data: { sessionId, seq, at, ...payload } }`；`sessionId`、`seq`、`at` 以引擎事件为准，payload 中的同名键被丢弃。`turn.ended` 与 `turn.cleanup_failed` 例外：二者按固定字段显式构造，校验 `turnId`、`reason`、`endedAt` 等字段并丢弃所有其他附加字段。未知事件类型或缺失/非法路由字段的事件被忽略。
- 事件只发送给订阅该会话的连接。
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
| 内部 | `internal.error` | `Gateway` 捕获未分类异常；固定文案，不输出 cause |
| daemon | `daemon.unsupported_platform` | 非 Linux 平台，在导入原生绑定与绑定 socket 前失败 |
| daemon | `daemon.native_unavailable` | 原生绑定缺失或加载失败 |
| daemon | `daemon.peercred_probe_failed` | 启动时原生 peer 凭据自检失败 |
| daemon | `daemon.lock_busy` | 锁文件已被其他进程持有 |
| daemon | `daemon.lock_failed` | 锁文件无法获取（释放失败归入 `daemon.stop_incomplete`） |
| daemon | `daemon.insecure_directory` | 数据目录或运行目录不安全 |
| daemon | `daemon.socket_live` | 现有 socket 不可安全移除 |
| daemon | `daemon.socket_path_too_long` | socket 路径编码超过 107 字节 |
| daemon | `daemon.start_failed` | 其他启动失败；不含原始原生 errno/cause |
| daemon | `daemon.stop_incomplete` | 停止未完成；保留锁、标记与 `quiescing` 状态，可重试 |
| 会话 | `session.not_found` | 会话不存在 |
| 会话 | `session.model_required` | 未提供且无默认模型 |
| 会话 | `session.invalid_model` | provider/model 不在清单中 |
| 会话 | `session.workspace_required` | 未提供且未配置默认工作区 |
| 会话 | `session.invalid_workspace` | 工作区不存在、不是目录或不可写 |
| 会话 | `session.node_not_found` | `nodeId` 不属于该会话 |
| 队列 | `queue.entry_not_found` | id 不在当前队列中，包括已出队或已删除 |
| 队列 | `queue.entry_locked` | 已确认条目不能编辑；内部 `PiscesError.data.reason="confirmed"` 不透传到线上（`queue.clear` 在活跃 turn 时返回 `turn.active`） |
| 队列 | `queue.invalid_control` | 控制消息载荷不合法或客户端提交 compaction/cancel |
| 队列 | `queue.duplicate_name` | `toggle` 中名称重复 |
| 队列 | `queue.entry_too_large` | 单条队列入队内容超过 `MAX_ENTRY_BYTES` |
| 队列 | `queue.too_large` | 队列总量超过 `MAX_QUEUE_BYTES` |
| turn | `turn.node_id_forbidden` | 活跃 turn 的 `turn.start` 带 `nodeId` |
| turn | `turn.active` | 活跃 turn 中调用 `session.configure` |
| turn | `turn.empty` | 最终无任何可见 kind=agent 消息；通过 turn.ended.error 表达 |
| 上下文 | `context.selection_too_large` | 待提交完整选择集合的 EngineEvent 或对应协议封装超过 4 MiB；写库前原子拒绝 |
| 上下文 | `context.source_failed` | 上下文来源/技能解析失败或文本安全截断后 content 仍超过 256 KiB |
| 上下文 | `context.changed` | 声明选择或默认 head 在一次重跑后仍变化；内部 `PiscesError.data.retryable=true`，不透传到线上 |
| 上下文 | `context.pending_commit` | 提交结果仍无法读清时尝试其他修改；内部 `PiscesError.data.retryable=true`，不透传到线上 |
| 上下文 | `context.window_exceeded` | 裁剪后仍超出模型窗口 |
| 存储 | `storage.io` | 持久化 I/O 失败 |
| 存储 | `storage.corrupt` | 记录、meta 或 definition 损坏 |
| 事件 | `event.publish_failed` | 同步 EventBus handler 抛错；已提交节点、队列状态、head 推进与已分配 `seq` 保留并允许序号空洞，不重试或回滚；driver 中作为终态 turn 错误 |
| 供应商 | `provider.transport` | 网络/传输错误 |
| 供应商 | `provider.timeout` | 单次请求尝试超时 |
| 供应商 | `provider.invalid_response` | HTTP 非 2xx 状态、请求 URL/headers 无效、响应无法解析；文本安全截断后完整单节点事件仍超过 4 MiB（写库前失败） |
| 供应商 | `provider.refusal` | 供应商拒绝 |
| 工具 | `tool.failed` | 工具执行失败 |
| 工具 | `tool.denied` | 工具拒绝执行 |
| 工具 | `tool.wrapper_invalid` | 包装器修改了不可修改的声明字段 |
| 工具 | `tools.wire_name_conflict` | 两个 EntryName 编码为同一 wireName |
| 工作区 | `workspace.path_outside` | 路径越出规范化工作区根（含符号链接指向根外）；仅内部使用，从不发送到线上 |
| 模板 | `template.not_found` | 模板不存在 |
| 模板 | `template.invalid` | 模板解析失败 |
| 模板 | `template.init_failed` | 初始化脚本失败 |
| 模板 | `template.workspace_conflict` | 目标文件冲突且未 overwrite |
| 客户端 | `client.not_found` | 客户端未注册 |
| 客户端 | `client.launch_failed` | 客户端启动失败 |
| 配置 | `config.invalid` | 配置值不合法 |
| 配置 | `config.unknown_key` | 未知配置键 |

- 请求级错误通过 `Response.error` 返回。
- 本阶段 `turn.cancel` 对未知或已注销 turn 返回 `{ cancelled: false }`，不产生 `turn.not_found`。
- 内部错误码 `daemon.peer_credentials_unavailable`/`daemon.peer_credentials_failed`/`daemon.peer_credentials_invalid` 只在 daemon 内部使用，启动时归一化为 `daemon.native_unavailable`、`daemon.peercred_probe_failed` 或 `daemon.start_failed`，不发给客户端。`workspace.path_outside` 同样只在 daemon 内部使用：`WorkspaceAccess` 的五个方法（`resolve`、`exists`、`readFile`、`writeFile`、`ensureDirectory`）都会先解析路径，因此都会抛它，当前只有内置 shell 工具把它映射为 `tool.denied`（固定文案 `Working directory is outside the workspace`），不进 `Response.error`，也从不发送到线上。
- turn 进行中的供应商或工具错误通过 `turn.ended.error` 或工具结果回填，不伪造成请求错误。
- `event.publish_failed` 表示同步事件 handler 失败；Context 与 driver 的事件发布适配器都保留原异常为 `cause`，不重试、不回滚已提交状态。driver 中通过 `turn.ended.reason="failed"` 与 `TurnResult.error` 结束 turn。
- 错误消息不得包含凭据。Core 内部 `PiscesError.data` 可保存结构化原因或重试提示；本阶段 `Gateway` 的 `Response.error` 仅映射 `code` 与 `message`，不转发 `data`/`cause`。结构化线上错误详情仅为未来目标，不应依赖。
- `provider.not_found` 是 **CLI 本地**错误码：`models list --provider <id>` 的 id 不在 daemon 返回的清单中时由 `packages/cli/src/providers.ts` 抛出，退出 1；它不出现在 `Response.error` 中，不新增协议方法或 daemon 错误码。

### 3.10 校验、并发与一致性

- 所有会话域方法先校验 `sessionId` 是否存在；`protocol.hello`、`provider.list`、`turn.list`、`client.list` 不校验会话。临时会话与已落盘会话都允许读、订阅和队列操作。
- `session.create`、`session.configure`、`queue.*`、`turn.start` 按会话串行化；`session.read` 在同一会话锁内取快照。
- 多客户端同时编辑队列时按服务端处理顺序最后写入者获胜；客户端以 `queue.updated` 整体替换本地状态。
- `selection` 只由已持久化记录计算；客户端看到队列声明 delta 后自行叠加，不在协议层合并。
- 会话记录只追加；`session.updated` 只推送本次追加节点。
- 事件是状态通知，不是事务日志；断线重连必须重新 `session.read`。
- 单个请求/事件帧上限为 8 MiB；超过限制的连接关闭。
- 超过 `MAX_FRAME_BYTES` 的入站帧在可安全响应时先返回 `protocol.frame_too_large`，随后关闭该连接。
- 单连接出站队列默认上限 8 MiB；队列溢出、写错误或超限事件只关闭该连接并解除其订阅，不中止 turn。已认证的流式 turn 不设空闲超时。
- 握手前最多同时 64 个连接，每个连接必须在 5 秒内完成 `protocol.hello`。
- 协议不提供全局配置、凭据和扩展安装写方法；这些只经 CLI（本阶段尚未装配 CLI）。

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

interface SessionWriteOptions {
  validate?: (nodes: readonly SessionNode[]) => void;
}

interface Sessions {
  create(meta: SessionMeta, drafts: SessionNodeDraft[], options?: SessionWriteOptions): Promise<SessionNode[]>;
  append(sessionId: SessionId, drafts: SessionNodeDraft[], parentId?: NodeId, options?: SessionWriteOptions): Promise<SessionNode[]>;
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
- 可选 `options.validate` 在完整节点生成（真实 id、parentId、createdAt、schemaVersion 已确定）后、仓库写入前同步执行；只收到结构化副本，不能修改待写节点；拒绝时原样抛错且不写仓库。不提供其他写入钩子。
- 写入失败时，`Sessions` 不返回部分节点；由 `SessionRepository` 保证批量原子性。提交点前失败时新批不可见；提交点后目录同步失败返回 `storage.io`，整批可能已存在，调用方须重读确认，不能盲目重试。
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
  entries: ContextEntries;
  skills: Skills;
  sources: ContextSourceRegistry;
  events: ContextEvents;
  eventClock: SessionEventClock;
  runExclusive<T>(task: () => Promise<T>): Promise<T>;
  newId: () => QueueEntryId;
  now: () => string;
}

interface ContextSnapshot {
  queue: QueueEntry[];
  selection: SelectionState;
  seq: number;
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
  nodes: SessionNode[];  // 仅本批持久化节点，不返回历史副本
  headId: NodeId;
  first: boolean;        // 此次调用开始时尚未落盘
}

interface RequestToolDeclaration {
  name: EntryName;
  description: string;
  parameters: JsonObject;
}

interface LlmRequest {
  model: string;
  messages: Message[];
  tools?: RequestToolDeclaration[];
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
  confirm(): void;
  unconfirm(): void;
  updateMeta(meta: SessionMeta): void;
  assemble(options: AssembleOptions): Promise<AssembledContext>;
}

type ContextFactory = (deps: ContextDeps) => Context;
declare function createContext(deps: ContextDeps): Context;

type ContextEntryKind = "tool" | "wrapper" | "skill" | "context";
interface ContextEntries {
  kind(name: EntryName): ContextEntryKind | undefined;
}

interface ContextEvent {
  type: "queue.updated" | "selection.updated" | "session.updated";
  sessionId: SessionId;
  seq: number;
  at: string;
  data: JsonValue;
}

interface ContextEvents {
  publish(event: ContextEvent): void;
}

interface SessionEventClock {
  current(): number;
  next(): number;
}
```

`Context` 创建后由服务层调用 `initialize`：每次调用都重读默认分支并计算已持久化选择，不使用永久 resolved promise，也不丢失现有内存队列；临时会话不读取记录，选择为空。`initialize`、`selectionFor` 及所有同步方法由调用方在会话锁内调用；`assemble` 自持 A/C 锁，调用方不得持锁调用，并在 A 段确保初始化。若已有 pending，`initialize` 及 `assemble` 的 A/C 段先在锁内协调；在协调完成前不解析来源或再次写入。

`snapshot` 返回当前队列、选择与 `eventClock.current()`；`selectionFor` 按指定节点或默认分支计算，不改变缓存。所有输入内容在接收时复制，返回的队列、内容、选择及发布的事件与内部状态隔离，调用者修改它们不得影响后续选择或持久化。`entries` 是冻结 inventory 的分类投影，不提供实时工具正文；请求工具只有 name/description/parameters，不携带 execute、运行时 id/source。未来完整 `ToolDeclaration` 可结构化赋值给 `RequestToolDeclaration`，构造请求时仍显式提取这三个字段。

`Context` 的常态可变状态为：

- `queue`：尚未出队的 `QueueEntry[]`；
- `persisted`：是否已有至少一个已写入节点；
- `selection`：已持久化记录的声明选择缓存；
- `meta`：当前会话元数据。

提交结果无法读清时，额外保留仅含本批不可变 drafts 副本、队列 ids、父节点/水位、first、最终 selection 和原 `storage.io` 对象的内存 pending 状态（§4.2.7），不保存整树，恢复后清除。这是常态状态限制的受限例外；不写磁盘、不设计 WAL，进程重启后队列仍丢失，只依赖 Store 的真实提交事实。pending 期间 `snapshot` 可读旧缓存；enqueue/edit/remove/clear/confirm/unconfirm/updateMeta 在改变任何状态前拒绝 `context.pending_commit`，内部 `PiscesError.data.retryable=true`（当前响应不转发）。

事件序号仅由同会话 Context、未来 driver 与 Gateway 共享的 `SessionEventClock` 维护；发布每个事件时在会话锁内调用 `next()`，快照取 `current()`，Context 不维护第二份计数。clock 返回非负安全整数且分配值单调增加；`ContextDeps.now` 返回恰为 24 ASCII 字节的 RFC3339 UTC 毫秒时间戳。只注入事件发布端，不依赖 EventBus 订阅或实现。

常态不保存“活动分支”“已装配标记”、已装配 id 墓碑或完整选择快照；pending 仅临时保留本批最终选择。

#### 4.2.2 队列操作

- `enqueue` 为每个输入分配 `QueueEntryId` 与 `createdAt`，按输入顺序追加到队尾；不设置 `confirmedAt`。
- `confirm()` 在同一会话锁内把当前未确认条目置为已确认；确认须先通过完整候选队列的大小校验再原子替换。`unconfirm()` 清除所有尚未装配条目的 `confirmedAt`，仅实际变化发布 `queue.updated`；`updateMeta` 只在 Store 写入成功后更新内存 meta。
- 队列内部为每次确认分配代际标记；`unconfirm` 后重新确认必须使用新代际，即使 `confirmedAt` 与上次处于同一毫秒。标记只存在内存，不增加公共 `QueueEntry` 字段或持久化字段；删除、清空及出队同步清理标记。
- `queue` 只存在内存；`Context` 不持久化队列，也不做 WAL。
- `edit` 只允许未确认的 `kind=agent` 条目；已确认条目返回 `queue.entry_locked`。
- `remove` 可删除任意尚未装配的条目（含已确认未装配）；`clear` 清空全部尚未装配条目并返回完整 id 列表；Gateway 在活跃 turn 时整体拒绝 `clear`。
- `turn.cancel` 的取消由 AbortSignal 表示，Gateway/driver 在会话锁内调用 `Context.unconfirm()` 清除未装配条目的 `confirmedAt`。
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

`assemble` 分为三段：A、C 两段由 `Context` 通过注入的 `runExclusive` 获取会话锁，B 段释放；调用方不得在调用 `assemble` 时持锁。

**A. 锁内快照**

1. 调用 `signal?.throwIfAborted()`，保留原始 reason，不新增取消协议码；确保初始化。确定分支起点：`nodeId` 指定时使用该节点；否则使用记录最后一个节点。临时会话没有节点，指定 `nodeId` 返回 `session.node_not_found`。
2. 读取分支节点（临时会话为空）；计算分支选择。
3. 取队列快照，只保留连续已确认前缀；把其中的声明类控制消息异或到选择上。
4. 记录本次分支端点 `headId`（指定节点或默认分支末端）、已确认前缀的条目 id 集合及确认代际。重跑时窗口仍为第一次 A 段记录的集合及代际，只保留仍存在、仍确认且代际相同的条目；后续确认的条目及原 id 重新确认的条目均不进入本次装配。显式旧分支端点不等于文件默认末端；后续提交以本次选择的端点为父节点。

**B. 锁外构造**

5. 对选择中尚未出现在分支里的上下文来源，按名称升序调用 `resolve`；每个 `ContextFragment` 追加为 `kind=agent`、`role=system`、`source=当前条目名` 的节点。已存在该 `source` 节点的来源复用；未选中的不解析。零片段来源不落节点，后续 step 重试。
6. 对选择中尚未出现在分支里的技能，按名称升序追加为 `kind=agent`、`role=system`、`source=技能名` 的节点；已存在复用。
7. 将队列条目按顺序转成 `SessionNodeDraft`；控制消息的内容保持为单个 `text` 块 JSON。
8. 组装可见序列：
   - `source="instruction"` 的节点按活动分支顺序全部参与装配，本批已确认的新消息按队列顺序追加，不过滤旧 instruction；
   - 来源/技能节点只在其 `source` 位于当前选择集时进入；
   - `declaration` 不进入消息；`compaction` 按范围跳过并插入 summary；`cancel` 不进入消息。
9. 选择中的工具/包装器必须能从该名称最近一次携带 `definitions` 的 declaration 找到定义；缺失按 `storage.corrupt` 处理。`LlmRequest.tools` 从这些定义构造，不读实时注册表。
10. B 段只解析来源与技能，不以其暂存消息或预算提前返回 `context.window_exceeded`；最终消息投影、工具定义、预算与压缩/裁剪在 C 段按幸存批次执行（§4.2.6）。

**C. 锁内提交**

11. 重校验：若已确认队列条目在锁外被删除、取消确认或确认代际变化，从本批剔除；不新增本次窗口之后确认的条目。消息、工具、来源、预算及 compaction 均按最终幸存批次重新计算。若声明选择或省略 nodeId 时的默认 head 变化，丢弃本次 resolve 结果并从 A 重跑一次；仍变化返回 `context.changed`，内部 `PiscesError.data.retryable=true`（当前响应不转发）。仅 definitions 变化时也按最终分支与幸存声明重新投影工具；此纯投影不得在锁内触发来源解析。来源结果只保留最终选择中且当前分支尚无对应 source 的内容。
12. B 段每次 await 返回后、C 段写入前均调用 `signal?.throwIfAborted()`；即使来源忽略 signal 并返回也必须拦住取消。取消不持久化、不出队、不增加 `seq`、不写 `session.updated`，本次未发送草稿丢弃。
13. 计算最终可见消息；若没有任何可见 `kind=agent` 消息，返回 `turn.empty`，不调用 `Sessions.create`；仅 user 消息也有效，不要求 system。
14. 写前读取默认分支末端作为追加顺序水位（可复用 C 段刚读出的默认分支），显式旧 `headId` 仅作 parent，不能作水位；临时会话无水位。首次持久化使用 `Sessions.create(meta, drafts, options)`；已有节点时使用 `Sessions.append(sessionId, drafts, headId, options)`；`drafts` 为空时跳过写入。options.validate 预检完整节点事件；需发布的最终完整 selection 同样在不可逆写入前预检（§4.2.7）。正常成功路径不调用 readTree。
15. 持久化成功或失败后重读确认完整已提交时，先从队列移除本批条目，更新 `selection`、`persisted` 并清除 pending；再依次发布 session.updated 各帧、selection.updated（仅变化）及 queue.updated（仅消费非空队列）。同一临界区内每帧分配 seq。空批不执行提交状态转换：即使显式读取旧分支，也只返回该分支的 request/selection/headId，保留默认 selection 缓存、seq 与默认末端，不通知；有实际追加（包括纯 compaction）时按新默认末端更新缓存。每个通知回调独立尝试，失败继续后续通知，最终抛首个通知错误。原 storage.io 若存在则优先原样抛出。回调错误不得进入存储 catch、触发重读/重写或恢复已出队条目。
16. 若本批写入节点非空，将 `headId` 推进为本批最后一个节点的 id；否则保留原端点。返回 `LlmRequest`、选择、写入节点、提交后的 `headId` 与 `first`。

追加的 `parentId` 为提交前的 `headId`；首次创建由 `Sessions.create` 生成根节点。

#### 4.2.5 上下文来源与技能

```ts
interface ContextSourceContext {
  sessionId: SessionId;
  workspace: string;
  signal?: AbortSignal;
}

interface ContextSource {
  id: EntryName;           // package#name
  resolve(context: ContextSourceContext): Promise<ContextFragment[]>;
}

interface ContextFragment {
  source: string;          // 来源描述，不用于过滤
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

- 来源/技能按 §3.1 安全截断文本后，单节点 content JSON 的 UTF-8 大小必须不超过 262144 字节；不可裁字段导致仍超限时，在写库前以 `context.source_failed` 失败。
- 过滤与去重只看 `SessionNode.source`。
- 来源/技能节点是内容，不是选择状态；每个 `source` 在分支中最多追加一次。
- 取消选择不删除已有节点，只从本次消息序列排除；再次选择复用已有节点。
- 零片段来源不落节点，每 step 重新 resolve；这是允许的代价。
- 上下文来源和技能内容都进入 `role=system` 消息；已确认的 `instruction` 消息按分支顺序保留，新增消息不替换已持久化的旧消息。

#### 4.2.6 裁剪与压缩

- `contextWindow`、`maxOutput` 必须是有限非负整数，且 `contextWindow > 0`；否则抛内部 `TypeError`。
- `estimateTokens(value) = ceil(new TextEncoder().encode(JSON.stringify(value)).length / 3)`；消息总量为每条 `Message` 估算值之和。`toolTokenReserve = estimateTokens(request.tools ?? [])`，空工具特例为 0；工具仅序列化 name/description/parameters。预算 `B = max(1024, contextWindow - maxOutput - toolTokenReserve)`。请求参数不隐式增加，model 使用 C 段最新 `meta.model`。
- 普通 agent 节点为一组；含 toolCall 的 assistant 至对应全部 toolResult 的最小连续区间为一组，交叠区间合并。一个 assistant 的多个调用一起保护，组内可含其他消息；尚缺结果的调用组整体保留。仅外层 toolResult 参与配对，结果 content 中嵌套 toolResult 仅作内容。同分支重复 call id、重复 result 或孤立 toolResult 均为 `storage.corrupt`，不发送孤立结果、不伪造结果；cancel/control 不变成请求消息。按 source 选择过滤并应用有效压缩后，对可见消息再次校验配对：孤立结果仍为 `storage.corrupt`，缺结果调用组整体保留。
- 只有 `kind=agent`、`role=system`、`source="instruction"` 的节点不可裁剪，全部按分支/队列顺序原样保留；含任一 instruction 的整个工具组不可裁剪。system/create、来源/技能及其他普通消息均可裁剪；受保护组超预算时失败。
- 先应用已有 compaction：跳过 from/to 范围，summary 作为一条 system 消息插入区间起点；范围须属于当前分支且不重叠，不能跨 instruction；只覆盖工具组一部分或覆盖未闭合组的已有 compaction 也忽略。范围内任一 agent 节点的 EntryName source 当前未选中时，忽略该 compaction，原范围按正常 source 选择过滤投影；重新选中后可再次应用原 compaction。
- 按最旧允许消息组裁剪后，分别计算连续历史节点区间；区间不能跨 instruction、已有压缩或 declaration 控制节点，不引用本批新 drafts；候选区间必须完整覆盖相交工具组，否则不生成 compaction。每区间独立满足 `节点数 >= 4 || 被丢弃消息估算 tokens >= ceil(B / 5)` 才生成 compaction，from/to 为区间首末节点。
- 摘要固定为 `"[compaction]\n" + lines.join("\n")`。每行是 `role + ": " + snippet`；snippet 按节点 content 顺序取 text/reasoning.text、toolCall 的 `name + " " + JSON.stringify(arguments)`、toolResult 的递归文本，以 `"\n"` 拼接后取前 200 个 Unicode code points；整个摘要再取前 2048 个 code points，不加省略号，不调用模型。
- 摘要插入区间起点后重新计算预算，继续裁剪最旧允许组并重新计算区间/摘要，直到稳定；仍超预算返回 `context.window_exceeded`。compaction 与本批 drafts 同批 append，只引用本批之前已落盘节点。
- `compaction` 只由 `Context` 自动写入；`queue.enqueue` 拒绝客户端提交。

#### 4.2.7 持久化与出队

- 首次 `assemble` 使用 `Sessions.create`；后续使用 `Sessions.append`，父节点为本次分支的 `headId`。调用锁要求统一为 §4.2.1：同步方法、initialize/selectionFor 由宿主持锁，assemble 自持 A/C 锁。
- 写入前保存不可变 drafts、队列 ids、parent、水位、first 及最终 selection；只有 Sessions.create/append 的 await 位于存储 catch 中，预算、复制与通知在 catch 外。正常写入成功不 readTree，只有 storage.io 才在锁内协调。
- 协调读取追加顺序全树，取默认末端水位后的完整 suffix；忽略生成 id/时间，逐节点比较所有 draft 字段，数量必须精确等于本批，首 parent 必须是本次指定 parent（首次根自指），其后父指针连续。不能拿显式旧 parent 作水位，也不能把水位前相同正文的兄弟链误认为本批。
- 首次会话在尚未读出节点前 session.not_found，或水位存在且 suffix 为空，判 absent；队列、选择及 persisted/seq 保持本次提交前状态，清除 pending，首调用仍抛原 storage.io，下一次装配才可安全重写。部分读取后报错不能判 absent。
- 完整匹配判 committed，按真实提交事实完成出队与状态更新，再通知；首调用仍抛原 storage.io，后续装配不得重复持久化本批或来源。部分批次、不匹配、链断裂或水位消失判 storage.corrupt，保持 pending，绝不盲重试；首次失败仍优先返回原 storage.io，后续协调返回当前读错误或 storage.corrupt。
- 协调读取本身失败也保留 pending。initialize 或 assemble 必须先重读协调：absent 释放阻塞再继续，committed 先完成内部状态并清 pending 再通知。重复 initialize 不重复出队/通知；恢复通知失败仍以保存的原 storage.io 优先，通知正常则不重新抛已报告的旧错误。
- 事件 `data` 只携带领域 payload，不重复 sessionId/seq/at；首次 session.updated 含 meta。同时满足完整 EngineEvent 与 Gateway 对应协议 `{event,data:{sessionId,seq,at,...payload}}` 的 JSON UTF-8 大小各不超过 4194304 字节，再拆整节点帧，每帧独立 seq，不分片节点。对应协议把顶层字段移入 data，标点字节数相同；type 键改为 event 精确增加 1 字节，故核心按 EngineEvent 最大 4194303 字节计量，无需依赖协议模块。必要时先发含 meta、nodes=[] 的独立帧，再发节点。
- `Sessions` 的写前 validate 使用真实完整节点预检单节点帧及 meta 独立帧，按上述双封装预算，超限以 context.source_failed 拒绝、不写库、不分配 seq；预检 seq 使用 Number.MAX_SAFE_INTEGER 的最坏宽度，at 使用契约规定的 24 字节时间戳。实际分帧仍计当前分配的 seq/at 等完整封装，不能只计 content。来源/技能的 256 KiB 内容限制仍独立生效。
- C 段最终批次非空且最终 selection 与默认缓存不同时，必须在调用 Sessions 不可逆写入前按完整 `selection.updated` 预检 EngineEvent 与对应协议封装，各不超过 4194304 字节；预检使用 16 位安全整数 seq 最坏宽度及 24 字节 ASCII RFC3339 UTC 毫秒时间戳。超限抛 `context.selection_too_large`，不写库、不出队、不更新缓存、不分配 seq；完整 selection 不分片。空批读取旧分支不产生选择变化通知，故不做该变更通知预检。通用 publish 仍按实际完整封装检查预算，超限不交付发布端，使用既有 context.source_failed。
- 所有内部提交状态先完成后才调用发布端；即使某帧失败，其余 session 帧及选择/队列通知仍各自尝试。事件不是可靠日志，已分配 seq 允许间隙，重连通过 read 恢复。事件抛 storage.io 也不是存储失败，不重读、不重写、不回滚。
- `Context` 不直接写文件；只调用 `Sessions`。临时会话首次落盘后 persisted=true；SessionMeta 由服务层提供。updateMeta 由 Gateway 在 SessionStore.updateMeta 成功后调用；assemble 使用最新 meta.model。

### 4.3 `Tools`

`Tools` 负责工具与包装器的注册、选择、包装与执行；包装器不拥有独立调用入口，只包装工具执行。

#### 4.3.1 契约

```ts
type JsonSchema = JsonObject;

interface ToolDeclaration {
  readonly id: string;          // EntryName 派生的运行时标识，不序列化
  readonly source: string;
  readonly name: EntryName;     // package#name，用于选择与记录
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
interface ToolInventory {
  hash: string;
  entries: EntryInfo[];
}

interface Tools {
  forInventory(inventory: ToolInventory): Tools;
  registerTool(declaration: ToolDeclaration): void;
  registerWrapper(name: EntryName, factory: () => ToolWrapper): void;
  selected(selection: SelectionState): ToolDeclaration[];
  invoke(
    call: ToolCall,
    selection: SelectionState,
    context: ToolInvocationContext
  ): Promise<ToolResult>;
}
```

- 服务层为每个 workspace/inventory 创建 `Tools` facade；`Context` 注入该 facade，不直接使用全局注册表。
- `forInventory` 绑定冻结的 inventory hash；旧会话使用会话创建时冻结的 inventory，避免 workspace 之间串用。
- `selected` 只返回被选中的工具声明，不返回包装器。
- 包装器以惰性工厂注册；`invoke` 首次使用时加载并缓存 promise，不在装配锁内转译。
- 包装器被选中后只在工具调用时参与包装，不作为可调用工具。
- 工具声明通过 `LlmRequest.tools` 提供给适配器；序列化字段为 `wireName/description/parameters`，`execute` 留在本地。
- `wireName` 是 `EntryName` 的确定性编码，只存在于 `WireRequest`/`parseChunk` 边界；解码由 adapter 完成，记录中的 `ToolCall.name` 始终是 `EntryName`。标准形为 `t_` + UTF-16LE 码元的 base64url；标准形超过适配器 `maxToolNameLength` 时纯 ASCII 名称改用 `u_` + ASCII 字节的 base64url 紧凑形，解码先试 `t_` 再试 `u_`，仍超限的非 ASCII 名称报错。注册冲突检测与存储的 `ToolCall.name` 均基于 `EntryName`，wire 形只存在于适配器边界。
- 注册时检测两个不同 EntryName 编码到同一 wireName，冲突条目不可用并返回 `tools.wire_name_conflict`。

#### 4.3.3 调用流水线

`invoke` 的步骤：

1. 按 `call.name` 查找已选中的工具；找不到返回 `tool.failed`。
2. 从注册表取被选中的包装器，按完整条目名称（`package#name`）的字典序升序应用；包装器自身必须与顺序无关。
3. 确认包装后的工具具有 `execute`。
4. 调用 `execute(call.arguments, context)`。
5. `ToolDeniedError` 转为 `isError` 的工具结果，`code="tool.denied"`。
6. 其他异常转为 `isError` 的工具结果，`code="tool.failed"`；不终止 turn。

多个工具调用可以并行执行；结果按原始 `ToolCall` 顺序回填。

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
  events: EventBus;
  eventClock: SessionEventClock;
  contextWindow: number;
  maxOutput: number;
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

interface AgentLoopDriverOptions {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  now(): string;
}
```

`LlmAdapter`、`ExecuteProvider` 与 `LlmRequest` 见 §2 与 HLD §6.2；`run` 不直接处理协议。Driver 工厂注入共享的会话锁与事件时钟；`now()` 返回 RFC3339 UTC 毫秒时间戳。

#### 4.4.2 状态机

```text
idle -> running -> cancelling -> ended
                \-> ended
```

- `run` 进入 `running`，在首次 assemble 前发布 `turn.started`（不带 `mode`）。
- `cancel(turnId)` 将当前 turn 置为 `cancelling`，abort 供应商流并置工具 signal；已执行的工具不被强制终止。
- 中止后不再发起新 step；当前工具结果回填、已产生回复写入后结束。
- 正常结束或失败进入 `ended`，发布 `turn.ended`。

#### 4.4.3 循环

1. 调用 `Context.assemble`；首次使用 `Sessions.create`，之后使用上次返回的 `headId` 作为 `nodeId`。
2. 记录本次 `headId`；发布 `session.updated`（首批装配写入的节点）。
3. 用 `adapter.buildRequest` 构建供应商请求；每个 step 使用独立的流式 parser。
4. 通过 `execute` 获取流，逐块解析；累计文本、工具调用、usage 与 stop reason，并按 §3.8 发布 `turn.delta`；wireName 在落盘前转回 EntryName。
5. 若返回包含工具调用：
   - 将 assistant 文本与工具调用写入 `SessionNode`；
   - 按调用顺序/并发限制执行 `Tools.invoke`；
   - 对每个调用生成 toolResult；中断恢复时使用 synthetic 结果；
   - 将工具结果写入 `SessionNode`；
   - 发布 `session.updated` 与 `turn.step`；
   - 回到步骤 1。
6. 若无工具调用：
   - 将 assistant 回复写入 `SessionNode`；
   - 发布 `session.updated` 与 `turn.step`；
   - 若仍有已确认待装配条目，回到步骤 1；否则结束。

- 结束条件为“无可装配的已确认条目且无工具调用”；未确认条目不阻止结束，也不进入请求。
- 每个 step 显式使用 `headId` 作为后续 assemble 的 `nodeId`；记录末行只用于默认分支读取。
- 供应商错误转为 `turn.ended.failed`；工具错误按工具结果回填，不终止 turn。
- 存储错误立即失败，不继续请求；已写入节点保留。

#### 4.4.4 持久化与事件

- `Context` 负责装配节点与 compaction 的持久化；`AgentLoopDriver` 负责 assistant 回复、工具结果与 cancel 控制消息的追加。
- 每批写入使用 `Sessions.append`，父节点为当前 `headId`；成功后立即将 `headId` 推进到本批末节点，后续 assistant、tool、cancel 批次及下一次 assemble 均使用新端点；失败不继续循环。
- 写入前按 §3.1 验证供应商输出经文本安全截断后，每个完整单节点 `session.updated` EngineEvent JSON 的 UTF-8 大小不超过 4194304 字节；包括节点字段与事件封装，超限以 `provider.invalid_response` 失败。写入成功后发布 `session.updated`，只携带本批节点；超过事件字节预算时按节点拆批，单个节点不分片。
- `turn.step` 在一个 step 完成后发布；`turn.ended` 在 turn 结束后发布；被取消的 step 使用 `stopReason="cancelled"`。
- 取消时若已有部分回复，先写入部分回复；未发送的草稿不落盘。随后写入 `role=cancel` 控制消息，`at` 为当前最后节点，并清除未装配条目的 `confirmedAt`。
- 事件通过 `EventBus` 发布；driver 与 Context/Gateway 共享同会话 `SessionEventClock`，所有会话事件的 `seq` 通过会话锁内 `next()` 分配。

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

- 公开入口是 `startDaemon(options: { dataDir: string; providers; providerHost; defaults?; extensions?: { configDir?; configPath? }; /* 既有可选工具/条目/技能/来源工厂 */ }): Promise<DaemonHost>`；启动只锁定配置位置，不在启动时读取扩展配置或扫描目录。宿主用同一个 `dataDir` 构造 `SessionStore`、`ActiveTurnStore`、`EventBus`、`Concurrency`、`Gateway` 与 Linux 监听器，不接受外部 store/marker 注入。
- `dataDir` 必须为绝对路径、属主为当前有效 UID 且组/其他用户不可写；`dataDir/run` 必须为属主 `0700`，既有符号链接或不安全模式直接拒绝。socket 为 `dataDir/run/pisces.sock`（`0600`），锁为 `dataDir/run/pisces.lock`。
- 本阶段仅 Linux。平台检查与 `getuid() === geteuid()` 在导入原生绑定、绑定 socket 之前完成；macOS 与 Windows 以 `daemon.unsupported_platform` 失败，Windows 命名管道仍为目标设计。
- 启动顺序：
  1. 校验平台与进程身份；
  2. 校验/创建私有运行目录；
  3. 对 `pisces.lock` 取 `flock`；
  4. 在 `run` 下的私有临时路径做原生 peer 凭据自检；
  5. 校验并处理陈旧 socket；
  6. 按需构造 `TemplateStore`（`templates`），随后 `bootstrapGateway`：初始化 `SessionStore`、恢复活跃 turn、构造 `Gateway`（§5.9）；
  7. 绑定并校验 `pisces.sock`，开始接受连接。
- 任一步失败按逆序关闭已获取资源；第二个进程以 `daemon.lock_busy` 失败且不删除存活 socket；锁文件本身不在停止时 unlink。
- 停止顺序：同步置 `quiescing` 并阻断新帧 → 停止 accept → 等待已受理请求（5 秒，含客户端已断开的请求）→ `cancelAll(5000)` 并等待取消、标记清理与注销 → 要求 `activeTurns().length === 0` → 关闭/解除连接 → 关闭监听器并按 inode 清理 socket → 释放锁 → dispose `Gateway` → `stopped`。
- 已受理请求超时、仍有登记 turn（含 `turn.cleanup_failed`）、标记删除失败或监听器/锁释放失败统一抛 `daemon.stop_incomplete`，按其实际状态保留锁、socket、`Gateway` 与 `quiescing`，允许重试；不自动强杀进程，也不声称已优雅停止。操作者终止进程后由下一次启动按 §6.5 恢复。成功返回后 `stop()` 幂等。
- daemon 崩溃后只恢复已落盘会话；临时会话与消息队列随进程退出丢失。
- 未完成的热会话在恢复时标记为中断，由用户决定是否继续。
- 本阶段尚未装配：`CredentialStore` 与清单中的 `providers` 扩展装配，仍为目标设计；`ClientRegistry` 由 `startDaemon` 按 `options.extensions` 的目录恒定装配（无扩展源时列表为空），`clients` 清单项因此不再记为 `extensions.unsupported_contribution`。已装配的是目录驱动模式的 `Extensions`：通过 `startDaemon({ extensions: { configDir } })` 或 `{ configPath }` 装配，配置层与目录在 `session.create` 时读取与扫描；模板通过 `startDaemon({ templates: { configDir } })` 装配；CLI 的配置加载器在 spawn daemon 之前运行，并把配置路径传给 daemon 子进程。

#### 5.1.2 `Transport`

```ts
interface UnixTransport {
  start(): Promise<{ dev: number | bigint; ino: number | bigint }>;
  stopAccepting(): void;
  close(): Promise<void>;
}

interface UnixTransportOptions {
  socketPath: string;
  onAuthenticatedSocket: (socket: Socket) => void;
  peerUidFor?: (socket: Socket) => number; // 仅内部测试 seam
  expectedUid?: number;
  maxConnections?: number; // 默认 64
}
```

- 本阶段仅 Linux Unix domain socket，权限 `0600`；Windows 命名管道为目标设计。`startDaemon` 永不注入 `peerUidFor`，生产路径始终使用原生 `SO_PEERCRED`。
- accept 的 socket 以 `pauseOnConnect` 暂停；先取 peer UID，要求与 daemon 有效 UID 相同，通过后才挂载解析器并 `resume()`；失败只销毁该连接。不监听网络地址。
- 原生 `bindUnixListener(path)` 创建并 listen socket，Node 用 `server.listen({ fd })` 接管，因此 Node 不持有路径名、不会在 `server.close()` 时自动 unlink。路径清理只由身份校验后的 quarantine 流程负责。
- 分帧按 §3.1 的 NDJSON 规则；超过 8 MiB 时在可安全响应时发送 `protocol.frame_too_large`，随后关闭连接。
- `Transport` 只负责监听、连接、认证、分帧、发送和关闭，不解释方法语义；`protocol.hello` 与请求分派由连接的 `Dispatcher` 处理。
- `Connection.send` 串行化同一连接上的写入并设 8 MiB 出站队列预算；队列溢出或写错误只关闭该连接，不中止 turn。
- 连接关闭时通知 `Gateway` 解除该连接的全部订阅；不中止活跃 turn。
- 启动失败时关闭已获取的 fd/server，并按 inode 尝试清理本次绑定的路径；清理失败不改变原始启动错误，也不会删除不属于本次实例的路径。

### 5.2 `Concurrency`

```ts
interface ActiveTurn {
  sessionId: SessionId;
  turnId: TurnId;
  startedAt: string;
}

interface ConcurrencyOptions {
  cancelAllTimeoutMs?: number; // 默认 5000ms
}

interface Concurrency {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  registerTurn(sessionId: SessionId, turnId: TurnId, startedAt: string, cancel: () => void): void;
  unregisterTurn(sessionId: SessionId, turnId: TurnId): void;
  activeTurn(sessionId: SessionId): TurnId | undefined;
  activeTurns(): ActiveTurn[];
  cancelTurn(turnId: TurnId): boolean;
  cancelAll(maxWaitMs?: number): Promise<void>;
}
```

- 每个会话一把非重入逻辑锁；会话内队列写、配置、turn 启动、装配提交、持久化与 `seq` 自增按锁串行化。
- 同会话嵌套获取在返回的 Promise 上以 `TypeError("Session lock is not reentrant")` 拒绝，而非同步抛出；`runExclusive` 只返回 Promise，重入失败与其他失败走同一 rejection 通道。重入校验只对当前实际仍持有的会话锁生效：已释放锁遗留的 `AsyncLocalStorage` 上下文延迟进入时不会假报重入。
- `runExclusive` 的 task 拒绝时释放会话锁，后续排队任务保持 FIFO 顺序且不被污染。
- `Context.assemble` 自持 A/C 会话锁，调用方不得持锁调用；`initialize`、`selectionFor` 与所有同步方法由调用方在锁内调用。锁外执行 resolve/loader/provider/tool。Context、driver、Gateway 共享同会话 `SessionEventClock`；`next()` 仅在会话锁内调用，快照取 `current()`，不独立维护计数。
- 不同会话可并行；事件发送与请求处理不共享全局锁。
- `activeTurn` 只记录正在运行的 turn；`activeTurns()` 返回按 `sessionId`、`turnId` 排序的脱离快照，`turn.list` 据此生成快照，允许无锁快照偏差。
- `registerTurn` 每个会话只登记一个 turn，重复登记以 `turn.active` 拒绝而不替换已有 turn；登记时保存取消 handle。
- `cancelTurn(turnId)` 对未知 turn 返回 `false`，否则至多调用一次该 turn 的取消 handle。handle 抛错被隔离，不向调用方转抛原始异常；`cancelAll` 因此仍继续取消其它 turn 并照常等待超时。
- `cancelTurn(turnId)` 是唯一取消入口：`Gateway` 不直接调用 `AgentLoopDriver.cancel` 或 `cancelAll`，也不扫描运行时查找 driver。登记的 handle 必须是总函数且无锁：同步触发、不 await、不获取会话锁；handle 抛错只记录在运行时，不转抛、不外泄。
- `cancelTurn` 返回 `true` 只表示请求已交给登记的 turn，不表示该 turn 已结束；忽略中止的 driver 继续以 `running` 登记、继续被 `turn.list` 列出并阻塞同会话新 turn。turn 仍登记时重复调用仍返回 `true`，handle 至多执行一次。
- `runExclusive` 不跨会话持有锁；回调内不得 acquire 同一会话锁。
- `cancelAll(maxWaitMs = 5000)` 取消全部已登记 turn 并等待其完成；超时不报错且不删除登记项（含 `active-turn.json` 标记），turn 保持 `running`，只能由自然结束或启动恢复处理。host 发起的 `cancelAll` 后没有 start/stop/shutdown 路径，也没有超出重启恢复的残留 turn 恢复。
- `Concurrency` 不持久化状态；daemon 重启后活跃 turn 集合为空。

### 5.3 `EventBus` 与 `Gateway`

```ts
interface EngineEvent {
  type: string;
  sessionId?: SessionId;
  seq?: number;
  at: string;
  data: JsonValue;
}

interface EventBus {
  publish(event: EngineEvent): void;
  subscribe(handler: (event: EngineEvent) => void): () => void;
}
```

- `EventBus.publish` 同步、在调用栈内按订阅顺序 fan-out：每个 handler 都会被尝试，某个 handler 抛错不影响后续 handler 收到事件；全部 handler 执行完后原样重新抛出第一个异常。订阅变更只影响后续发布，不修改本次发布已取的快照；handler 只入队发送，不 await。
- daemon 的 `EventBus` 只转发事件并原样重新抛出第一个 handler 失败，不包装、不清洗、不重新解释异常。`event.publish_failed` 映射及其原始 `cause` 由 core 的 `createEventPublisher`/`deliverEvent` 与 `createContextEvents` 负责，daemon 侧不在 bus 上重新包装 raw cause。
- Context 的事件发布适配器与 driver 的 `EventPublisher` 都在同步 handler 抛错时抛出 `event.publish_failed`，原异常保存在 `cause`。Context 的提交状态与 driver 的持久化状态已完成后才发布，因此节点、队列状态、head 推进与已分配 `seq` 保留并允许序号空洞；不重试、不回滚。
- Context、driver、Gateway 共享同会话 `SessionEventClock { current(): number; next(): number }`；每个会话事件的 `seq` 通过会话锁内 `next()` 分配，Context 快照读取 `current()`。Context 仅依赖 `ContextEvents.publish` 发布端，不依赖订阅接口。
- `Gateway` 把引擎事件转换为协议事件，并只发送给订阅该会话的连接。

`Gateway` 把协议方法映射到 `Context`、`Sessions`、`AgentLoopDriver`、`Extensions` 与存储；本身不实现上下文组装或工具执行。

#### 5.3.1 会话运行时

```ts
interface SessionRuntime {
  meta: SessionMeta;
  persisted: boolean;         // 临时会话首次落盘后置 true
  context: Context;
  sessions: Sessions;         // 包装 SessionStore；首次 create 提交后补写临时会话标记
  driver: AgentLoopDriver;
  eventClock: SessionEventClock; // 同会话 Context/driver/Gateway 共享
  pendingMarker?: { turnId: TurnId; startedAt: string };
  phase?: "running" | "cleanup" | "cleanup_failed";
  cancelHandleError?: unknown; // 仅运行时内部，不转抛或导出
}
```

- 订阅不存放在 `SessionRuntime` 中：`Gateway` 以内部 `connectionId` 为键保存 `{ enqueue, subscriptions }`，因此同一会话可被多个连接订阅，`detach` 只移除该连接。
- `Gateway` 维护 `sessionId -> SessionRuntime` 映射。
- 已落盘会话按需加载：读取 `SessionMeta`，创建 `Context`（`persisted=true`）并调用 `initialize`。
- `session.create` 创建临时 `SessionMeta`、`Context`（`persisted=false`）和空队列；不写盘。
- 临时会话不出现在 `session.list`；daemon 退出即丢失。
- 同一会话的运行时只创建一次；多个客户端共享。
- 运行时在进程存活期间不逐出、不重建，随之只有一份 `SessionEventClock`，由该会话的 `Context`、driver 与 `Gateway` 共享，`next()` 只在会话锁内调用。因此进程运行期间 `seq` 不回退。
- `SessionNode` 不持久化 `seq`，重启后每个会话的 clock 从 `0` 开始；这不违反 §3.4.3/§5.3.3，因为事件不重放，重连客户端先 `session.read` 并以返回的 `seq` 作为水位。

#### 5.3.2 方法路由

- `session.create`：校验 provider/model、workspace 与 extensions；目录驱动模式下先冻结绑定，把 `systemPrompt` 与一条已富化定义快照的声明入队；显式 `extensions: []` 不生成声明；非空列表的非法名称/内联定义/类型变化按 `queue.invalid_control`，重复名称按 `queue.duplicate_name` 整体拒绝且不创建运行时。无扩展模式沿用旧行为（非空 `extensions` 一律 `queue.invalid_control`）。带 `templateId` 时先解析模板默认值（未装配 `TemplateStore` 返回 `protocol.invalid_request`）；显式字段优先，解析只读、不写盘。通过后在会话锁内创建运行时，将提示词物化为队列条目（模板提示词 `source="template"`），返回临时 `SessionMeta`。
- `session.list`：无参数，只查 `SessionStore.list()`；不经过运行时，不包含临时会话；顺序不构成契约。
- `session.read`：在会话锁内读取 `meta`、`records`、`queue`、`selection` 与 `seq`；无 `nodeId` 按字节预算分页读全树，有 `nodeId` 读分支；临时会话没有节点。`selection` 由 `Context.selectionFor` 计算，只含已持久化记录；`queue`/`selection` 仅首屏返回。
- `session.configure`：先检查活跃 turn，存在则整体返回 `turn.active`，不修改队列/meta；无活跃 turn 时校验后先写 `SessionStore.updateMeta`，成功后调用 `Context.updateMeta`；`systemPrompt` 只更新或新增 `source="instruction"` 队列条目。
- `session.subscribe` / `session.unsubscribe`：仅在请求带连接上下文时路由；不带连接上下文时按未知方法返回 `protocol.unknown_method`。订阅集合按连接保存；校验会话（含临时会话）与安装订阅在同一会话锁内完成，重复订阅幂等；退订不发事件，断开清理。事件推送与 `detach` 不中止活跃 turn，也不影响其他连接。
- `queue.enqueue`：在会话锁内加载/复用运行时、`initialize`；目录驱动模式下把声明类条目按冻结绑定富化（每个 toggle 名称带完整定义快照，all-toggle），无扩展模式仍拒绝客户端控制条目（`queue.invalid_control`），再委托 `Context.enqueue`；返回 `{ ids }`，成功后按最终队列推送 `queue.updated`；条目/队列超限沿用 `queue.entry_too_large`/`queue.too_large`，失败时整批不改变队列。`queue.edit` / `remove` / `clear` 均已路由；`clear` 在有活跃 turn 时整体返回 `turn.active`。
- `entries.snapshot`：从冻结绑定取得当前清点（`EntrySnapshot` 投影），从 `Context.viewFor` 取得已持久化选择与 `effective` 列表；不合并队列，不导入扩展代码，不解析来源。
- `turn.start`：在 `runExclusive` 回调内只完成“读 activeTurn → 校验 → 写标记（已落盘会话）/暂存标记（临时会话）→ `context.confirm()` → `registerTurn` → 置运行时 `running`”；无活跃 turn 时生成 `turnId`，已落盘会话在锁内写 `active-turn.json` 标记，临时会话只记录 `pendingMarker`（由首次 `Sessions.create` 提交后补写），并返回 `{turnId, mode:"new"}`；已有活跃 turn 且运行时为 `running` 时只 `confirm` 并返回该 turn 的 `turnId` 与 `mode=steer`，不写新标记；运行时处于 `cleanup`/`cleanup_failed` 时整体返回 `turn.active`，不确认、不 steer。`AgentLoopDriver.run` 必须在 `runExclusive` 回调完全返回、会话锁释放之后才启动（锁外 fire-and-forget）；不得在锁回调内同步调用或 await `run`，否则触发非重入 `TypeError` 或死锁。
- 临时会话标记：`turn.start` 不写盘标记；`Gateway` 包装的 `Sessions.create` 在首次提交成功后写 `active-turn.json`（`startOffset=0`，无 `startNodeId`）。写失败以 `storage.io`（“Active turn marker could not be written”）失败，且发生在任何供应商请求之前：已提交节点与已确认队列的消费保持不变量、不回滚，磁盘无标记。提交成功到写标记之间的进程崩溃窗口不可恢复，本设计不声称覆盖。
- `turn.list`：从 `Concurrency` 返回活跃 turn 快照。
- `turn.cancel`：不取会话锁，先按 `turnId` 在 `Concurrency.activeTurns()` 定位会话与运行时；未知 turn、已注销或运行时处于 `cleanup`/`cleanup_failed` 返回 `{ cancelled: false }`；运行时仍为 `running` 时委托唯一取消入口 `Concurrency.cancelTurn(turnId)` 并返回其布尔值。登记 handle 在 `registerTurn` 时保存，总是不阻塞、无锁、同步触发 driver 的协作式取消（中止供应商流、置位工具信号并停止新 step，见 §3.6.3），不强制终止，也不绕过 `Concurrency` 自行查找 driver。`{ cancelled: true }` 只表示请求已交给登记的 turn，不表示 turn 已结束；`running` 期间重复调用仍返回 `true`，handle 至多执行一次；忽略中止的 driver 保持 `running`、继续被 `turn.list` 列出并阻塞同会话新 turn，只能由自然结束或重启恢复解除。
- turn 生命周期：`running -> cleanup -> (unregistered | cleanup_failed)`。driver 结束（含失败）后，`launch` 在会话锁内把阶段置为 `cleanup`；`turn.ended` 只把运行时移到 `cleanup`，不注销 turn、不删除标记。随后删除 `active-turn.json` 成功才注销；失败则发布安全数据的 `turn.cleanup_failed`（`{turnId, code:"storage.io", message}`，不含原始异常），在缺失时追加一条同 `turnId`、`reason="cleanup_failed"` 的 `cancel` 控制消息，重试删除一次；仍失败则保留标记并把阶段置为 `cleanup_failed`。`cleanup`/`cleanup_failed` 期间 `turn.list` 仍列出该 turn，`turn.start` 返回 `turn.active`，`turn.cancel` 返回 `{ cancelled:false }`，因此残留标记与登记项会阻塞该会话的新 turn，直到重启恢复删除标记；`cleanup_failed` cancel 已提交时恢复按同 `turnId` 去重，只删除标记而不追加 `daemon_restart` cancel。
- `provider.list`：从 `ProviderManagement` 与 `CredentialStore` 生成；`ready` 由凭据状态计算。
- `template.list` / `preview` / `apply`：委托 `TemplateStore`、`WorkspaceAccess`、`ExecHost`，并创建临时会话。`apply` 先用只读的 `inspect` 完成会话配置预检并保留预检结果，再调用 store 写盘、跑脚本、记 `ProjectRef`，最后用预检会话与 `apply` 返回的提示词创建临时会话（不重复校验）；未装配 `TemplateStore` 时仍返回 `protocol.unknown_method`。
- `client.list` / `start`：委托 `ClientRegistry`（§5.8.2）。`list` 不校验会话，`start` 只校验 `id` 为非空字符串；未注入 registry 的嵌入模式返回 `protocol.unknown_method`。
- 未识别的方法名（包括 `constructor`、`toString`、`__proto__` 等原型属性名）在分派前按自有属性判定，统一返回 `protocol.unknown_method`，不进入任何处理函数，也不产生 `internal.error`。

#### 5.3.3 事件路由

- `createGateway` 在每次调用内创建唯一的 handler 闭包并订阅一次 `EventBus`，按 `event.sessionId` 路由到本实例的运行时，未知会话忽略且不抛错。`EventBus` 按函数引用去重，不能为同一函数提供多个身份，因此禁止共享/模块级 handler，也禁止按会话分别订阅。
- `Context` 的 `queue.updated`、`selection.updated`、`session.updated`，以及 driver 的 turn 事件（含 `turn.cleanup_failed`）进入 `EventBus`。
- `Gateway` 把引擎事件投影为 `{ event: type, data: { sessionId, seq, at, ...payload } }`，只发送给订阅该会话的连接。`sessionId`、`seq`、`at` 以引擎事件为准，payload 中的同名键被丢弃；未知事件类型或缺失路由字段的事件被忽略。
- `turn.cleanup_failed` 只输出固定 `turnId`、`code="storage.io"` 与固定安全文案，不复制原始 cause 或任意 payload。
- 每个连接的 `enqueue` 异常（编码超限、队列溢出、连接已关闭）被捕获，仅移除该连接并解除其订阅；`EventBus.publish` 不因单个客户端失败而失败。
- 事件都带 `sessionId`、`seq` 与 `at`；`queue.updated` 携带完整队列，`selection.updated` 携带完整名称集合。
- `session.updated` 只携带本次追加节点；核心按完整 EngineEvent JSON 的 UTF-8 字节预算 4194304 拆分，每帧独立 seq；`meta` 变化时 nodes 可为空。队列与选择通知按最终状态各发布一次。
- 事件不重放；重连后客户端重新 `session.read`。

#### 5.3.4 多客户端与临时状态

- 队列写操作通过 `Concurrency.runExclusive` 串行化，最后写入者获胜。
- 客户端以 `session.read` 为初始快照、`queue.updated` 为增量。
- 订阅与连接绑定，不持有全局锁。
- 临时会话可读、可订阅、可队列操作；首次 turn 落盘后进入 `session.list`。
- daemon 停止或崩溃时，未落盘的临时会话与队列不恢复。

#### 5.3.5 活跃 turn 标记

```ts
interface ActiveTurnStore {
  read(sessionId: SessionId): Promise<ActiveTurnMarker | undefined>;
  write(sessionId: SessionId, marker: ActiveTurnMarker): Promise<void>;
  remove(sessionId: SessionId, turnId: TurnId): Promise<void>;
  list(): Promise<{ sessionId: SessionId; marker: ActiveTurnMarker }[]>;
  scan(): Promise<ActiveTurnScanEntry[]>;
}

type ActiveTurnScanEntry =
  | { sessionId: SessionId; marker: ActiveTurnMarker }
  | { sessionId: SessionId; error: PiscesError };
```

- `write` 校验 `sessionId` 与标记结构后，写 `active-turn.json.tmp`、fsync、rename 覆盖并同步会话目录；会话目录不存在返回 `storage.io`。
- `read` 在文件缺失时返回 `undefined`；未知字段、非法 id、`startOffset` 不是非负安全整数或 `startedAt` 不是 24 字节 RFC3339 UTC 毫秒时间戳均返回 `storage.corrupt`。
- `remove` 先读取，仅在磁盘标记的 `turnId` 匹配时删除；文件不存在或不匹配为幂等 no-op，不会删除其他 turn 的标记。
- 严格 `list()` 遇任一损坏标记整体拒绝并保留原始数据，供非恢复调用方 fail-closed 使用。
- 恢复专用的 `scan()` 逐会话返回标记或该会话的 `PiscesError`，单个损坏标记不阻断健康会话；`recoverActiveTurns` 只消费 `scan()`，把无效条目转为 `RecoveryIssue` 并保留坏标记，不静默跳过。
- 标记由 `Gateway` 侧的 `ActiveTurnStore` 拥有，不是 `SessionStore` 的一部分；`SessionStore.initialize` 不读取、不清理 `active-turn.json`。文件契约与恢复规则见 §6.5。

### 5.4 `SessionStore`

`SessionStore` 实现 `SessionRepository`，负责会话目录、`meta.json`、`events.jsonl` 与项目记录。

```ts
interface SessionStore extends SessionRepository {
  initialize(): Promise<RecoveryIssue[]>;
  getMeta(sessionId: SessionId): Promise<SessionMeta>;
  commitOffset(sessionId: SessionId): Promise<number>;
  readTreeSince(sessionId: SessionId, offset: number): AsyncIterable<SessionNode>;
}
```

#### 5.4.1 布局

| 路径 | 内容 |
|---|---|
| `<dataDir>/sessions/<sessionId>/meta.json` | `SessionMeta` |
| `<dataDir>/sessions/<sessionId>/events.jsonl` | `SessionNode`，一行一个 |
| `<dataDir>/sessions/<sessionId>/events.commit` | 已提交字节偏移 |
| `<dataDir>/sessions/<sessionId>/active-turn.json` | 活跃 turn 的恢复标记，不属于会话记录 |
| `<dataDir>/projects.json` | 模板衍生项目 `ProjectRef[]` |

- `sessionId` 必须匹配 `/^[A-Za-z0-9_-]+$/`；非法 id 在访问路径前拒绝。sessions 根目录、会话目录和已知文件不跟随符号链接；根目录符号链接使初始化整体拒绝，不扫描或清理链接目标。
- 空会话没有目录、没有 `meta.json`。
- `active-turn.json` 是运行时恢复标记，不是 `SessionNode`，不参与列表、导出或选择。
- `meta.json`、`events.jsonl` 与 `active-turn.json` 只由 daemon 维护；用户不手工编辑。

#### 5.4.2 写入

- `create`：
  1. 非 recursive mkdir 独占创建会话目录；已有目录拒绝且不清理；
  2. 写 `events.jsonl.tmp`、`events.commit.tmp` 与 `meta.json.tmp`；
  3. fsync 三个临时文件；
  4. rename events → commit → meta，meta rename 为可见提交点；
  5. fsync 会话目录与 sessions 父目录（POSIX；Windows 对已知不支持的目录同步错误使用可用语义，一般 I/O 错误仍上抛）。
- `append`：
  1. 取该会话写锁；
  2. 读取 commit 偏移 C，校验 `0 ≤ C ≤ 文件长度` 且 C 在换行边界；否则 `storage.corrupt`；
  3. 将物理文件截断到 C，丢弃未提交尾部；
  4. 将本批节点写成完整 JSONL 行并 fsync；
  5. 写并 fsync commit.tmp，再 rename 为 `events.commit`（提交点），随后 fsync 会话目录。
- `updateMeta`：
  1. 读取当前 meta；
  2. 只替换 `model`、`provider`；
  3. 写临时 meta，fsync 后 atomic rename（提交点），随后 fsync 会话目录。
- `create`/`append`/`updateMeta` 不留下半批节点；提交点前失败保留旧值，create 仅清理本次独占创建的未提交目录。提交点后目录同步失败返回 `storage.io`，整批可能已提交；失效缓存并重读，不删除目录或回滚已提交数据。
- 读取只看 commit 偏移之前的内容；有 meta 但 commit 缺失或非法属于 `storage.corrupt`，保留原始数据并报告，不作为孤儿删除。
- 写入不修改已有节点，不修改 `meta.json` 的不可变字段。

#### 5.4.3 读取

- `SessionStore` 为每个已加载会话维护 `id -> (parentId, offset, length)` 的内存索引，偏移/长度均为 UTF-8 字节数；首次加载完整校验已提交前缀后才返回节点，提交后更新索引。单次迭代使用稳定快照。
- `readTree` 只读取 commit 偏移之前的完整行；完整行 JSON 损坏返回 `storage.corrupt`。
- `readBranch` 使用索引从 `nodeId` 沿父指针上溯，再按 offset 读取对应行；省略 `nodeId` 时以最后一个已提交行为分支末端。
- 索引不持久化；daemon 重启后首次读取重建。
- 未提交尾部在读取时忽略，不修改文件；下一次 append 前截断到 commit。
- 文件中间出现空白行忽略；非法行报错。
- 节点 `parentId` 不存在、根指针异常或环返回 `storage.corrupt`。
- `getMeta` 在 `initialize` 后返回 `SessionMeta` 的脱离副本；会话缺失返回 `session.not_found`，meta 非法返回 `storage.corrupt`。
- `commitOffset` 返回当前 `events.commit` 的已提交字节偏移，需先 `initialize`。
- `readTreeSince(offset)` 按提交顺序产出字节偏移不小于 `offset` 的已提交节点；`offset` 必须是非负安全整数，否则 `TypeError`。未提交尾部不参与比较；恢复据此排除 `startOffset` 之前的历史节点。
- 三者是 `SessionStore` 的服务内部读访问器，不属于 `SessionRepository`，core 不调用；`active-turn.json` 仍由 `ActiveTurnStore`（§5.3.5）拥有，`SessionStore` 不读取、不清理。

#### 5.4.4 列表与项目

- `list` 只返回已落盘的有效会话 meta；忽略临时文件和无 meta 的未提交目录。遇有 meta 但 commit 缺失或其他损坏时整体拒绝，不返回部分列表；健康会话仍可直接读取。
- 返回顺序不构成契约。
- `projects.json` 由 `TemplateStore` 维护，记录 `ProjectRef`。
- 配置、凭据、扩展目录不进入会话记录。

#### 5.4.5 并发与恢复

- `SessionStore` 用每会话 promise 队列串行化 `create`/`append`/`updateMeta`，失败不阻塞后续写；`Concurrency` 仍须覆盖 `Sessions.append` 从读父节点到提交的整个操作。不支持多进程/多实例同时写同一目录。
- 不同会话可并行写。
- 工厂显式接收 `dataDir` 且不访问磁盘；仓库方法须等待 `initialize(): Promise<RecoveryIssue[]>`，其中 `RecoveryIssue` 为 `{ sessionId, error: PiscesError }`。并发初始化共享一次 promise，成功后的重复调用返回原报告。根目录 I/O 故障拒绝初始化并返回 `storage.io`；逐会话故障收集到报告，其余会话仍可用。
- 初始化只删除无 meta 的普通会话孤儿目录；有 meta 时先验证 meta、commit 和已提交记录，再截断未提交尾部并同步，最后清理健康会话的三个受控 `.tmp` 文件；损坏会话保留证据，后续读写返回报告中的错误。
- 文件恢复在开始监听前完成；`SessionStore` 不处理 `active-turn.json`、`projects.json` 或其他无关文件。活跃 turn 仍由 `Gateway` 按 §6.5 恢复或删除，初始化报告不代表 turn 恢复完成。
- 已落盘会话恢复为冷会话；未完成 turn 由 driver 标记中断。
- `meta.json` 不可读或 schema 不支持时报告 `storage.corrupt`，不返回部分结果。

### 5.5 `Extensions`

`Extensions` 负责发现扩展、读取清单与配置、登记内容条目，并按需装载实现代码。

#### 5.5.1 发现来源

- 内置扩展：`extensions/builtin`。
- 软件配置目录：`<configDir>/extensions/`；`configDir` 为显式选项，或 `dirname(configPath)`（CLI
  `--config` 的精确路径）。
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

interface EntryMetadata {
  name: string;
  description?: string;
  parameters?: JsonObject;
  config?: { defaults: JsonObject; schema: JsonObject }; // 仅 wrapper
}

interface Inventory {
  hash: string;
  entries: EntryInfo[];
}
```

- 发现阶段只读取清单、sidecar 元数据与资源文件，不执行扩展代码；工具/包装器/上下文来源的 sidecar 命名为 `<entry>.meta.json`（与脚本同目录，如 `tools/run.ts.meta.json`），技能为相邻的 `skills/<name>.meta.json` 加正文 `skills/<name>/SKILL.md`；sidecar 只允许 `name/description/parameters/config`。
- 条目名称统一为 `package#name`：`package` 取扩展包名，`name` 取 sidecar 的 `name`；无 sidecar 时取文件/目录基名。
- 同一 `package#name` 重复出现时，该条目不可用并记录 `extensions.duplicate`；不同包同名不冲突。
- 清单中的 `providers` 本阶段**不装配**：只记录 `extensions.unsupported_contribution`，不注册供应商，也不进入清点。`clients` 不进入清点，由 `ClientRegistry` 按 §5.8.2 独立读取。
- `tools`、`wrappers`、`context` 的代码按需导入；`skills` 读取目录内容并转为 text 块。
- 工作区扩展在 `session.create` 确定 workspace 后清点，按 `realpath(workspace)` 缓存并冻结 `Inventory.hash`；`entries.snapshot` 使用冻结 inventory，新会话重扫。
- `Tools.forInventory` 使用该 inventory；不同 workspace 的同名工具不共享注册表。

#### 5.5.3 配置

- 配置来源优先级：工作区 `.pisces/config.json` > 全局配置文件 > 内置默认。目录驱动模式在每次
  `session.create` 重新读取两层；全局文件为 `options.configPath`（CLI `--config` 精确路径）或
  `<configDir>/config.json`。
- 默认 provider/model 从 `defaults` 读取，供 `session.create` 使用；工作区配置可覆盖软件配置。`defaults` 必须成对出现；旧的 `defaultProvider`/`defaultModel` 已移除。
- `defaultWorkspace` 只来自全局配置，供 `session.create` 在省略 `workspace` 时使用；工作区配置需要先确定工作区才能读取，因此不提供 `defaultWorkspace`，也不参与默认工作区解析；若出现按未知配置键处理。
- `defaultWorkspace` 必须是绝对路径；`config` 与 CLI 加载器只校验格式（不做 `~` 展开），存在性与可写性在 `session.create` 时检查。daemon 在每次 `session.create` 读取配置中的默认值，因此修改后新建会话立即生效，无需重启；`providers`/`templatesDir` 仍由启动选项固定。
- `config` CLI 只影响此后创建的会话；不修改既有会话的 `SessionMeta`。
- 新会话的默认扩展选择来自配置；`session.create.extensions` 显式列表替换默认选择。
- `entryConfig` 的键必须是当前清点中存在的 `wrapper` 条目，否则 `config.invalid`；它的合并顺序为 sidecar `config.defaults` < 用户覆盖（深合并），schema 校验合并结果：无用户覆盖时不合法只丢弃该包装器（`extensions.invalid`），有用户覆盖时不合法使整个 `prepare` 以 `config.invalid` 失败。
- 合并后配置的 `configHash`（SHA-256 + 键排序 JSON）在声明被确认时随定义冻结；声明与快照不包含配置正文。
- 全局配置与 CLI 共用统一 schema：扩展解析器接受并跳过 CLI 键 `dataDir`/`providers`/`templatesDir`；工作区层拒绝这些键。配置键不存在或类型错误返回 `config.invalid` / `config.unknown_key`。
- 扩展代码不直接访问配置文件；由 `Extensions` 读取并注入。

#### 5.5.4 装载

- 使用内置 TypeScript 加载器（jiti 或等价实现）按需转译 `.ts`/`.tsx`。
- 宿主包 `@pisces/*` 映射到 daemon 内的宿主实例，扩展不打包宿主包。
- 扩展依赖从其自身目录的 `node_modules` 解析。
- 装载器不因文件位于 `node_modules` 而拒绝加载；扩展无需预构建。
- 工具、包装器、上下文来源、技能按类型登记到对应注册表；`providers` 不装配，`clients` 由 `ClientRegistry` 独立装配。
- 包装器模块导出工厂与 `export const config`；工厂接收**合并后**的 sidecar defaults + 用户覆盖配置。模块只应在首次实际 invoke 时被导入，并且 `config` 必须描述 sidecar defaults（不是合并值），不一致时该次调用安全失败为 `tool.wrapper_invalid`，不透传模块异常文案。
- 工具声明需要的 `description/parameters` 来自 sidecar，不执行代码；实现代码在首次 invoke 时加载并缓存 promise；上下文来源在首次被选中装配时导入并 `resolve`。
- 一个扩展装载失败只标记该扩展不可用，不阻断 daemon 启动。
- 包装器按名称排序加入工具流水线；选择只决定是否加入；包装器只能装饰 `execute`，不得修改 `id/name/description/parameters`，违规返回 `tool.wrapper_invalid`。

#### 5.5.5 清点与选择

- `entries.snapshot` 返回工具、包装器、技能、上下文来源的 `EntrySnapshot` 投影：`name`、`kind`、`description?`、`parameters?`、`definitionHash?`、`configHash?`；不含条目路径、配置正文或执行函数。
- `entries.snapshot` 同时返回本会话 `effective` 列表：已固化名称、`definitionHash`、`configHash`、`stale`；内容条目的 effective 只有 name 与 stale。
- 工具与包装器的声明只序列化 `wireName`、`description`、`parameters`；实现代码留在本地。
- 技能内容作为系统消息进入装配；上下文来源片段按 `Context` 规则追加。
- 声明采用 all-toggle 快照：每个 toggle（无论打开或关闭）上的 tool/wrapper 名称都附带完整定义；类型变化在覆盖旧定义前检查，重新打开冲突类型按 `queue.invalid_control` 拒绝，关闭保留历史证据且不附加新类型快照；已持久化的关闭声明不得让后续重新打开合法。
- 历史分支已记录的内容条目（技能/上下文）在扩展被删除或改类型后仍可复用正文；工具/包装器的定义或配置哈希与当前清点不一致时标记 `stale`，不进 `LlmRequest.tools`、不参与包装，只能通过重新选择恢复。
- `providers`、`clients` 不参与选择。
- 扩展的安装、更新与移除由 npm、git 完成，不在本软件生命周期内。

### 5.6 `ProviderHost`

`ProviderHost` 实现 `ExecuteProvider`，负责 HTTP、凭据注入、超时、重试与传输分帧。

```ts
interface ProviderHost {
  execute(providerId: string): ExecuteProvider;
  ready(providerId: string): Promise<boolean>;
}

interface ProviderHostOptions {
  providers: ProviderManagement;
  credentials: Credentials;
  fetch?: typeof fetch;
  timeoutMs?: number;             // default 60_000
  maxAttempts?: number;           // default 3
  retryBaseDelayMs?: number;      // default 250
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}
```

- `ProviderDescriptor` 提供 `baseUrl`、`auth`、`headers` 与模型清单；`ProviderHost` 以 `baseUrl + WireRequest.path` 组合请求。
- `ExecuteProvider` 绑定到 provider；`AgentLoopDriver` 只接收注入的函数，不读配置。
- `CredentialStore` 以 `ProviderDescriptor.auth.credentialRef` 为键返回 `{type,value,expiresAt?}`；API key 与 OAuth access token 均以 Bearer 注入，OAuth 缺失或过期时按需刷新。`ready` 不触发刷新。
- 请求体为 `WireRequest.body`，每次重试保持一致。headers 以大小写不敏感语义合并：描述符 headers 先应用，适配器 headers 覆盖，`authorization` 最后由 Host 写入且不能被覆盖。URL 必须保留 `baseUrl` 路径前缀并拒绝跨 origin、反斜杠及原始/递归百分号编码的点段。
- 首个内置方言为 `openai-chat`，不支持图像/音频输出。请求路径默认 `/chat/completions`，`wireName` 上限为 64 个 ASCII 字符（标准形 `t_` + UTF-16LE 的 base64url，超限的纯 ASCII 名称回退到 `u_` + ASCII 字节的 base64url，解码两者都接受），所有 system 消息按顺序发送，已存储 reasoning 不重新发送，`stream_options.include_usage=true` 为默认值。
- 响应使用流式读取；媒体类型按大小写不敏感解析，`text/event-stream`（包括 `charset` 参数）的 `data:` 载荷作为字符串块交给 `LLMAdapter.parseChunk`；非 SSE 响应按单块处理。
- 每次尝试默认超时 60 秒；429 与 5xx 最多总计 3 次尝试，默认确定性退避 250ms、500ms；4xx（除 429）不重试；中止不重试；成功响应开始后不重试。
- 凭据缺失、类型不匹配、刷新失败、网络、fetch 与响应体读取错误映射为 `provider.transport`；尝试超时映射为 `provider.timeout`；HTTP 非 2xx 状态、无效 URL/headers 与响应解析错误映射为 `provider.invalid_response`。
- 2xx 响应体原样交给适配器，包括顶层 provider business error/refusal payload；`ProviderHost` 不解释模型内容。非 2xx 响应体视为 HTTP 状态错误，Host 不向适配器暴露。
- 错误消息不得包含凭据、Authorization、描述符 headers、响应体或原始 fetch 异常，也不保留原始异常为 cause。
- `ready` 要求 provider 存在、至少有一个模型，且 `credentials.get(credentialRef)` 返回类型匹配、未过期的凭据；空模型清单合法但恒为 false。

### 5.7 `WorkspaceAccess` 与 `ExecHost`

本节两个接口在核心层（`packages/core/src/exec/types.ts`）定义，服务层提供实现；均为**已实现**。二者由 `Gateway` 在 `turn.start` 时注入 `RunTurnInput`，再经 `Tools` 传给 `ToolInvocationContext.files`/`exec`。缺任一项时工具必须返回安全失败，不得改变读取与队列行为。

#### 5.7.1 `WorkspaceAccess`

```ts
interface WorkspaceAccess {
  resolve(path: string): string;
  ensureDirectory(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}
```

- 实现在 `packages/daemon/src/workspace/access.ts`：`createWorkspaceAccess(root)`，`root` 是已规范化的绝对路径（Gateway 用 `realpath(workspace)` 求得）。`resolve` 只接收相对路径，不再接收 workspace 参数。
- 规范化根：输入先按 `/` 折叠空段、`.` 与 `..`；绝对路径、空字符串、含 NUL、以及折叠时越过根的 `..` 一律抛 `PiscesError("workspace.path_outside", "Path is outside the workspace")`。
- 包含性判定：目标存在时 `realpath` 后要求落在根内；目标不存在时取**最深的已存在祖先** `realpath`，追回折叠后的剩余段，再对根做 `relative` 判定。因此符号链接目标指向根外、或符号链接祖先指向根外都被拒绝；尚不存在的子目录（写入/建目录场景）仍被允许。不缓存任何结果。
- `exists` 先解析再探测：根外探测同样抛 `workspace.path_outside`；`ENOENT` 映射为 `false`，其它 I/O 失败映射 `storage.io`。
- `writeFile` 先 `ensureDirectory(dirname(resolve(path)))` 再写入；`ensureDirectory` 递归创建。所有 I/O 失败统一抛 `PiscesError("storage.io", "Workspace access failed")`，固定文案不含路径与原始 cause，不透传到线上。
- 不提供删除、枚举、读取工作区外路径的能力；不提供沙箱：扩展代码可直接使用 `node:fs` 绕过该接口。

#### 5.7.2 `ExecHost`（`Exec` 接口）

```ts
interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}

interface Exec {
  run(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}
```

`ExecOptions` 见 HLD §6.5（`cwd`/`env`/`signal`/`timeoutMs`）。实现在 `packages/daemon/src/exec/exec-host.ts`：`createExecHost(options?)`，`options` 可覆盖默认超时与基础 `PATH`；`Gateway` 使用模块级单例注入每个新 turn。

- 使用 `spawn` 直接执行 command/args，不经过 shell；`stdio` 为 `["ignore", "pipe", "pipe"]`，子进程 stdin 关闭。
- 环境变量是白名单而非继承：子进程只看到显式 `env` 加基础 `PATH`（默认 `/usr/local/bin:/usr/bin:/bin`），不继承 `process.env`，因此不含凭据引用、socket 路径或 `HOME`。
- 超时 `timeoutMs` 截断到 `1..600_000`（缺省或非有限值取 `120_000`）；超时或 abort 只发一次 `SIGKILL` 并置 `timedOut`/`aborted`，已收集的输出保留在结果中。结果在 `close` 时解析；若 `exit` 先到而孙进程仍持有管道，**1 秒**后销毁两个流并以已收集输出解析，退出码取 `exit` 的值（缺失时用 `1`）。
- 每个流最多收集 `65_536` 字节，超出的部分丢弃并置对应的 `*Truncated`；截断后回退到 UTF-8 边界再解码，因此不会产生替换字符，且完整工具结果节点仍在 256 KiB 预算内。
- 非零退出不抛异常，由调用方判断；启动失败（含命令不存在）拒绝为 `storage.io`，固定文案 `Command could not be started`。
- 只 kill 直接子进程，不建进程组：孙进程可能在超时、turn 取消、甚至 daemon 被 `SIGKILL` 后继续运行，daemon 不监督孤儿进程。
- 不强制终止工具：abort 来自 `ToolInvocationContext.signal`（turn 取消）或工具自行传入的 signal。
- 不是沙箱：命令以 daemon 用户权限运行，可访问工作区外文件与网络。

### 5.8 `TemplateStore` 与 `ClientRegistry`

#### 5.8.1 `TemplateStore`

- 从软件配置目录的 `templates/` 读取模板；模板是声明式目录/文件/脚本。`startDaemon({ templates: { configDir } })` 在 lock 获取后、监听前构造 store，并注入 Gateway。
- 接口分五段：`list()`；`issues()`（加载器诊断，按 id 排序，只含 `id` 与安全错误码，不含路径或内容）；只读预检 `preview()` 与 `inspect()`（preview 加会话默认值，不读提示词文件，因而能在模板自身创建提示词文件前完成预检）；`resolve()`（含提示词读取）；`apply()`（校验、写盘、脚本、`ProjectRef`）。
- `apply` 自行再校验 `confirmed`；Gateway 已在调用前完成会话配置预检，因此预检失败时 store 未写任何内容。返回值 `TemplateResolution = { projectId, preview, defaults }`，不包含 `sessionId`：会话由 Gateway 创建。
- Gateway 复用预检得到的 `NewSession` 创建临时会话，只有提示词取自 `apply` 的 `defaults.systemPrompt`（写盘后才可读）；provider/model/extensions/binding 全部来自预检，因此 `apply` 成功后不再重跑会话校验，也不会有写盘后才发现会话配置非法的窗口。
- `apply` 由 `WorkspaceAccess` 创建目录/文件，`ExecHost` 以 `cwd=工作区` 执行脚本；写盘前已生成 `projectId`，`ProjectRef` 在脚本成功后原子追加到 `<dataDir>/projects.json`；失败不追加、不创建会话。
- 已创建文件不自动回滚；由用户处置。
- 模板提示词文件在写盘后经 `WorkspaceAccess.readFile` 读取，进入队列（`source="template"`），不直接写入请求体；仍须经首次 `turn.start` 的确认与落盘流程。

#### 5.8.2 `ClientRegistry`

```ts
interface ClientRegistry {
  list(): Promise<ClientRegistration[]>;
  start(id: string): Promise<{ pid: number }>;
}
```

- 实现在 `packages/daemon/src/client-registry/registry.ts`：`createClientRegistry({ extensions?, socketPath, env?, spawn? })`。没有 `register`：清单是唯一事实来源，注册表自己读取，避免第二个写入点没有调用方。
- 客户端登记来自扩展清单的 `clients`，由 `discoverClients(options)`（`packages/daemon/src/extensions/discovery.ts`）解析：源为内置目录与 `<configDir>/extensions`，工作区不参与；`entry` 必须是包目录内的脚本文件，否则记 `extensions.invalid` 并丢弃该声明；不同包复用同一 `id` 时两方都丢弃，每个包记一条 `extensions.duplicate`；结果按 `id` 排序。
- `list` 每次调用重新发现，因此装改扩展无需重启 daemon；`extensions` 缺省时恒返回空列表。
- `start` 校验 id（`list` 中不存在即 `client.not_found`），以 `node <entry>` 启动子进程：`stdio` 为 `["ignore","inherit","inherit"]`（继承的 stdout/stderr 即 `<dataDir>/daemon.log`），env 只有 `PATH`、`PISCES_SOCKET_PATH`、`PISCES_CLIENT_ID`，不继承 daemon 环境。
- `start` 等待子进程的 `spawn`/`error` 事件后 `unref()` 并返回 pid；spawn 失败返回 `client.launch_failed`。daemon 不保存句柄、不监听 `exit`，`stop` 不连带终止已启动的客户端。
- 客户端 stdout/stderr 由 daemon 日志接收，不混入协议。

### 5.9 服务层装配

- 公开装配路径是 `startDaemon`（§5.1.1）：宿主用同一个 `dataDir` 构造 store/marker/EventBus/Concurrency，再调用 `bootstrapGateway(deps)` 完成 `SessionStore.initialize()`、`markers.scan()` 恢复（逐会话隔离损坏标记）与 `createGateway`，最后绑定并校验 socket。`bootstrapGateway` 本身不做锁、socket 或 `Transport` 装配；返回 `{ gateway, initializationIssues, recoveryIssues }`，且须在任何请求被服务前完成。
- `Gateway` 依赖 `SessionStore`、`ActiveTurnStore`、`EventBus`、`Concurrency`、`ProviderManagement`、`ProviderHost`，以及可选的默认值、工具/条目/技能/来源工厂与 id/时间工厂。
- 目录驱动模式已装配 `Extensions`：`startDaemon({ extensions })` 在 lock 获取后构造真实服务并传入 `GatewayDeps.extensions`；该模式与手动注入互斥。CLI 的 `start` 总是选择该模式并传 `{ configPath }`。`TemplateStore` 按 `startDaemon({ templates: { configDir } })` 装配，与 `extensions` 模式可共存；`ClientRegistry` 与 `CredentialStore` 仍未装配。
- `Extensions` 依赖 `Tools`、`Skills`、`Context`；`providers` 清单项本阶段不装配，`clients` 清单项由 `ClientRegistry` 独立装配。
- `ProviderHost` 依赖 `CredentialStore` 与 `ProviderManagement`（目标设计）。
- `TemplateStore` 依赖 `WorkspaceAccess`、`ExecHost`、`projects.json`，输入 `configDir` 与 `dataDir`；会话创建能力保留在 `Gateway`。
- 核心层不引用服务层；服务层通过接口注入。
- 启动失败时关闭已打开的 socket、锁与子进程；不留下半初始化状态。

## 6 端到端流程

### 6.1 新建会话与首次落盘

本阶段已路由的路径如下；`client.*` 仍是未来目标方法（§3.3），不能作为现有客户端流程；模板路径见 §6.6。

1. 客户端调用 `session.create`，显式提供绝对、存在且可写的 `workspace`，或由目录驱动模式/手动 `defaults` 补全。可选的 `systemPrompt` 是字符串数组。带 `templateId` 时解析模板配置作为未显式提供字段的默认值（只读，不写盘）；宿主未装配 `TemplateStore` 时返回 `protocol.invalid_request`。目录驱动模式下：`extensions` 省略时取配置默认值，`[]` 禁用全部默认，显式列表替换默认；非空列表在创建临时会话前整体校验并富化定义快照。无扩展的手动模式下，显式或默认 `extensions` 非空即返回 `queue.invalid_control`，不创建临时会话。
2. `Gateway` 校验后在内存中创建临时 `SessionMeta`、`Context` 与队列；`systemPrompt` 的每个元素转成 `kind=agent`、`role=system`、`source="create"` 的队列条目。非空 `extensions` 另外生成一条带完整定义快照的未确认 `role=declaration` 条目（all-toggle）。
3. 返回临时 `SessionMeta`，尚不写盘；客户端可用返回的 id 调用 `session.read` 取得空记录、队列和空选择，可用 `entries.snapshot` 取得当前清点与已持久化选择，也可按连接 `session.subscribe`。
4. 客户端通过 `queue.enqueue` 添加 agent 消息，目录驱动模式下可提交 `role=declaration` 控制条目；再调用 `turn.start`；`Gateway` 先按目标分支校验未确认声明，再注册 turn，并在释放会话锁后启动 `AgentLoopDriver.run`。临时会话先在内存中暂存标记，不在 `turn.start` 时写盘。
5. `Context.assemble` 装配已确认的队列消息；若最终没有可见 agent 消息，turn 以 `turn.ended.error` 报 `turn.empty`，不落盘。
6. 首次持久化调用 `Sessions.create(meta, nodes)`；`SessionStore` 写入 `meta.json` 与 `events.jsonl`。提交成功后 `Gateway` 补写 `active-turn.json` 标记，**然后**才可发起供应商请求；补写失败以 `storage.io` 终止 turn，已提交节点不回滚。
7. `Context` 出队并更新选择；已订阅连接收到 `session.updated`（事件不重放）；之后 assistant 回复、工具结果由 `AgentLoopDriver` 使用 `Sessions.append` 追加。
8. 首次提交后会话已落盘，后续可由 `session.read` 按 id 读取，也可由 `session.list` 枚举。

失败边界：

- `Sessions.create` 提交点前失败：不写 meta/nodes，队列保留，临时会话仍在内存。提交点后 storage.io 按 §4.2.7 协调：整批已提交则按事实完成状态并仍抛原错误，读不清则保留 pending。
- 首次 turn 没有产生节点：`turn.empty`，不落盘，队列保留。
- 首次落盘后供应商请求失败：会话已落盘，turn 失败，队列已清空。
- daemon 在首次落盘前退出：临时 meta 与队列丢失，磁盘无空会话。首次 `Sessions.create` 已提交到 `active-turn.json` 补写之间的崩溃窗口仍未覆盖：即使有已落盘节点，也可能没有可供重启恢复的活跃 turn 标记；本阶段不承诺恢复该窗口。

### 6.2 读取会话与选择条目

1. 客户端发送 `session.read`。
2. `Gateway` 在会话锁内加载或复用运行时；已落盘会话创建 `Context` 并 `initialize`。
3. 无 `nodeId`：按 `limit` 字节预算分页返回会话树；有 `nodeId`：返回根到该节点的分支，分页规则相同。`nextCursor` 缺省表示结束。
4. `queue`/`selection` 只在首屏返回；`selection` 只含已持久化记录，不含队列中的声明 delta。
5. `records` 可能保留已取消选择的来源/技能节点；`selection` 表示当前是否启用。客户端不应以节点存在推断选中，`Context` 装配时按同一选择过滤请求内容。
6. `session.read` 不改变活动分支；分支由后续 `turn.start.nodeId` 选择。
7. `entries.snapshot` 返回当前清点与已持久化 `selection`/`effective`；客户端用它渲染面板，不可从 `session.read.selection` 推断可用条目清单（两者互补）。
8. 目录驱动模式下客户端通过 `queue.enqueue` 提交声明类控制消息即可改变选择；声明未确认前不影响 `selection`/`effective`，确认后随分支持久化。无扩展模式仍拒绝控制消息（`queue.invalid_control`）。
9. 订阅后，`queue.updated`、`selection.updated`、`session.updated` 与 turn 事件按 `sessionId` 推送。

临时会话：`records` 为空，`selection` 为空，`nodeId` 返回 `session.node_not_found`。

### 6.3 turn 执行与工具调用

1. `turn.start` 无活跃 turn：生成 `turnId`，确认队列，`mode=new`；有活跃 turn：只确认队列，`mode=steer`，不启动第二个 turn。
2. `AgentLoopDriver` 调用 `Context.assemble`；首次使用 `create`，之后使用上次返回的 `headId`。
3. `LLMAdapter.buildRequest` 构建供应商请求；`ProviderHost` 执行 HTTP/SSE 流。
4. 每个 step 使用独立 parser；产出文本、推理、工具调用、usage 与 stop reason；wireName 落盘前转为 EntryName。
5. 有工具调用时：
   - assistant 文本与 `toolCall` 写入节点；
   - `Tools.invoke` 执行工具；结果按原始调用顺序回填；
   - 工具结果写入 `tool` 节点；
   - `session.updated` 与 `turn.step` 推送；
   - 进入下一个 step。
6. 无工具调用时：assistant 回复写入节点；`session.updated` 与 `turn.step` 推送。
7. 队列中仍有已确认条目时，steer 在下一个 step 装配；没有已确认条目且无工具调用时结束，`turn.ended` 推送。
8. 供应商错误转为 `turn.ended.failed`；工具错误作为错误结果回填，不终止 turn。

### 6.4 取消与 steer

**取消**

1. 客户端调用 `turn.cancel`，`Gateway` 定位活跃 turn。
2. driver 置为 `cancelling`，abort 供应商流，置工具 signal。
3. 不再发起新 step；当前工具允许协作中止并回填结果。
4. 已产生的 assistant 回复写入节点；追加 `role=cancel` 控制消息，`at` 为当前最后节点；清除未装配条目的 `confirmedAt`。
5. `turn.ended` 的 `reason` 为 `cancelled`；客户端连接与订阅不受影响。

**steer**

1. 活跃 turn 中客户端入队新消息；`queue.updated` 推送。
2. `turn.start` 返回已有 `turnId` 与 `mode=steer`，不启动新 turn。
3. driver 在当前 step 结束后检查队列；下个 step 装配新增条目。
4. `nodeId` 在活跃 turn 中禁止；越界返回 `turn.node_id_forbidden`。

### 6.5 daemon 崩溃恢复

启动恢复顺序：

1. `SessionStore.initialize` 只清理无 `meta.json` 的普通会话孤儿目录；有 meta 但 commit 缺失或非法须保留并报告 `storage.corrupt`。
2. 逐会话校验 meta、schema、commit 偏移与已提交节点记录，故障收集为初始化报告，隔离损坏会话。
3. 对健康会话截断 commit 后的未提交尾部并同步，清理三个受控 `.tmp`；损坏会话不截尾、不清理，不返回部分记录。
4. 仅对存在 active-turn 标记的会话恢复：从标记的 `startNodeId` 开始，用 `SessionStore.readTreeSince(startOffset)` 只扫描字节偏移不小于标记 `startOffset` 的已提交节点，按提交顺序沿每个节点的最后一个子节点推进到本 turn 已提交端点（同会话仅一个活跃 turn）；没有后续节点时使用起点。临时会话没有 `startNodeId`，取窗口内第一个已提交节点，从根沿追加链确定端点。只在该路径查找最后 assistant 节点；对缺少对应 toolResult 的 toolCall 按调用顺序合成 `synthetic="interrupted"` 的 toolResult（内容为“结果未知，可能已部分生效，请核验”）。同一原子 `Sessions.append` 批次把这些合成结果接在端点之后，再把 `role=cancel` 控制消息接在最后一条合成结果（无合成结果时接在端点）之后；`reason=daemon_restart`，`cancel.at` 为恢复前的真实已提交端点 `endpointId`，不是批内生成的合成节点 id。追加提交成功后才删除标记。
5. 恢复为冷会话；`turn.list` 为空；客户端重新 `session.read`。

恢复幂等：

- 去重以 `turnId` 为键，但只在 `startOffset` 窗口内、且位于本次走过路径上的 `cancel` 生效：命中则只删除标记，不追加合成结果或 cancel；窗口外或非选中兄弟分支上的同 `turnId` cancel 不算命中，也不会删除标记。
- 追加已提交但抛 `storage.io` 时保留标记；下次恢复命中这条已提交的 cancel，只删除标记而不重复追加。

活跃 turn 标记：

- 路径：`<dataDir>/sessions/<sessionId>/active-turn.json`。
- 内容：`{ turnId, startedAt, startOffset, startNodeId? }`；`startNodeId` 固化本次 turn 实际起点（显式 nodeId 或启动时默认末节点），临时会话省略；`startOffset` 为启动时 events.commit 的字节偏移，临时会话为 0，用于排除起点已有的历史子分支。起点与偏移在同一会话锁内确定，已落盘会话的标记原子写入成功后才启动 driver；由 `Gateway` 在 `turn.start` 启动 driver 前写入，正常结束后删除。
- 标记是服务层运行时状态，不进入 `SessionMeta`、不进入 `events.jsonl`、不参与选择；读写接口见 §5.3.5。
- 已落盘会话在 `turn.start` 的会话锁内写标记，写成功后才确认队列、登记并启动 driver。临时会话在 `turn.start` 只记录待写标记，等首次 `Sessions.create` 提交成功后补写（`startOffset=0`、无 `startNodeId`）；补写失败以 `storage.io` 结束该 turn，发生在任何供应商请求之前：已提交节点与已确认队列的消费不变量保持不变、不回滚，磁盘无标记。
- 首次落盘提交与补写标记之间的进程崩溃窗口不可恢复：会话已落盘但没有标记，恢复不会为该 turn 合成 interrupted 结果或 cancel。本设计明确不覆盖该窗口。
- driver 结束进入 `cleanup` 后才删除标记，删除成功才注销 turn；删除失败按 §5.3.2 的 `cleanup_failed` 流程处理：发布 `turn.cleanup_failed`、必要时追加同 `turnId` 的 `cleanup_failed` cancel、重试删除一次，仍失败则保留标记与登记的 `cleanup_failed` turn。
- 恢复追加失败（含提交点后抛 `storage.io`）保留标记，下次启动重试；同 `turnId` 去重只在 `startOffset` 窗口内的走过路径生效，因此已提交的 cancel 不会重复追加。`cleanup_failed` cancel 已提交时，恢复按同 `turnId` 去重只删除标记，不追加 `daemon_restart` cancel；若该 cancel 也未能提交，恢复按正常规则补齐。

未完成工具：

- 工具执行不是崩溃恢复的事务边界；已写入的工具结果保留，未写入的调用合成 interrupted 结果。
- 恢复后不自动重放工具；用户可继续会话或重新发起 turn。
- 队列未持久化，崩溃时未出队条目不恢复。

### 6.6 模板创建

1. 用户调用 `template.list` 选择模板，再调用 `template.preview`；只解析与展示目录、文件、冲突、脚本 argv 与 `timeoutMs`，不写文件、不跑脚本。
2. 用户确认后调用 `template.apply`，必须带 `confirmed=true`；缺 `confirmed` 或存在冲突且未带 `overwrite=true` 时在读写前拒绝。
3. 只读预检：先以 `inspect` 计算冲突，再由 `Gateway` 校验工作区与会话配置（provider/model、extensions）；任何失败都发生在写盘之前。
4. 预检通过后 `WorkspaceAccess` 创建目录与文件，`ExecHost` 以模板 `timeoutMs` 执行初始化脚本。
5. 脚本成功后读取 `systemPromptFile` 并原子追加一条 `ProjectRef`；`Gateway` 创建临时会话，将模板配置/提示词物化为队列条目（提示词 `source="template"`）。
6. 返回 `{projectId, sessionId}`；会话在首次 `turn.start` 前不落盘，首次 turn 仍按 §6.1 落盘。
7. 脚本失败返回 `template.init_failed`，不写 `ProjectRef`、不创建会话；已创建文件不自动回滚。

### 6.7 扩展装载与条目刷新

1. daemon 启动时发现扩展清单，不执行扩展代码；目录驱动模式在首次建会话/加载会话时冻结一份绑定。
2. 读取配置，合并默认选择；条目名称统一为 `package#name`；`entryConfig` 只接受包装器条目并深合并到 sidecar defaults。
3. 用户打开面板时调用 `entries.snapshot`；工具、包装器、技能、上下文来源以 `EntrySnapshot` 投影进入结果，并返回 `selection`/`effective`。
4. 用户选择条目时入队声明类控制消息（all-toggle 定义快照）；`Context` 在装配时更新选择。
5. 工具/包装器在首次实际调用时由加载器导入；上下文来源在首次选中装配时 `resolve`；技能正文在发现时读取、首次装配时写入会话。
6. 扩展安装或更新后，新会话使用新清点；既有会话记录不改写，只把定义/配置哈希不匹配的条目显示为 `stale`，重新选择才写入当前定义。
7. 同一 `package#name` 重复出现时该条目不可用；不同包同名不冲突。

## 7 CLI 与数据迁移

### 7.1 CLI 与协议边界

实现状态：本阶段已实现 `start`、`status`、`stop`、`templates list`/`preview`/`apply`、
`config list|get|set|unset`、`extensions list`、`sessions list|export|cancel`、`client list|start`、
`run`、`provider list` 与 `models list`。生命周期命令经
pid 记录、进程存活检查与对 `<dataDir>/run/pisces.sock` 的 `protocol.hello` 探测完成，使用协议做就绪/归属探测；
`status` 在 `running`/`unmanaged` 时额外用一次短连接调用 `turn.list`，按出现顺序去重输出活跃
`sessionId`（只读，查询失败不改变退出码）；模板命令、`sessions` 命令经短连接调用 `template.*` /
`session.list` / `session.read` /
`turn.list` / `turn.cancel`（详见 `docs/templates.md`、`docs/cli.md`）；`sessions export` 按
`nextCursor` 分页输出 JSONL（每行一个 `SessionNode`，不包装），默认整棵树、`--node <id>` 只输出根到该
节点的祖先链；`sessions cancel` 用 `turn.list` 按 `sessionId` 选择活跃 turn 后逐个 `turn.cancel`，无活跃
turn 时输出 `no active turn` 并退出 0，`{cancelled:false}` 映射为 CLI 本地的
`turn.cancel_failed`（退出 1）。`run` 经短连接组合 `session.create`/`session.list`/`session.read`/
`session.configure`、`queue.enqueue`、`session.subscribe`、`turn.start` 与 `turn.cancel`：提示词只入队，
客户端先订阅再入队，只等目标 `turnId` 的 `turn.ended`（详见 §7.2）。
`config` 直接读写本地配置层，`extensions list` 只做本地发现且不加载扩展代码。`provider list` 与
`models list` 经短连接调用 `provider.list`，不读本地 provider 定义、不碰凭据：前者输出
`id  ready|unready  models=<n>`；后者把模型展平为 `provider/model`（provider 按 `id` 字典序，
模型保持 daemon 顺序），`--provider <id>` 只保留该 provider，未知 id 以 CLI 本地的
`provider.not_found` 退出 1。`client list` 与 `client start` 经短连接调用 `client.list`/`client.start`：
前者每行 `id  source`（空清单不输出），后者输出 `started <id> (pid <n>)`；`--json` 分别原样回显
`{clients}` 与 `{pid}`，结果结构不合法为 CLI 本地的 `client.protocol`，`client.not_found`/
`client.launch_failed` 原样转发并退出 1（详见 `docs/cli.md`）。表中其余命令为目标设计，**未实现**；
`--help`、`--version` 已实现。

| 命令 | 路径 |
|---|---|
| `start` / `stop` / `status` | 本地 daemon 生命周期（已实现；`status` 另读 `turn.list` 的活跃会话） |
| `run` | 经协议创建/读取会话、入队、订阅、`turn.start`/`turn.cancel`（已实现） |
| `sessions list` | 经协议 `session.list`（已实现） |
| `sessions export` | 经协议 `session.read` 输出 JSONL（已实现） |
| `sessions cancel` | 先解析活跃 turn，再 `turn.cancel`（已实现） |
| `client list/start` | 经协议 `client.list` / `client.start`（已实现） |
| `templates list/preview/apply` | 经协议模板方法（已实现） |
| `provider list` / `models list` | 经协议只读查询（已实现） |
| `providers check` | 仅 CLI，直接检查本地凭据与配置 |
| `extensions list` | 仅 CLI，读取扩展目录（已实现） |
| `auth` | 仅 CLI，校验凭据 |
| `config list/get/set/unset` | 仅 CLI，直接读写本地配置（已实现） |

- 管理命令不经 daemon 协议；daemon 在使用时读取配置。
- `config` 只影响此后创建的会话，不改写既有会话。
- CLI 不直接访问 `events.jsonl`；会话读取与导出经协议/服务层。
- 全局配置为统一 schema：CLI 组 `dataDir`/`providers`/`defaults`/`templatesDir` 与扩展组
  `defaults`/`defaultWorkspace`/`extensions`/`entryConfig` 共存；`start` 只将 `--config` 的绝对路径
  作为 `extensions: { configPath }` 注入，扩展层由 daemon 在 `session.create` 时读取，扩展解析器忽略
  CLI 键。默认 provider/model 只使用 `defaults`；旧 `defaultProvider`/`defaultModel` 按未知键拒绝。provider
  方言固定为 `openai-chat`。

### 7.2 `run`

非交互 `run` 与 `client list`/`client start` 已实现；`providers check`、`auth` 仍未实现。`sessions list|export|cancel`、
`provider list`、`models list`、`config`、`extensions list` 与模板命令见 §7.1 与
`docs/templates.md` / `docs/cli.md`。以下为当前行为，不再是目标设计。

```text
pisces run [prompt] [--new | --continue | --session <id> [--create]]
           [--workspace <dir>] [--model <id>] [--provider <id>]
           [--system-prompt <text> | --use-default-system-prompt]
           [--enable <package#name>]... [--disable <package#name>]...
           [--print | --json] [--config <path>] [--data-dir <dir>]
```

- 非交互：只创建一个 turn 并等待结束，不读取 stdin、不循环、不做多轮输入；`[prompt]` 必填且去空白后
  非空，位置参数可在任意选项前后，多余位置参数是用法错误。
- 会话选择（`--new`/`--continue`/`--session` 互斥，缺省等同 `--new`）：`--continue` 取 `session.list`
  中 `createdAt` 最大的已落盘会话（并列取 daemon 返回顺序第一个），空则 `session.not_found`（1）；
  `--session <id>` 先做一次 `session.read {limit: 1}` 存在性检查，不存在且带 `--create` 时新建，
  否则 `session.not_found`（1）；`--create` 只能与 `--session` 同用；id 必须匹配 `[A-Za-z0-9_-]+`。
- 会话选项：`--workspace` 必须是绝对路径，只传给本次新建的 `session.create`（`--new`、缺省选择器、
  或 `--session --create` 且会话不存在），显式值优先于配置中的默认工作区（daemon 在 `session.create`
  时读取）；既有会话（`--session`
  命中或 `--continue`）与 `--workspace` 同用时本地返回 `run.workspace_unsupported`（1），不配置、
  不入队、不启动 turn。该拒绝只针对已落盘会话：`--continue` 没有任何已落盘会话时先以
  `session.not_found`（1）失败，不会报 `run.workspace_unsupported`。省略时由 daemon 解析默认工作区：
  未配置则 `session.workspace_required`，已配置但不可用则 `session.invalid_workspace`，两者均由 daemon
  返回、CLI 退出 1。
  `--model`/`--provider` 对新会话交给 `session.create`、对既有会话交给
  `session.configure`（既有会话两者必须成对，否则 daemon 返回 `session.model_required`）；
  `--system-prompt` 对新会话交给 `session.create.systemPrompt`、对既有会话交给
  `session.configure.systemPrompt`；`--use-default-system-prompt` 只对新会话有效，对既有会话本地返回
  `run.default_system_prompt_unsupported`（1）。
- 扩展选择：`--enable`/`--disable` 重复给出 `package#name`；一次有界 `session.read`（`limit: 1`）同时
  取回已提交 `selection` 与整个队列，按队列顺序在提交选择上重放未确认的
  `control`/`declaration` toggle，再按参数顺序求差集（先 enables 后 disables）。只有实际变化才生成一条
  `{kind:"control",role:"declaration",source:"run"}`，`content` 为 `[{"toggle":[names]}]`，与提示词在
  同一 `queue.enqueue` 批次提交（控制条目在前）；无变化不发。手动模式 daemon 以
  `queue.invalid_control` 拒绝控制条目。
- 事件与输出契约：`run` 在入队前 `session.subscribe`，只处理 `sessionId`/`turnId` 匹配的事件；
  `turn.delta` 只拼接 `kind="text"` 的 `delta`；只有目标 `turnId` 的 `turn.ended` 结束命令，重复或
  无关事件忽略；连接中途断开按 1 退出（不等 `turn.ended`）。默认把 delta 写 stdout 并在结束时补换行；
  `--print` 只在结束时写最终文本加换行；`--json` 只写一行
  `{sessionId,turnId,reason:"completed"|"cancelled"|"failed",text,error?}`，`error` 仅 `failed` 时出现
  且为 daemon 投影的 `{code,message}`。提示词从不写入请求体。
- 退出码：完成 0；失败 turn、协议/会话/连接错误 1；用法或 `config.invalid` 2；取消（Ctrl-C 或外部
  `sessions cancel`）130。Ctrl-C 经可注入 seam 触发，只发一次 `turn.cancel {turnId}` 并等待
  `turn.ended`。用法/配置/建立连接阶段的错误只写 stderr，即使 `--json` 也不产生 JSON 对象；失败 turn
  在 `--json` 下只写对象（含 `error`）且 stderr 为空，人类模式写 `error: <code>: <message>`。
- 失败码由 daemon 的 `turn.ended` 投影决定：目前仅 `turn.empty` 保留原码，其他失败一律
  `internal.error: Turn failed`，CLI 不回显供应商、适配器或异常原文。
- 限制：交互式 stdin 循环与多轮输入仍未实现；没有 `--output`；不会直接读会话文件或事件日志。

### 7.3 数据迁移

- 当前 `schemaVersion` 为 `1`；`SessionMeta` 与 `SessionNode` 都带版本。
- `SessionStore` 在加载时校验版本：
  - 等于当前版本：直接读取；
  - 低于当前版本：按版本迁移函数升级；
  - 高于当前版本：拒绝加载并报告 `storage.corrupt`。
- 迁移函数按版本注册；迁移失败不返回部分结果。
- 读取路径只在内存中迁移，不写回文件；写回只发生在 `append`、`updateMeta` 或显式 `pisces storage migrate`。
- 写回前重新迁移整文件，失败保留旧文件并报告。
- `events.jsonl` 逐行迁移；同一提交段落中的节点版本必须一致，混合版本报错。
- 当前没有历史版本，第 1 版是初始格式；新增字段必须保持向后兼容或提升版本。
- 协议版本与会话 schema 版本独立；协议次版本兼容不代表旧会话格式兼容。

### 7.4 导出

- `sessions export <id>` 输出 JSONL：每行一个 `SessionNode`（不额外包装、不裁剪字段）；默认导出
  整棵会话树，顺序为 `session.read` 的追加顺序。`--node <id>` 只导出从根到该节点的线性祖先链。
- 不导出队列、选择状态、`meta` 或临时状态；只写 stdout，不提供 `--output`。
- 会话不存在为 `session.not_found`，节点不存在为 `session.node_not_found`；导出可能包含敏感内容，
  是否导出由用户决定。
- 导出不修改会话记录，不改变活动分支。

### 7.5 失败与恢复约定

- 首次落盘在提交点前失败：重读确认 absent 后队列保留，无 meta/nodes；客户端可重试。提交点后 I/O 失败可能已整批落盘，按 §4.2.7 重读完整 suffix 确认；确认 committed 则完成内部状态与通知，仍原样抛首个 storage.io，不能仅凭 storage.io 盲目重试。
- 上下文装配追加在提交点前失败：确认 absent 后队列保留，选择缓存不更新；不继续请求。提交点后失败须按默认追加水位后的完整 suffix、本次父节点及 draft 字段核对；确认 committed 则出队并更新选择/persisted，仍抛原 storage.io。结果读不清或不匹配时保留内存 pending，snapshot 可读旧缓存，其他修改返回 context.pending_commit、data.retryable=true；initialize/assemble 锁内先协调，持续失败不写入，恢复后先清 pending 再通知。pending 不落盘、不作为 WAL。
- 声明选择或默认 head 在一次重跑后仍变化，返回 `context.changed`、`data.retryable=true`；未来 Gateway 原样映射上述内部错误，本轮不新增协议实现。
- 装配取消通过 AbortSignal 的原始 reason 传播，不新增取消协议码；持久化后的事件回调异常不得触发持久化失败补偿。内部状态先完成，再独立尝试全部通知；原 storage.io 优先于通知错误，否则抛首个通知错误。通知序号允许间隙，重连 read 恢复。
- assistant/tool/cancel 追加失败：不继续请求；已写节点保留；队列已出队，不自动恢复。
- 取消写入失败：turn 仍结束，但标记未落盘；重启时无法恢复该标记，用户可继续。
- 恢复时 `meta.json` 损坏或有 meta 但 commit 缺失/非法：保留会话原始文件，收集 `RecoveryIssue`；该会话不可加载，不影响直接读取其他健康会话，`list` 整体拒绝。
- 恢复时节点损坏：不加载该会话，不返回部分记录。
- 临时会话、队列、活跃 turn 标记在 daemon 退出时按各自规则清理或保留。

CLI 生命周期约定（已实现）：

- 退出码：`0` 成功，`1` 运行时失败（已在运行、未知属主、启动失败、停止超时、socket 无属主、
  pid 文件写入或清除失败），`2` 用法或配置错误（用法错误、`config.invalid`、
  `config.missing_api_key`、`daemon.insecure_directory`）。
- 用户可见输出只有固定码与固定消息：`config.invalid`（`Invalid configuration`）、
  `config.missing_api_key`（`Missing API key environment variable`）、
  `daemon.already_running`、`daemon.unknown_owner`、`daemon.start_failed`、`daemon.stop_timeout`、
  `daemon.insecure_directory`、`daemon.unmanaged`、`storage.io`；`start` 失败额外打印
  `log: <dataDir>/daemon.log`。不打印密钥、环境变量名、配置值或原始错误。
- 文件位置与权限：`<dataDir>/daemon.pid`（`0600`，单条 JSON `{pid, socketPath, startedAt}`，以
  `open(..., "wx", 0o600)` 独占创建）、`<dataDir>/daemon.log`（`0600`，子进程 stdout/stderr）、
  `<dataDir>/run/pisces.sock` 与 `<dataDir>/run/pisces.lock`（`0600`，由 daemon 维护）。
  `dataDir` 策略（绝对路径、当前 uid 拥有、无 group/world 写位、`0700` 创建）**只由 `start` 执行**；
  `status`/`stop` 不校验该策略，只读 pid 记录并探测由 dataDir 推导的 socket；`status` 在探测
  成功后还会在同一 socket 上调用一次 `turn.list` 列出活跃会话。
- `start`：一个 10 s 墙钟预算覆盖预检探测与就绪轮询；轮询 50 ms，要求子进程存活、pid 记录仍指向
  该子进程、且由 dataDir 推导的 socket 握手成功。子进程句柄携带 `'error'` 监听，libuv 启动失败
  （EAGAIN/EMFILE/ENOMEM）只表现为 `daemon.start_failed`，不崩溃、不打印原始错误。失败时 SIGTERM
  自己的子进程、仅在记录仍指向它时删除记录。并发启动靠独占 pid 记录选出唯一赢家，输家不改写、
  不清理赢家的记录。
- 陈旧/损坏 pid 文件：记录中的进程已退出时 `status` 报 `stopped (stale pid file)`（`1`）并删除，
  `stop` 报 `not running`（`0`）并删除，`start` 回收后启动；文件内容不可解析时视为无属主记录，
  `status`/`stop` 按未运行处理，`start` 在确认本 dataDir 的 socket 不应答后清除它。
- `daemon.unknown_owner` 恢复：记录中的 pid 存活但由 dataDir 推导的 socket 不应答（或记录中的
  `socketPath` 与推导路径不一致）时，`start`/`status`/`stop` 都退出 `1`，**不发送任何信号**并保留
  记录（防止 PID 复用误杀）。身份只由推导路径证明，记录里的 `socketPath` 仅作诊断，`status`/
  `stop` 的输出与 `status --json` 也只输出推导路径。必须先 `ps -p <pid>` 确认该进程身份；是本
  dataDir 的 daemon 才可人工 SIGTERM，否则只删除 `daemon.pid`。详见 `docs/cli.md` §7。
- `status`：`running`/`unmanaged` 时用一次短连接调用 `turn.list`，按出现顺序去重输出活跃
  `sessionId`。握手与该请求各用 `PROBE_TIMEOUT_MS`（500 ms，与探测预算相同），socket 在探测后
  不再应答也不会让 `status` 阻塞在客户端默认的 5 s 预算上。人类输出在状态行后追加
  `sessions: <id...>`（无活跃 turn 为 `sessions: none`，查询失败为 `sessions: unavailable`）；
  `--json` 仅在查询成功时增加 `sessions` 数组，失败或未查询
  （`stopped`/`stale`/`unresponsive` 与 `daemon.unknown_owner` 早退）时省略。查询失败不改变退出码、
  不写 stderr，也不输出 turnId、时间戳或错误原文。
- `stop` 先握手再发信号，握手失败不调用 `kill`；`stop` 输出 `stopped (pid N, socket S)`，其中 `S`
  是推导路径；`stop` 超时保留记录并以 `daemon.stop_timeout` 退出 `1`；无记录但 socket 应答时报
  `daemon.unmanaged`（`1`），同样不发送信号。

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
- 供应商 429/5xx 最多总计 3 次尝试，默认退避 250ms、500ms；4xx（除 429）、取消及成功流开始后不重试。
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
- 验收覆盖：多 step 的父指针连续性；分页期间队列更新不丢失；活跃 turn configure 整体拒绝；非默认分支在无新增节点时崩溃恢复；增量展示与最终节点替换、失败及取消清理；包装器注册顺序变化不影响按名称应用。
- 不做真实供应商网络测试；供应商方言由适配器单测覆盖。
- 测试不依赖具体时钟、随机 id 或执行顺序。

### 8.6 构建与分发

- pnpm 工作区；`tsc -b` 构建 `protocol`、`core`、`daemon`、`cli`。
- Node 版本遵循根 `package.json`；ESM。
- CLI 入口为 `packages/cli/package.json` 的 `bin.pisces` → `dist/main.js`；后台子进程入口为
  `dist/daemon-child.js`，二者都经 `realpath` 比较 `process.argv[1]` 决定是否作为入口执行，symlink
  调用同样有效。仓库内 `dist/main.js` 不带可执行位，本地用 `node packages/cli/dist/main.js` 调用。
- CLI 依赖已构建的原生插件 `packages/daemon/native/peercred.node`；切换 Node 版本后必须重建，否则
  `start` 以 `daemon.start_failed` 失败（日志为 `daemon.native_unavailable`）。
- 仅 Linux x64 已实现并验证；macOS/Windows 是目标设计。
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

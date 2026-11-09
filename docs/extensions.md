# 扩展：发现、选择与执行契约

本文件描述当前已实现并已被真实 Unix socket 端到端验收的扩展契约。它只覆盖本阶段交付的部分：
目录发现、清点、声明式选择、冻结定义、按需装载、`entries.snapshot` 与队列路由。**未交付**的能力在
文末“本阶段未交付”一节明确列出。权威设计见
`docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §5.5 与
`docs/1 High-Level Design/1 High-Level Design.md` §5.4、§6.6。

## 1. 目录与包结构

扩展是普通包或目录。按优先级发现三个来源：

| 来源 | 路径 |
|---|---|
| 内置 | `<daemon 模块目录>/extensions/builtin`（默认由 daemon 模块 URL 推导，不从工作目录推导） |
| 软件配置目录 | `<configDir>/extensions/` |
| 工作区 | `<workspace>/.pisces/extensions/` |

- 每个直接子目录为一个包；以 `@scope` 开头的目录下再取一层子目录，包名仍以 `package.json` 的
  `name` 为准。
- 包名必须是合法 npm 包名（可带 `@scope/`），且不能以 `.` 开头。
- 条目名称统一为 `package#name`：`package` 取包名，`name` 取 sidecar 的 `name`；没有 sidecar 时取
  文件/目录基名。同一 `package#name` 在两个目录重复出现时，该名称整体不可用并记录
  `extensions.duplicate`；不同包可以同名。
- 发现阶段只读取 `package.json`、sidecar 元数据与 `SKILL.md`，**不导入任何实现模块**。

### 1.1 声明条目的两种方式

1. 约定目录（没有 `pisces` 字段时）：

```
demo/
  package.json                 # { "name": "demo" }
  tools/run.ts                 # 条目 demo#run
  tools/run.ts.meta.json
  wrappers/audit.ts            # 条目 demo#audit
  wrappers/audit.ts.meta.json
  skills/guide.meta.json       # 条目 demo#guide
  skills/guide/SKILL.md
  context/notes.ts             # 条目 demo#notes
  context/notes.ts.meta.json
```

2. `package.json` 的 `pisces` 字段显式给出 glob 与排除项：

```json
{
  "name": "demo",
  "pisces": {
    "tools": ["./src/tools/*.ts", "!./src/tools/internal-*.ts"],
    "wrappers": ["./src/wrappers/*.ts"],
    "skills": ["./resources/skills"],
    "context": ["./src/context/*.ts"]
  }
}
```

- `tools`、`wrappers`、`context` 接受 `.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs`
  （排除 `.d.ts`），路径必须解析在包目录内。
- `skills` 指向目录，目录内必须存在 `SKILL.md`。
- 未知清单键、非法 glob、指到包外的路径或缺失的 `SKILL.md` 会产生 `extensions.invalid` 问题，
  该条目被丢弃，不影响其它条目。
- `pisces` 字段中的 `providers`、`clients` 会被解析但**不装配**，只记录
  `extensions.unsupported_contribution`；声明它们不会让 daemon 失败。

### 1.2 sidecar 元数据

- 工具/包装器/上下文来源：`<entry文件>.meta.json`，例如 `tools/run.ts.meta.json`。
- 技能：与技能目录相邻，`skills/<name>.meta.json`，正文为 `skills/<name>/SKILL.md`。
- 允许的键只有 `name`、`description`、`parameters`、`config`：

```json
{
  "name": "run",
  "description": "Runs one query",
  "parameters": { "type": "object", "properties": { "query": { "type": "string" } } }
}
```

- `parameters` 只对 `tool`/`wrapper` 合法；`config` 只对 `wrapper` 合法，其它类型出现即
  `extensions.invalid`。
- 缺省 `description` 为 `""`，缺省 `parameters` 为 `{}`。
- `name` 不得包含 `#` 或空白。

### 1.3 包装器配置

```json
{
  "description": "Audits every tool call",
  "config": {
    "defaults": { "tag": "default", "n": 1 },
    "schema": { "type": "object", "properties": { "tag": { "type": "string" } } }
  }
}
```

- `defaults` 与 `schema` 都是必需键；`schema` 用本地 Ajv（draft-07、无远程引用、不执行异步
  validator）编译。
- 合并顺序是 sidecar `defaults` < 用户 `entryConfig` 覆盖（深合并），校验对象是**合并结果**：
  - 没有用户覆盖且合并结果不合法：该包装器以 `extensions.invalid` 问题丢弃；
  - 有用户覆盖且合并结果不合法：整个 `prepare` 以 `config.invalid` 失败，不降级。
- 包装器模块必须导出 `export const config`（若存在）描述 sidecar `defaults`，而不描述合并后配置。
  模块 `config` 与 sidecar `defaults` 不一致时，调用该包装器得到 `tool.wrapper_invalid`，
  不把模块异常文案透传到线上。
- 合并后配置的 `configHash`（SHA-256 + 键排序 JSON）在声明被确认时随定义快照冻结。

## 2. 配置层级

| 层级 | 文件 | 说明 |
|---|---|---|
| 内置默认 | 包内 sidecar `config.defaults` | 只对包装器生效 |
| 全局 | `<configDir>/config.json` | 可含全部配置键 |
| 工作区 | `<workspace>/.pisces/config.json` | `defaultWorkspace` 在此层非法 |

- 允许键：`defaultWorkspace`、`defaultProvider`、`defaultModel`、`extensions`、`entryConfig`。
- 未知键 → `config.unknown_key`；类型或组合非法 → `config.invalid`。
- `defaultWorkspace` 只允许出现在全局层且必须是绝对路径；它只在 `session.create` 省略
  `workspace` 时使用。
- `defaultProvider` 与 `defaultModel` 必须成对出现；`session.create` 也接受显式成对值。
- `extensions` 是默认选择（`package#name` 数组）；`session.create.extensions` 显式给出时
  **替换**默认值，给出空数组即禁用全部默认。
- `entryConfig` 的键必须是当前清点中存在的 `wrapper` 条目，否则 `config.invalid`。

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5",
  "extensions": ["demo#run", "demo#audit"],
  "entryConfig": { "demo#audit": { "tag": "workspace" } }
}
```

## 3. 选择、声明与冻结定义

选择以声明类控制消息持久化：`kind="control"`、`role="declaration"`，内容恰好一个文本块：

```json
{ "toggle": ["demo#run", "demo#guide"], "definitions": [ /* 由 daemon 附加 */ ] }
```

- `toggle` 是异或：每个名称出现一次翻转一次状态；名称不得重复（`queue.duplicate_name`）。
- 客户端只提交 `toggle`。带 `definitions` 或其它任何键的客户端声明以 `queue.invalid_control`
  拒绝；内联定义永远不会被采信。
- daemon 在入队时做纯同步富化，为**每个** toggle 名称附加完整定义快照：
  - 打开或关闭都携带快照（all-toggle snapshots）；
  - `tool`/`wrapper` 的快照字段为 `name`、`kind`、`description`、`parameters`、
    `definitionHash`，包装器另含 `configHash`；
  - `skill`/`context` 没有定义快照。
- 类型变化边界：若历史分支已记录某名称的类型证据，而当前清点类型不同：
  - 该声明仍让名称保持选中（重新打开）→ 整批 `queue.invalid_control`，不覆盖旧定义；
  - 该声明关闭名称 → 允许，保留历史证据、丢弃新类型快照。
- 未知名称（当前清点没有、历史也没有）→ `queue.invalid_control`。
- 未确认的声明不改变 `entries.snapshot.selection/effective`，也不进入装配请求；`turn.start`
  在写标记、确认与注册 turn 之前，按本次将执行的精确分支重新校验整批声明。

## 4. `entries.snapshot`

```json
{
  "entries": [
    { "name": "demo#run", "kind": "tool", "description": "Runs one query",
      "parameters": { "type": "object" }, "definitionHash": "…" },
    { "name": "demo#audit", "kind": "wrapper", "description": "Audits",
      "parameters": {}, "definitionHash": "…", "configHash": "…" },
    { "name": "demo#guide", "kind": "skill", "description": "Guide" }
  ],
  "selection": ["demo#guide", "demo#run"],
  "effective": [
    { "name": "demo#guide", "stale": false },
    { "name": "demo#run", "definitionHash": "…", "stale": false }
  ]
}
```

- `entries` 是**当前绑定的完整清点**（与是否被选中无关），投影类型 `EntrySnapshot` 只有
  `name`、`kind`、`description?`、`parameters?`、`definitionHash?`、`configHash?`；不含条目路径、
  配置正文、`execute` 或包目录。
- 当前实现返回的 `kind` 是 `"tool" | "wrapper" | "skill" | "context"`（`EntryInfo.type` 的投影，
  不是设计早期草稿里的 `EntryInfo[]` 原文）；`parameters` 仅工具/包装器带。
- `selection` 是**已持久化分支**的选择，不叠加队列里尚未确认的声明。
- `effective` 是这份分支选择在当前清点下的资格判定：
  - 工具/包装器：`definitionHash`（包装器另有 `configHash`）+ `stale`；
  - 技能/上下文来源：只有 `name` 与 `stale`，没有定义哈希。
- 内容条目（技能、上下文来源）一旦写入过会话节点，即使扩展之后被删除或改类型，历史正文仍然可
  复用；工具/包装器的历史定义与当前清点不一致时标记 `stale`。
- 响应按 `{id, result}` 的 JSON UTF-8 字节数与 4 MiB 预算比较。超限返回
  `protocol.frame_too_large`（固定文案），**不关闭连接**，同一连接后续请求仍可正常处理。
- 会话工作区已消失时，该会话的快照以 `session.invalid_workspace` 失败。

## 5. 已实现路由

| 方法 | 扩展相关行为 |
|---|---|
| `protocol.hello` | 连接层处理；未握手前其它方法返回 `protocol.hello_required` |
| `session.create` | 配置模式：冻结绑定 → 解析 provider/model → 把 `systemPrompt` 与**一条**未确认声明入队；显式 `extensions: []` 不生成声明 |
| `entries.snapshot` | 见 §4 |
| `queue.enqueue` | 配置模式下接受 `kind=control`/`role=declaration`；整批富化后一次入队；失败不改队列 |
| `queue.edit` | 只允许未确认的 `kind=agent`；已确认 → `queue.entry_locked`；声明 → `queue.invalid_control` |
| `queue.remove` | 可删除任意尚未装配条目，包括已确认声明 |
| `queue.clear` | 清空尚未装配条目；有活跃 turn 时整体 `turn.active` |
| `turn.start` | 先 `validateQueue`（按目标分支），再写标记、确认、注册 turn；新 turn 为 `new`，已有活跃 turn 时只确认并返回 `steer` |
| `session.read` | 返回 `meta/records/queue/selection/seq`；`selection` 只含已持久化声明 |
| `provider.list`、`turn.list`、`turn.cancel`、`session.subscribe`、`session.unsubscribe` | 沿用既有契约，未因扩展改变 |

未路由（仍返回 `protocol.unknown_method`）：`session.list`、`template.*`、`client.*`。

## 6. 执行时机与失败隔离

- 清点、`session.create`、`entries.snapshot`、`queue.*` 与 `turn.start` 都不导入实现模块。
- 工具/包装器模块在**首次实际调用**时由宿主内置加载器导入并缓存；上下文来源在首次被选中装配
  时导入并 `resolve`；技能正文在发现阶段读取，首次选中装配时写入会话节点。
- 加载器使用宿主自己的实例解析 `@pisces/*`，扩展依赖从其自身目录的 `node_modules` 解析，
  因此 `.ts`/`.tsx` 可直接分发，无需预构建；扩展与宿主之间没有单独的 ABI 协商或版本握手。
- 工具失败以错误结果回填（`tool.failed`/`tool.denied`/`tool.wrapper_invalid`），不终止 turn；
  上下文来源失败让本次装配失败（线上为安全 turn 失败），不写半截批次。
- 一个包、条目或模块的失败只影响自身，不阻断 daemon 启动或其它健康条目。

## 7. stale 与重启

- 每个会话在创建（或重启后首次加载）时冻结自己的绑定；进程存活期间不重新扫描。
- `SessionMeta`/`schemaVersion` 不含选择或清点；已审查定义只存在于持久化的 declaration 节点中。
- 扩展代码、sidecar 或 `entryConfig` 改变后：

| 情况 | 行为 |
|---|---|
| 旧会话、定义哈希与当前清点不一致 | `effective[].stale = true`；工具不进 `LlmRequest.tools`，包装器不执行 |
| 旧会话、仅包装器 `configHash` 变化 | 同上，`stale = true` |
| 旧会话、内容条目（技能/上下文） | 复用历史节点正文，不重新清点、不重新导入 |
| 新会话 | 使用新清点 |
| 旧会话重新选择（关闭再打开同一名称） | 写入当前冻结定义，`stale` 恢复为 `false` |

- 重新选择必须显式发送声明；daemon 不会在重启时偷偷覆盖已审查定义，也不会自动重放工具调用。
- 旧定义哈希原本可能来自更早版本，无法匹配时只显示 stale。

## 8. 常见错误码

| 代码 | 触发 |
|---|---|
| `config.invalid` | 配置非法、包装器用户覆盖不合法、扩展服务内部失败的安全投影 |
| `config.unknown_key` | 配置出现未知键 |
| `queue.invalid_control` | 声明格式/未知条目/类型冲突；编辑声明条目；legacy 手动模式提交控制条目 |
| `queue.duplicate_name` | 同一声明内名称重复 |
| `queue.entry_locked` | 编辑已确认条目 |
| `queue.entry_not_found` | 条目已装配或已删除 |
| `queue.entry_too_large` / `queue.too_large` | 单条目 > 256 KiB / 队列 > 1 MiB |
| `protocol.frame_too_large` | 响应信封 > 4 MiB；连接保持可用 |
| `session.invalid_workspace` | 工作区不可用（含已消失的旧会话工作区） |
| `session.model_required` / `session.invalid_model` | provider/model 未成对解析或未注册 |
| `turn.active` | 会话已有活跃/未清理 turn |
| `turn.empty` | 装配后没有可见消息（例如只有零片段来源与声明） |
| `tool.wrapper_invalid` | 包装器改动声明字段、加载失败或模块 `config` 与 sidecar 不一致 |

问题码（不是协议错误，只出现在 `ExtensionBinding.issues`，当前没有协议方法导出它们）：
`extensions.invalid`、`extensions.duplicate`、`extensions.unsupported_contribution`。

## 9. 可复制示例

`<workspace>/.pisces/extensions/demo/package.json`：

```json
{ "name": "demo" }
```

`tools/run.ts`：

```ts
import type { ToolFunction } from "@pisces/core";

const run: ToolFunction = async (args) => {
  const query = (args as { query?: string }).query ?? "";
  return { content: [{ type: "text", text: `searched: ${query}` }] };
};

export default run;
```

`tools/run.ts.meta.json`：

```json
{
  "description": "Searches the workspace",
  "parameters": { "type": "object", "properties": { "query": { "type": "string" } } }
}
```

`wrappers/audit.ts`：

```ts
import type { ToolWrapper } from "@pisces/core";

// 模块级 config 描述 sidecar defaults（不是合并后的用户配置）。
export const config = { tag: "default" };

export default function createWrapper(config: { tag?: string }): ToolWrapper {
  return (tool) => ({
    ...tool,
    execute: async (args, context) => {
      const result = tool.execute === undefined ? undefined : await tool.execute(args, context);
      return {
        content: [
          ...(result?.content ?? []),
          { type: "text" as const, text: `audited:${config.tag}` },
        ],
        ...(result?.isError === undefined ? {} : { isError: result.isError }),
        ...(result?.code === undefined ? {} : { code: result.code }),
      };
    },
  });
}
```

`wrappers/audit.ts.meta.json`：

```json
{
  "description": "Appends an audit marker",
  "config": {
    "defaults": { "tag": "default" },
    "schema": { "type": "object", "properties": { "tag": { "type": "string" } } }
  }
}
```

`skills/guide.meta.json` 与 `skills/guide/SKILL.md`（正文任意 Markdown）；

`context/notes.ts`（默认导出是 `resolve` 函数本身，不是带 `id` 的对象）：

```ts
import type { ContextSource, ContextSourceContext } from "@pisces/core";

export default async function resolve({ workspace }: ContextSourceContext) {
  return [{ source: "notes", content: [{ type: "text", text: `workspace: ${workspace}` }] }];
}
```

（`ContextSource` 的 `id` 与 `resolve` 由 daemon 按清点填充，扩展只提供 `resolve`。）

`<workspace>/.pisces/config.json`：

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5",
  "extensions": ["demo#run", "demo#audit"],
  "entryConfig": { "demo#audit": { "tag": "workspace" } }
}
```

用 `startDaemon` 启动（互斥：不要同时传 `defaults`/`createTools`/`entries`/`skills`/`sources`）：

```ts
import { startDaemon, createProviderHost } from "@pisces/daemon";

const host = await startDaemon({
  dataDir: "/home/me/.pisces",
  providers,
  providerHost,
  extensions: { configDir: "/home/me/.config/pisces" },
});

await host.stop();
```

客户端（NDJSON，先握手；这里省略传输细节）：

```
{"id":"1","method":"protocol.hello","params":{"versions":["0.0.1"]}}
{"id":"2","method":"session.create","params":{"workspace":"/abs/ws","systemPrompt":["hello"]}}
{"id":"3","method":"entries.snapshot","params":{"sessionId":"<id>"}}
{"id":"4","method":"queue.enqueue","params":{"sessionId":"<id>","entries":[
  {"kind":"control","role":"declaration","source":"user",
   "content":[{"type":"text","text":"{\"toggle\":[\"demo#run\"]}"}]}]}}
{"id":"5","method":"turn.start","params":{"sessionId":"<id>"}}
{"id":"6","method":"session.read","params":{"sessionId":"<id>"}}
```

## 10. 本阶段未交付

- **providers 扩展装配**：清单中的 `providers` 只产生 `extensions.unsupported_contribution`，
  不注册供应商；provider 仍由宿主通过 `ProviderManagement` 注入。
- **clients 扩展与 `client.*` 路由**：未装配，未路由。
- **CLI**：没有 `extensions list/install/enable`、`run`、`config` 等命令；安装与更新由 npm/git
  完成，配置由用户直接编辑 JSON。
- **沙箱**：扩展代码与工具以 daemon 用户权限运行，没有进程/文件系统隔离。
- **热重载**：进程存活期间不重新发现、不重建绑定、不重载模块；改变扩展后需新会话或重启 daemon。
- **依赖树锁定**：只哈希条目文件本身（`definitionHash`）与合并后的包装器配置
  （`configHash`），不哈希被导入的依赖；修改扩展的依赖不会让旧定义变 stale。
- **技能/上下文历史清理**：已写入的历史正文只按选择过滤，不会被删除或重新固化为新版本。
- **`session.list`** 未路由；旧会话只能由已知 `sessionId` 读取。

## 11. 验证状态

本契约由 `packages/daemon/test/extensions-socket.test.ts` 在真实 Unix socket 上按 NDJSON 驱动
真实 `startDaemon({ extensions })`、真实发现与真实加载器验收，覆盖声明投影、首调用装载、
队列编辑/移除/锁定、取消选择过滤与历史复用、零片段重试、包装器配置合并与安全失败、清点冲突隔离、
断线不取消 turn、取消不回滚已提交节点、超限快照后连接可用、协议转录不含配置/路径/原因/源码，
以及真实跨 UID 拒绝与停机/重启 stale 可见性。

- 本机结果：该文件 11 个用例全部通过（见
  `.superpowers/sdd/2026-11-09-extensions-selection-b-integration/task-11-green.log`）。
- 平台：Linux x86_64，Node v26.13.0，pnpm 12.8.1。
- 跨 UID 回归使用 `unshare --map-auto` + `packages/daemon/test/fixtures/cross-uid-client.mjs`；
  缺少 subordinate-ID 映射时该用例**失败**而不是跳过。
- **远端 CI 未运行**，不得据此宣称远端 Node 22/24/26 矩阵通过。

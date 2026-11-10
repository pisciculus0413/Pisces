# 模板系统：设计

**状态：待用户批准。批准后才写实施计划。**

## 1. 意图与原因

HLD §5.5 与 DDS §5.8.1 已定义模板：声明式的目录、文件与可选初始化脚本，用户先预览再确认，由服务层 `WorkspaceAccess` 建目录/写文件、`ExecHost` 执行脚本，再创建会话。当前 `template.list/preview/apply` 全部未路由，`session.create` 的 `templateId` 一律拒绝，`TemplateStore` 不存在。本阶段实现完整闭环，并给 CLI 加上 `templates list/preview/apply`，否则用户没有可用的触发入口。

## 2. 目标 / 非目标 / 反目标

**目标**

- `TemplateStore`：从配置目录读取模板、严格校验、缓存、`list`/`preview`/`apply`；脚本超时由模板字段控制。
- 模板格式：`<configDir>/templates/<id>.json`，含元数据、目录、文件内容、可选 `initScript`、会话初始配置。
- `template.preview` 无副作用：返回将创建的目录、文件路径、冲突列表与脚本。
- `template.apply` 必须 `confirmed: true`；写文件 → 可选执行脚本 → 记录 `ProjectRef` → 创建临时会话；返回 `{projectId, sessionId}`。
- Gateway 路由 `template.*`，`session.create` 接受 `templateId` 并解析模板级默认配置。
- CLI `templates list|preview|apply`，通过真实 socket 调用协议；`apply` 需要显式 `--confirm`。
- 项目记录 `<dataDir>/projects.json` 原子写。

**非目标**

- 不做模板编辑 UI、远程模板仓库、模板版本/升级、导入导出。
- 不做回滚（契约明确：已创建文件由用户处置）。
- 不做脚本沙箱；脚本以 daemon 用户身份运行。
- 不做 `client.*`、`providers check`、`config` 等仍缺的命令。
- 不做 CLI 的扩展配置装配：本阶段 CLI 启动的 daemon 仍是无扩展模式，因此模板的 `config.extensions` 只能通过直接 `startDaemon({extensions})` 的宿主生效；CLI 路径会在 apply 预检时按既有语义拒绝。
- 不做模板继承/组合、条件步骤、变量插值。

**反目标（能跑也算失败）**

- 预览阶段写盘或执行脚本。
- 未 `confirmed: true` 就写盘。
- 模板把文件写到工作区外（`..`、绝对路径、符号链接逃逸）。
- `initScript` 失败后仍创建会话或写 `ProjectRef`。
- 冲突文件被静默覆盖。
- 模板配置绕过既有 provider/model/扩展校验。

## 3. 约束

- `Template`/`ProjectRef`/`TemplatePreview` 类型放 core（无文件系统 I/O）；`TemplateStore`、`projects.json`、脚本执行只在 daemon；CLI 只经协议或本地配置。
- 继续 `dev-pi`；不建 worktree、不 push/merge；每任务跑门禁 G。
- 模板只引用已注册 provider/model 与合法扩展条目，不内嵌凭据。
- 复用 `WorkspaceAccess` 与 `ExecHost`；不新增执行能力，不加 Node 全局补丁。
- 错误码沿用 DDS §3.9：`template.not_found`、`template.invalid`、`template.init_failed`、`template.workspace_conflict`；存储失败 `storage.io`，损坏的 `projects.json` 用 `storage.corrupt`。

## 4. 方案（选定 A）

- **A. 声明式 JSON + `TemplateStore` + 协议 + CLI（选定）**：符合 HLD/DDS 的预览/确认/执行分离；可测试、可审计。
- **B. 模板做成扩展包，用工具写文件**：复用扩展链路，但没有无副作用的预览、冲突检测与 `confirmed` 语义，且把初始化变成模型调用，偏离契约。
- **C. 模板就是 shell 脚本**：失去声明式文件清单与冲突预览，违反 HLD §5.5。

## 5. 设计

### 5.1 模板格式与校验

`<configDir>/templates/<id>.json`：

```json
{
  "id": "notes",
  "name": "Notes project",
  "description": "Markdown notes with a scaffold script",
  "directories": ["docs", "docs/archive"],
  "files": [
    { "path": "README.md", "content": "# Notes\n" },
    { "path": "docs/.gitkeep", "content": "" }
  ],
  "initScript": { "command": "/usr/bin/git", "args": ["init"], "timeoutMs": 60000 },
  "config": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "extensions": [],
    "systemPromptFile": "README.md"
  }
}
```

- 文件名去 `.json` 必须等于 `id`；重复 id、缺 id/name 拒绝。
- 严格键集合；`directories`/`files`/`initScript`/`config` 可选。
- 路径规则：相对、非空、无 NUL、按 `/` 分段、禁止 `..`、禁止绝对路径、禁止尾随 `/`；目录与文件路径去重；文件路径不得与其父目录冲突。
- `initScript.command` 必须是绝对路径；`args` 全为字符串，不含 NUL；`timeoutMs` 可选，整数，范围 `1..600_000`，缺省 `60_000`，越界按无效处理（不静默截断，模板作者必须写清楚）。
- `config` 严格键：`provider`、`model`、`extensions`（字符串数组，格式校验沿用 `package#name`）、`systemPromptFile`（必须是模板声明的文件之一）。
- 读取失败、JSON 错误、校验失败：该模板在 `list` 中不出现，并在 `list` 结果外通过 `TemplateStore` 的诊断列表记录（安全码 `template.invalid`，不含文件内容）；`preview/apply` 按 id 查不到时 `template.not_found`，校验失败 `template.invalid`。
- 模板文件大小上限：单模板 JSON ≤ 1 MiB（读取前 `stat`）；超限按无效处理。
- `initScript.timeoutMs` 是该模板脚本的单次执行上限；超时按失败处理（`template.init_failed`）。daemon 不设全局模板超时。

### 5.2 Core 类型（`packages/core/src/templates/types.ts`）

```ts
interface TemplateInfo { id: string; name: string; description?: string }
interface TemplatePreview {
  directories: string[];
  files: { path: string; content: string }[];
  conflicts: string[];
  initScript?: { command: string; args: string[]; timeoutMs: number };
}
interface ProjectRef { id: string; templateId: string; workspace: string; createdAt: string }
```

`Template` 完整形状（含 `config`）留在 daemon 的模板加载模块，不导出敏感内容。

### 5.3 `TemplateStore`（`packages/daemon/src/templates/store.ts`）

```ts
interface TemplateStoreOptions {
  configDir: string;          // <configDir>/templates
  dataDir: string;            // projects.json
  workspaceAccess: (workspace: string) => WorkspaceAccess;
  exec: Exec;
  now?: () => string;
  newProjectId?: () => string;
}
interface TemplateResolution {
  projectId: string;
  preview: TemplatePreview;
  defaults: {
    provider?: string;
    model?: string;
    extensions?: string[];
    systemPrompt?: string;   // systemPromptFile 的内容（已读取）
  };
}
interface TemplateStore {
  list(): Promise<TemplateInfo[]>;
  preview(templateId: string, workspace: string): Promise<TemplatePreview>;
  // 只做校验、写盘、脚本、ProjectRef；不创建会话，不接触 Gateway 的运行时表。
  apply(templateId: string, workspace: string, options: { confirmed: true; overwrite?: boolean }): Promise<TemplateResolution>;
}
```

`TemplateStore` 不持有会话创建能力；`sessionId` 由 Gateway 在 store 返回后创建。`projectId` 在写盘前生成，`ProjectRef` 与写盘/脚本在同一编排中落库；Gateway 创建会话失败时 `ProjectRef` 保留（可审计），但命令向调用方返回错误。

- 工作区必须已存在（由 Gateway 的 `validateWorkspace` 校验，本阶段不自动创建根目录）；不存在时 `session.invalid_workspace`，且在任何写盘之前。

- `list` 每次调用重新扫描目录（模板少，避免陈旧缓存）；按 id 排序；损坏模板不出现。
- `preview`：解析模板 → 用 `workspaceAccess(workspace).resolve` 校验每个路径仍在工作区内 → 对每个文件 `exists` 得 `conflicts`；不写盘、不执行。
- `apply`：
  1. `confirmed === true`（类型层保证，运行时仍校验）；
  2. 重新解析并预览；`conflicts.length && !overwrite` → `template.workspace_conflict`；
  3. **先校验会话配置**：解析 provider/model（模板 `config` 优先于 `GatewayDeps.defaults`），缺失 → `session.model_required`，不存在 → `session.invalid_model`；extensions 非空在无扩展模式拒绝（沿用既有语义），有扩展模式则整体校验名称存在；这些失败都发生在任何写盘之前；
  4. 创建目录（`ensureDirectory`）与文件（`writeFile`，后写覆盖前写，`overwrite` 仅影响已存在文件）；
  5. `initScript` 存在则 `exec.run(command, args, { cwd: resolvedWorkspacePath, timeoutMs: initScript.timeoutMs })`；非零退出、超时或抛错 → `template.init_failed`（文件保留）；
  6. 读 `systemPromptFile`（经 `WorkspaceAccess.readFile`）；
  7. 原子追加 `ProjectRef` 到 `projects.json`（tmp+rename，0600）；
  8. 返回 `TemplateResolution`；会话创建由 Gateway 完成（见 5.4），失败时不回滚文件与 `ProjectRef`。
- `projects.json` 读取失败/损坏：`storage.corrupt`，不写；写入失败：`storage.io`，已创建文件保留。

### 5.4 Gateway 接线

- `GatewayDeps` 增加 `templates?: TemplateStore`（或由 `startDaemon` 提供的窄接口）。
- `template.list`：无 store → `protocol.unknown_method`（保持当前行为）；有 → `{ templates: TemplateInfo[] }`（与其它 list 方法一致）。
- `template.preview`：校验 params（`templateId` 非空字符串，`workspace` 字符串），委托 store。
- `template.apply`：校验 `confirmed === true`，否则 `protocol.invalid_request`；`overwrite` 可选布尔；返回 `{projectId, sessionId}`。
- `session.create` 的 `templateId`：有 store 时解析模板 `config` 作为未显式提供字段的默认值（`provider`/`model`/`extensions`/`systemPromptFile` 读文件入队）；**仍不建目录、不写文件、不执行脚本**。显式 `systemPrompt` 存在时抑制模板提示词（显式优先）；`systemPromptFile` 缺失或不可读 → `template.invalid`。无 store 时保持 `protocol.invalid_request`。`templateId` 未知 → `template.not_found`。
- `apply` 的会话创建复用与 `session.create` 相同的内部路径（抽 `createSessionFrom` 辅助函数），模板解析结果作为默认值。所有校验（workdir、provider/model、extensions、template 配置）在 store 写盘之前完成；写盘/脚本成功后 Gateway 才创建临时会话，首次 `turn.start` 才落盘。
- 模板 `systemPromptFile` 内容进入队列（`role: "system"`，source 标记为模板），不直接写请求体。

### 5.5 宿主装配

`StartDaemonOptions` 增加 `templates?: { configDir: string }`：lock 获取后、监听前构造 `TemplateStore`（用真实 `WorkspaceAccess` 工厂与 `createExecHost()`），传入 Gateway；与 `extensions` 模式可共存。`templates` 与手动注入的 `entries/skills/sources` 不冲突。

### 5.6 CLI

- 配置增加可选 `templatesDir`（绝对路径）；`start` 把它传给子进程（第四个 argv 或环境变量，选 argv），子进程转成 `templates: {configDir}`。
- 新增最小协议客户端：连接 `<dataDir>/run/pisces.sock`，`hello` 后按 id 发请求、读到响应即关闭；普通请求 5 s 超时；`template.apply` 单独使用 660 s 预算（脚本上限 600 s + 60 s I/O），错误映射为固定消息。
- `pisces templates list [--json]`
- `pisces templates preview <id> --workspace <dir> [--json]`：人类输出列出目录、文件、冲突与脚本 argv。
- `pisces templates apply <id> --workspace <dir> --confirm [--overwrite] [--json]`：无 `--confirm` 退出 2；成功打印 `project <id> session <id>`。
- daemon 未运行 → 固定 `daemon.unreachable`，退出 1。

### 5.7 错误与安全

- 不打印模板文件内容到错误；`preview` 本来就要展示文件清单，但 CLI `apply` 失败不复述内容。
- 脚本参数与超时在预览中完整展示；执行不经 shell（`spawn` 直接 argv）。
- 写文件全部经 `WorkspaceAccess`，越界在 preview 阶段就已拒绝。
- 模板配置中的 `systemPromptFile` 只能引用模板自身声明的文件或工作区已有文件？**决定：必须是模板 `files` 中声明的路径**，避免读取工作区无关内容。
- 模板 JSON 不包含凭据字段；出现未知键直接无效。
- `initScript` 的超时完全由模板字段 `timeoutMs` 决定（缺省 60 s，上限 600 s，即 `ExecHost` 的既有上限）；超时后由 `ExecHost` 杀掉直接子进程，模板按 `template.init_failed` 处理。
- `template.apply` 的 CLI 请求预算是 660 s（覆盖最长脚本 + I/O）；客户端超时只说明“未在预算内收到响应”，daemon 可能仍在执行，用户重试前应先用 `status`/检查工作区确认。`template.apply` 是已准入请求，期间调用 `stop` 可能因 5 s 关闭预算而返回 `daemon.stop_incomplete`；长脚本会放大该窗口，这是本阶段的已知限制，文档写明，不新增取消 seam。

### 5.8 验证

- 单元：模板校验（坏 JSON、未知键、绝对/`..`/重复路径、坏脚本、`timeoutMs` 非整数/越界/缺省、config 引用未声明提示词文件）、preview 冲突与无副作用（含展示 `timeoutMs`）、apply 写盘顺序、冲突/overwrite、脚本失败/超时都不建会话、`projects.json` 原子追加与损坏处理。
- 协议：`template.*` 未装配时 `unknown_method`；装配后 list/preview/apply；`confirmed` 缺失；未知模板；会话配置校验先于写盘。
- 真实 socket：startDaemon 注入 templates 目录 → `template.preview` 不写盘 → `apply` 写文件/跑脚本（用测试临时脚本的绝对路径）→ 返回 sessionId → `session.read` 可见 → `projects.json` 有一条记录；另测工作区不存在、provider/model 不可解析、扩展不可用都发生在写盘之前（文件不存在、无 `ProjectRef`）。
- CLI：三命令对真实 daemon 的输出/退出码；无 `--confirm` 退出 2；daemon 未启动 → `daemon.unreachable`。
- 门禁 G；远端 CI 未运行需注明。

## 6. 留给实施者

- `StartDaemonOptions.templates` 的确切字段与 CLI 子进程传递方式（第四个 argv 或专用环境变量），保持与 `dataDir` 覆盖一致的显式传递。
- `ProjectRef` 的 `id` 生成方式（`randomUUID` 或注入工厂）。
- `createSessionFrom` 在 `gateway.ts` 内的具体签名（必须覆盖模板默认值与显式覆盖的合并顺序）。
- CLI `templates` 子命令的精确文案（固定、无内容回显即可）。
- 模板 JSON ≤ 1 MiB 与文件内容大小限制是否需要独立常量。

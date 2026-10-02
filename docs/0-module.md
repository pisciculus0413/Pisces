# 模块划分

## 分层

```
客户端进程（cli / tui / web / 自定义）
        │  protocol（传输无关的请求·响应·事件契约）
        ▼
daemon（长驻服务，持有 core，对外只暴露 protocol）
        │
        ▼
core（纯引擎逻辑，不含传输与客户端交互）
```

依赖方向：`客户端进程 → protocol ← daemon → core`。

## `protocol` — 契约层

- 请求、响应与事件的消息 schema。
- 协议版本协商。
- 消息编解码与分帧，传输无关，可挂载 stdio、unix socket、HTTP、SSE 等。

## `core` — 引擎层

| 模块 | 职责 |
|---|---|
| `types` | 类型原语：brand 机制、`JsonValue`/`JsonObject`、错误基类 |
| `llm` | 与供应商无关的消息、内容、工具调用、请求、响应、流式事件类型；适配器接口与注册表 |
| `providers` | 协议方言驱动；供应商描述符 schema 与注册表；模型能力元数据（上下文窗口、模态、定价）的数据模型与查询 |
| `credentials` | 凭据访问接口：供应商密钥、OAuth token 的读取与刷新 |
| `agent-loop` | turn/step 驱动器，编排各模块并判定闭环 |
| `context` | 上下文组装：系统提示词注入、消息队列、工具与技能声明装配（取自注册表的选择结果）、裁剪压缩；上下文来源接口与内置来源（工作区指令、提示词模板、文件引用、会话引用）；消息队列操作（入队、编辑、删除）与系统提示词设置 |
| `session` | 追加型树形日志与读投影，存储经统一接口访问；记录每轮装配的上下文：消息、系统提示词、声明集合 |
| `tools` | 工具标准、注册表与调用流水线：接口定义、schema 到 JSON Schema 派生、注册、解析、参数校验、`beforeToolCall` hook、执行、`afterToolCall` hook、结果回填结算；导出 hook 契约类型；注册表查询与启用/禁用选择 |
| `exec` | 命令与子进程执行接口 |
| `skills` | 技能标准与注册表；注册表查询与启用/禁用选择 |
| `template` | 模板模型、解析与项目初始化逻辑 |
| `events` | 引擎内部事件流，供 daemon 转为 protocol 事件 |

## `daemon` — 服务层

| 模块 | 职责 |
|---|---|
| `boot` | 进程生命周期：启动、配置加载、优雅关闭 |
| `transport` | 传输监听与连接：stdio、unix socket、HTTP、SSE |
| `gateway` | 暴露 protocol；多会话注册与路由、并发或串行调度、订阅广播；注册表快照与选择操作、消息队列与系统提示词操作的协议暴露，供客户端渲染面板 |
| `session-store` | 会话持久化后端 |
| `template-store` | 模板存储 |
| `credential-store` | 凭据的存储与刷新 |
| `workspace` | 工作区访问 |
| `exec-host` | 子进程与命令执行环境 |
| `loader` | 工具、hook、技能、上下文来源、客户端、供应商的发现、加载与注入（标注来源与信任级别）；供应商模型目录同步 |

对外只暴露 `protocol`。

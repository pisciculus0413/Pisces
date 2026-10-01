# 模块划分

## 分层

```
clients (cli / tui / web …)
        │  protocol（传输无关的请求·响应·事件契约）
        ▼
daemon（长驻服务，持有 core，对外只暴露 protocol）
        │
        ▼
core（纯引擎逻辑，不含传输与客户端交互）
```

依赖方向：`clients → protocol ← daemon → core`。

## `protocol` — 契约层

- 请求、响应与事件的消息 schema。
- 协议版本协商。
- 消息编解码与分帧，传输无关，可挂载 stdio、unix socket、HTTP、SSE 等。

## `core` — 引擎层

| 模块 | 职责 |
|---|---|
| `types` | Message、ContentPart、ToolCall、Event 等内部数据模型与错误类型 |
| `llm` + `provider-*` | 适配器接口与注册表；具体供应商实现；请求构建、响应解析、流式处理、工具调用格式转换 |
| `model-registry` / `credentials` | 模型能力元数据与凭据访问 |
| `agent-loop` | turn/step 驱动器，编排各模块并判定闭环 |
| `context` | 上下文组装：系统提示词注入、消息队列、工具与技能声明装配、裁剪压缩 |
| `session` | 追加型树形日志与读投影，存储经统一接口访问 |
| `tools` | 工具注册与调用流水线：注册、解析、参数校验、`beforeToolCall` hook、执行、`afterToolCall` hook、结果回填结算；导出 hook 契约类型 |
| `tool-*` | 内置工具实现 |
| `exec` | 命令与子进程执行接口 |
| `skill` / `resource-loader` | 技能与项目资源加载、来源核对 |
| `template` | 模板模型、解析与项目初始化逻辑 |
| `events` | 引擎内部事件流，供 daemon 转为 protocol 事件 |

## `daemon` — 服务层

- 进程生命周期：启动、配置加载、传输监听、优雅关闭。
- 会话管理：多会话注册与路由、并发或串行调度、订阅广播。
- 持久化后端的具体实现。
- 模板存储。
- 工作区访问与子进程执行环境。
- hook 模块的发现、加载与注入。
- 对外只暴露 `protocol`。

## `clients` — 客户端层

- `cli`：命令行客户端，print 与交互模式。
- `tui`、`web`：界面客户端。
- 各客户端仅消费 `protocol`，独立编译分发。

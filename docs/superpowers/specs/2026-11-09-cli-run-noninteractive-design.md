# CLI `run`（非交互）设计

**状态：已获用户同意（范围 A、`--json` 对象、会话选择默认）。**

## 意图

交付非交互 `pisces run [prompt]`：选/建会话、应用会话选项、将提示词入队、`turn.start`、等待 `turn.ended`、流式显示文本或输出最终对象；Ctrl-C 等同 `sessions cancel`。交互式 stdin 循环留到下一阶段。

## 目标

```text
pisces run [prompt] [--new | --continue | --session <id> [--create]]
           [--model <id>] [--provider <id>]
           [--system-prompt <text> | --use-default-system-prompt]
           [--enable <package#name>]... [--disable <package#name>]...
           [--print | --json]
           [--config <path>] [--data-dir <dir>]
```

- 提示词位置参数必填且非空；先 `queue.enqueue`，再 `turn.start`；不直接写入请求体。
- 无选择器等同 `--new`；`--continue` 取 `session.list` 中 `createdAt` 最大的会话，空则 `session.not_found`（1）。
- `--session <id>` 不存在且带 `--create` 时新建（服务端生成新 id）；不带则 `session.not_found`（1）。
- `--new`、`--continue`、`--session` 互斥；`--create` 只能配 `--session`；`--print`/`--json` 互斥。
- `--model`/`--provider`：新会话交给 `session.create`；既有会话交给 `session.configure`（协议要求成对时由协议报错）。
- `--system-prompt`：新会话走 `session.create.systemPrompt`；既有会话走 `session.configure.systemPrompt`。
- `--use-default-system-prompt`：仅新会话有效；既有会话返回本地 `run.default_system_prompt_unsupported`（1），不做静默 no-op。
- `--enable`/`--disable`：先 `entries.snapshot` 取当前 `selection`，计算与目标的差集；只对实际变化的条目发一条 `{kind:"control",role:"declaration",source:"run"}`，`content` 为 `[{"toggle":[names]}]`；无变化不发。提示词与该控制条目同一 `queue.enqueue` 批次。
- 新会话在 `session.create` 后先建立临时会话（`session.create` 不落盘），再入队。

## 输出与事件

- 客户端需新增事件接收：无 `id`、形状 `{event:string,data:object}` 的帧派发给监听器；响应帧行为不变；其他帧仍 `client.protocol`。
- run 在入队/启动前 `session.subscribe`，收集 `turn.delta`（`kind:"text"`）与 `turn.ended`（匹配 `turnId`）。
- 默认：文本 delta 直接写 stdout；结束时补换行。
- `--print`：不写 delta，结束后只写最终文本 + 换行。
- `--json`：结束时写一行 JSON 对象：
  `{sessionId, turnId, reason:"completed"|"cancelled"|"failed", text, error?:{code,message}}`。
- `turn.ended.reason="failed"` → stderr `error: <code>: <message>`，退出 1；`completed` → 0。
- Ctrl-C：发 `turn.cancel`，等待 `turn.ended`，退出 130。实现通过可注入的 `onInterrupt` seam，默认 `process.once("SIGINT")`，结束时移除。
- 协议/会话错误按 `error: <code>: <message>` 退出 1；用法错误 2；配置错误 2；连接失败 1。

## 非目标

- 交互式 stdin 循环、多轮输入。
- `client.*`、`providers check`、`auth`。
- 新增协议方法或 daemon 行为；不改会话存储。

## 验证

- client：事件帧派发、取消订阅、多监听器、关闭后不再派发、无 `id` 非事件帧仍 `client.protocol`。
- run 单测（fake client）：三种会话选择；create/configure 参数；系统提示与 `--use-default` 边界；enable/disable 差集与无变化；prompt 与控制条目同批；订阅在入队前；delta/print/json 输出；failed 退出 1；Ctrl-C 请求 `turn.cancel` 并退出 130；config/连接/协议错误；参数互斥与缺失。
- 真实 socket：真实 daemon + 可控 provider 完成一次 turn，验证 `--print` 与 `--json` 对象、事件订阅、失败 turn；Ctrl-C 用注入 seam 触发真实取消。
- 文档：`docs/cli.md`、HLD §6.8/§8.1、DDS §7.2；门禁 G。

# CLI `sessions export` / `sessions cancel`：设计

**状态：已获用户同意（短设计）。**

## 意图

补齐 DDS §7.1 中仍为目标的 `sessions export` 与 `sessions cancel`。两者只经协议：`session.read`（分页）与 `turn.list`/`turn.cancel`；CLI 不直接读会话文件。

## 目标

- `pisces sessions export <session-id> [--node <node-id>] [--config <path>] [--data-dir <dir>]`
  - 无 `--node`：导出整棵会话树，按 `session.read` 的追加顺序。
  - 有 `--node`：导出根到该节点的线性分支。
  - 每行一个 `SessionNode` 的 JSON，**不额外包装**；保留协议返回的字段（含可选 `synthetic`），不做字段裁剪。
  - 自动按 `limit`/`nextCursor` 分页直至结束；写入 stdout；空结果输出为空、退出 0。
  - 未知节点 → 协议 `session.node_not_found` 退出 1；未知会话 → `session.not_found`。
- `pisces sessions cancel <session-id> [--config <path>] [--data-dir <dir>]`
  - 先 `turn.list`，按 `sessionId` 找活跃 turn。
  - 无活跃 turn：stdout `no active turn`，退出 0（幂等）。
  - 有活跃 turn：`turn.cancel {turnId}`；成功 → `cancelled <turnId>`，退出 0；返回 `{cancelled:false}`（竞态或 cleanup）→ `error: turn.cancel_failed: Cancel request was not accepted`，退出 1。
  - 若同一会话意外出现多个活跃 turn，逐个取消；任一失败则退出 1。

## 非目标

- 不导出队列、选择状态或 `meta`；只导出 `SessionNode`。
- 不提供 `--output` 文件写入（由 shell 重定向）；不加 `--json` 包装。
- 不做 `run`、`client.*`、`providers check`、`auth`。

## 错误与退出码

- 配置不可读 `config.invalid` → 2；连接失败 `daemon.unreachable` → 1；协议错误按码 → 1；用法错误 → 2。
- 固定文案，不回显配置值或原始异常；所有路径关闭连接。

## 验证

- 单测：fake client 的分页循环（`nextCursor` 两页、末页停止）、`--node` 透传、空记录、`session.node_not_found` 透传、JSONL 每行可解析且与原对象相等、分页参数正确（首屏无 cursor，后续带 cursor/nodeId）。
- cancel 单测：无活跃 turn（`no active turn`, 0）、匹配一项（请求正确、输出、0）、`cancelled:false`（`turn.cancel_failed`, 1）、`turn.list` 协议错误（1）、配置/连接失败、只选择匹配 `sessionId` 的 turn。
- 真实 socket：临时 daemon 创建并提交会话（产生节点）→ export 全树与分支各校验行数/内容 JSONL；cancel 一个真实活跃 turn（可用挂起 provider）→ 输出与 turn 结束；停止 daemon → 两命令 `daemon.unreachable` 退出 1。
- 构建后 CLI 子进程至少各跑一次。
- 门禁 G。

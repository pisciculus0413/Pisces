# `status` 显示活跃会话：设计

**状态：已获用户同意（形状 A + 边界）。**

## 意图

`pisces status` 在原有 daemon 状态之外，显示 `turn.list` 返回的活跃 `sessionId`，让用户无需另跑 `turn.list`。

## 行为

- 仅当状态为 `running` 或 `unmanaged`（本 dataDir 的 socket 有应答）时，新增一次短连接查询 `turn.list`。
- 人类输出在状态行后追加一行：
  - `sessions: <id1>, <id2>`（按 `turn.list` 顺序去重）
  - 无活跃 turn：`sessions: none`
  - 查询失败（连接/协议/结构不合法）：`sessions: unavailable`
- `--json` 在原对象上增加 `sessions`：
  - 查询成功（含空）：`"sessions": []` 或 id 数组
  - 查询失败：省略 `sessions`
  - 不到达 socket 的状态（`stopped`/`stale`/`unresponsive`）：不查询、省略 `sessions`
- 退出码与现有状态语义不变；查询失败不改变退出码，也不写 stderr。
- 不改 `turn.list` 协议或 daemon。

## 实现

- `CommandDeps` 增加 `listSessions(socketPath: string): Promise<string[]>`；生产实现用 `connectClient` + `turn.list`，校验 `{turns:[{sessionId:string,...}]}`，按出现顺序去重；任何失败抛出，由 status 转为 `unavailable`/省略。
- `statusCommand` 在确定 `running`/`unmanaged` 后调用；`finally` 语义由生产实现关闭连接。
- 其他命令不受影响。

## 验证

- 单测：running 两个 turn 同会话去重；空列表；unmanaged 查询；stopped/stale/unresponsive 不调用；查询失败人类 `unavailable`、JSON 省略、退出码不变；`--json` 不泄漏 turnId/其他字段（只输出 sessionId）。
- 真实 socket：真实 daemon 创建活跃 turn 后 status 显示该 sessionId；停止后不出现。
- 文档：`docs/cli.md` status 段、HLD/DDS 状态描述；门禁 G。

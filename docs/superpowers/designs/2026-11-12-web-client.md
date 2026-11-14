# Web 客户端设计（Express + Vue）

状态：已与作者确认的设计基线。实现计划见 `docs/superpowers/plans/2026-11-12-web-client.md`，用户手册见 `docs/web-client.md`。

## 1. 目标与非目标

**目标**：为 Pisces daemon 提供一个浏览器操作台，覆盖"看会话、发消息、管队列、选条目、控制 turn"这条主交互链，并把透明可控的设计意图（审查系统提示词、工具/技能声明、会话树、压缩记录）在界面上显示出来。

**非目标**：登录与多用户、远程部署、客户端侧缓存与锁、事件重放、`compression`/`cancel` 的人工编辑、多模态渲染、全文搜索、`client.*` 管理面板。

并发不需要客户端设计：HLD §2.1 已声明客户端不持有会话相关锁，同一会话的队列与 turn 由服务层 `Concurrency` 串行化；同时开多个 Web 客户端就是多个协议连接，行为与多个 CLI 进程一致。

## 2. 拓扑

```
browser ──HTTP/SSE──▶ web-client 进程 ──NDJSON over Unix socket──▶ daemon
```

- 浏览器碰不到 Unix socket，因此 `web-client` 是一个本机 bridge：对浏览器说 HTTP 与 SSE，对 daemon 说现有协议。
- bridge 只做转译：一个端点对一个协议方法，不缓存会话状态、不做锁、不做重放、不合成数据。
- 归属：`extensions/builtin/web-client`，作为内置扩展随产品分发，清单声明
  `pisces.clients: [{ "id": "web", "entry": "./dist/main.js" }]`，由 `pisces client start web` 拉起。
  这样不需要新命令、不需要改协议。

## 3. 进程与配置

- 监听 `127.0.0.1:${PISCES_CLIENT_WEB_PORT:-7801}`；端口被占用即退出并打印固定文案。
- 启动后向 stdout 打印 `web client listening on http://127.0.0.1:<port>/`（继承到 `daemon.log`）。
- 上游连接：`PISCES_SOCKET_PATH` 指向 daemon socket；一条共享连接按请求 id 多路复用。
- daemon 启动客户端时只传入 `PATH`、`PISCES_SOCKET_PATH`、`PISCES_CLIENT_ID`。为让客户端可以带自己的
  配置，`ClientRegistry` 额外透传 daemon 环境中以 `PISCES_CLIENT_` 开头的键（前缀属于客户端命名空间，
  不会与供应商密钥的环境变量名冲突；密钥仍不进入客户端环境）。
- 构建：`pnpm -C extensions/builtin/web-client build` 产出 `dist/`（服务端，`tsc`）与 `dist/web/`
  （SPA，Vite）。服务端在运行时以 `node <entry>` 启动，因此必须是构建后的 JS；`@pisces/protocol`
  从工作区链接到已构建的 `packages/protocol/dist`。

## 4. HTTP 接口

一个端点对一个协议方法；参数与结果直接透传协议形态，不重命名、不裁剪。

| 方法与路径 | 协议方法 | 说明 |
|---|---|---|
| `GET /api/sessions` | `session.list` | 已落盘会话 |
| `GET /api/sessions/:id?node=&limit=&cursor=` | `session.read` | 首次加载与重连对齐 |
| `POST /api/sessions` | `session.create` | 新建临时会话 |
| `PATCH /api/sessions/:id` | `session.configure` | provider/model 与系统提示词，活跃 turn 时 `turn.active` |
| `GET /api/providers` | `provider.list` | provider/model 与 `contextWindow` |
| `GET /api/turns` | `turn.list` | 活跃 turn 快照 |
| `POST /api/sessions/:id/turns` | `turn.start` | `{nodeId?}`；有活跃 turn 时为 steer |
| `POST /api/turns/:id/cancel` | `turn.cancel` | |
| `POST /api/sessions/:id/queue` | `queue.enqueue` | 正文或 `role=declaration` 条目 |
| `PATCH /api/sessions/:id/queue/:entryId` | `queue.edit` | 只对未确认 `kind=agent` 条目 |
| `DELETE /api/sessions/:id/queue/:entryId` | `queue.remove` | |
| `DELETE /api/sessions/:id/queue` | `queue.clear` | 活跃 turn 时 daemon 返回 `turn.active` |
| `GET /api/sessions/:id/entries` | `entries.snapshot` | 条目清点与已持久化选择 |
| `GET /api/sessions/:id/events` | `session.subscribe` + 事件流 | SSE |

- 错误：协议 `Response.error` 原样映射为 `{ error: { code, message } }`，HTTP 状态按码分类：
  `*.not_found`/`node_not_found` → 404；`turn.active`/`queue.entry_locked`/`queue.entry_not_found`/
  `queue.invalid_control`/`*.duplicate_name`/`*.too_large` → 409；`protocol.invalid_request` →
  400；`daemon.unreachable`、`daemon.timeout`、上游断开 → 503；`protocol.invalid_response` → 502；
  其余 → 500。状态码只是给浏览器的粗分类，码本身是契约。
- `PATCH`/`POST` 必须带 `application/json`；`GET` 全部只读。

## 5. 安全边界

无 token、无登录，理由是浏览器能做的只有"发请求"，而 bridge 只暴露本机用户本来就能做的操作；保护集中在
三点：

1. **Host 头校验**：`Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403。这条挡住
   DNS rebinding（攻击者域名解析到 127.0.0.1）。
2. **不发 CORS 头**：跨站页面读不到任何响应；写操作要求 `application/json`，跨站无法在不触发
   预检的情况下发出。
3. **仅回环监听**：不监听 `0.0.0.0`；socket 本身仍由 daemon 的 `SO_PEERCRED` 同 uid 校验保护。

威胁模型之外写明：同一台机器上其他 uid 无法连 socket，但可以访问回环端口；本设计不防御本机其他用户
直接读写你的浏览器会话（那是 OS 层的事），也不做速率限制。

## 6. 前端信息架构

浅色主题，三栏 + 底部输入区。

### 6.1 左栏：会话列表

- 顶部"新建会话"按钮。
- 按 `createdAt` 分组：今天 / 昨天 / 7 天内 / 更早；组内按时间倒序。
- 每行：`provider/model`（`session.list` 只返回元数据，没有消息正文）+ 右侧状态点（该会话在
  `turn.list` 中即有活跃 turn）。
- 点击切换当前会话，切换时清空临时/流式状态并重新 `session.read`。

### 6.2 中栏：会话记录与 Active Turn（同栏分块）

- **会话记录块**：所有节点按追加顺序单列排列，左侧一条树形轨道：
  - **活动分支**（默认是最后一个节点所在的祖先链；选了分支点时是到该点的祖先链）占最左轨道并保持竖直，
    贯穿整列；每个节点与父节点之间是一条连续竖线，圆点落在自己那一行的首行高度上。
  - 其余分支挂在右侧：在分叉那一行用一段从父轨道弯过来的连线开轨，之后沿自己的轨道继续，到该分支最后一个
    节点处收束（不再向下延伸）。同一行里仍在延续的轨道都画竖线。
  - `agent` 消息按正文块渲染；`declaration`/`compaction`/`cancel` 控制消息渲染为轨道上的窄条 chip，
    点击展开摘要。未选中的技能/来源节点保留在记录里但标灰，提示"已取消选择"。
  - assistant 消息底部常显操作行：复制、以此为分支起点。
- **Active Turn 块**：一条 `— Working —` 分隔线下面的同列内容：
  - `turn.delta` 的文本/推理增量原位长在末尾的临时 assistant 节点上，不另开预览区。
  - 工具调用与结果按节点插入到同一列。
  - `session.updated` 带来落盘节点时替换对应临时节点（按 `turnId` + 顺序对齐），`turn.ended` 后分隔线
    消失，该块并入记录。
  - 分隔线右侧显示 step 数、已用时间、Cancel 按钮。

### 6.3 底部：消息输入与队列

- **常驻 composer**（视觉中心，始终可见）：多行输入，`Enter` 发送、`Shift+Enter` 换行，右下发送按钮。
  无活跃 turn 时标签为"发送并开始 turn"，有活跃 turn 时为"追加（steer）"；发送后输入框清空，消息立即
  出现在队列栈里。
- **队列栈**：折叠在 composer 上方，默认只显示一行摘要
  `↳ 3 条排队消息 · Alt+↑ 展开`。展开后每条一行，可改文本（未确认的 `kind=agent`）、删除、清空。
  已确认条目只显示删除按钮并标注"已确认"。队列为空时不占高度。
- 发送失败（如 `queue.entry_too_large`、`queue.invalid_control`）在队列栈位置显示错误条，不丢失输入。

### 6.4 右栏（可折叠）：条目、模型与控制

- 条目面板：`entries.snapshot` 的 `entries` 按类型分组，勾选状态来自已持久化 `selection`，叠加队列中的
  待生效 delta 显示"待确认"标记；toggle 通过 `queue.enqueue` 提交 `role=declaration` 条目。`stale`
  条目禁用并提示需要重新选择。
- 模型区：当前 provider/model 与 `contextWindow`（来自 `provider.list`）。
- 控制区：Cancel 当前 turn；`session.configure` 的模型切换（provider/model 成对）。

### 6.5 状态与事件

- 单 store：`sessions`、`current`（meta / records / queue / selection / seq / entries / activeTurn / live）。
- 每个会话维护 `seq` 水位：`session.read` 首屏建立水位，之后丢弃 `seq` 不大于已应用值的旧事件（与
  DDS §3.4.3 一致）；重连后重新 `session.read` 对齐，不做补偿。
- `live` 只服务展示：`turn.step`/`turn.ended` 后按 `session.updated` 的最终节点替换；取消或失败时清除剩余
  临时内容。
- SSE 断开后指数退避重连（1s → 8s 上限），重连成功即重新 `session.read`。

## 7. 明确不做

- 登录、token、多用户会话、远程绑定。
- 客户端侧状态缓存、乐观更新与锁；所有写操作以 daemon 返回为准，失败即回滚本地假设。
- 事件重放与断点续传。
- `compaction`/`cancel` 的人工写入（daemon 专属），只读展示。
- 前端组件级 DOM 测试（见 §8）。

## 8. 测试策略

- 服务端：`wire`（协议握手与多路复用）、`security`（Host 校验、JSON 约束）、`api`（方法映射与错误码到
  状态码）、`sse`（转发、按会话 refcount 订阅、断开退订）——全部用假上游与 `listen(0)` + `fetch`，
  不引入 supertest。
- 前端纯逻辑：`computeRail`（轨道分配与分叉）与 store reducer（delta 累积、`seq` 去重、最终节点替换）
  用 vitest 在 node 环境测试。
- 端到端：真实 daemon + `client start web` + `fetch` 打 `/api/sessions`，`skipIf` 未构建（与既有
  `BUILT` 模式一致）。
- 不写 `.vue` 的 DOM 测试：为它引入 jsdom 与 `@vue/test-utils` 的收益低于维护成本；组件行为靠类型检查
  与端到端覆盖。

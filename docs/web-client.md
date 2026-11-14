# Web 客户端

`pisces client start web` 启动一个本地操作台：Express 服务端把浏览器的 HTTP/SSE 转成 daemon 协议，Vue 前端负责渲染。它是内置扩展 `extensions/builtin/web-client`，随产品分发，不占用新的 CLI 命令。

设计依据见 `docs/superpowers/designs/2026-11-12-web-client.md`；`client` 命令本身见 `docs/cli.md`。

## 1. 启动

```console
$ pnpm build            # 构建 packages/*（web 客户端运行时依赖已构建的 @pisces/protocol）
$ pnpm build:web        # 构建 extensions/builtin/web-client：dist/ 服务端 + dist/web/ 前端
$ pisces start
$ pisces client list
web  @pisces/web-client
$ pisces client start web
started web (pid 41231)
$ curl -s http://127.0.0.1:7801/api/sessions
{"sessions":[]}
```

- 地址固定为 `http://127.0.0.1:<port>/`，默认端口 `7801`。端口被占用时进程以
  `web client: port <n> is already in use` 退出，`client start` 之外的输出都进 `daemon.log`。
- 端口用环境变量 `PISCES_CLIENT_WEB_PORT` 改变（`0` 表示随机端口）：

  ```console
  $ PISCES_CLIENT_WEB_PORT=0 pisces start
  $ tail -n 5 ~/.local/state/pisces/daemon.log
  web client listening on http://127.0.0.1:41257/
  ```

  该变量必须在 `pisces start` 的环境里设置：daemon 只在启动时读取一次环境，客户端进程继承它。
- 服务端启动即连上 daemon 的 socket。daemon 重启后这条连接失效，需要重新
  `pisces stop && pisces start`（或再 `client start web`）。
- `pisces stop` 不会终止已启动的 Web 客户端；它自己退出前会一直尝试连接那个 socket。

## 2. 界面

三栏 + 底部输入区，浅色主题。

- **左栏**：会话列表，按创建时间分组（今天 / 昨天 / 7 天内 / 更早）；每行标题是 `provider/model`
  （`session.list` 只返回元数据，不含消息正文），绿点表示该会话有活跃 turn。顶部"新建会话"要求工作区
  绝对路径，留空则使用配置中的 `defaultWorkspace`。
- **中栏**：会话记录与 Active Turn 在同一列分块。
  - 记录按追加顺序排列，左侧是树形轨道：分叉节点在新轨道上出现，用彩色点 + 从父轨道弯过来的连线标记。
  - `declaration` / `compaction` / `cancel` 控制消息显示为窄条 chip，点击展开摘要。
  - 分叉的起点用节点操作行的"以此为分支起点"选择，下一次发送就从该节点起开新 turn。
  - 有活跃 turn 时出现 `— Working —` 分隔线（右侧是 step 数与已用时间、Cancel），下面的正文是流式内容，
    落盘后自动并回记录；该块与已落盘记录视觉上分开，不会重复显示。
- **底部**：composer 常驻。`Enter` 发送，`Shift+Enter` 换行；无活跃 turn 时是"发送并开始 turn"，
  有活跃 turn 时是"追加（steer）"。队列折叠在 composer 上方，默认一行摘要
  `↳ N 条排队消息 · Alt+↑ 展开`；展开后可改文本（未确认条目）、删除、清空。
- **右栏**：条目面板（勾选即提交一条 `role=declaration` 队列条目，待确认的显示"待确认"，`stale` 的禁用）
  与模型面板（`provider`/`model` 成对切换，活跃 turn 中会被 daemon 以 `turn.active` 拒绝）。

## 3. 接口

一个端点对一个协议方法，参数与结果原样透传；错误码原样返回，HTTP 状态只做粗分类。

| 端点 | 协议方法 |
|---|---|
| `GET /api/sessions` | `session.list` |
| `GET /api/sessions/:id` | `session.read`（`node`、`limit`、`cursor` 透传） |
| `POST /api/sessions` | `session.create` |
| `PATCH /api/sessions/:id` | `session.configure` |
| `GET /api/sessions/:id/entries` | `entries.snapshot` |
| `GET /api/providers` | `provider.list` |
| `GET /api/turns` | `turn.list` |
| `POST /api/sessions/:id/turns` | `turn.start`（`{nodeId?}`；有活跃 turn 时即 steer） |
| `POST /api/turns/:id/cancel` | `turn.cancel` |
| `POST /api/sessions/:id/queue` | `queue.enqueue` |
| `PATCH /api/sessions/:id/queue/:entryId` | `queue.edit` |
| `DELETE /api/sessions/:id/queue/:entryId` | `queue.remove` |
| `DELETE /api/sessions/:id/queue` | `queue.clear` |
| `GET /api/sessions/:id/events` | `session.subscribe` + 事件流（SSE） |

- 错误体为 `{ "error": { "code", "message" } }`。状态码：`*.not_found` → 404；`turn.active`、
  `queue.entry_locked`、`queue.entry_not_found`、`queue.invalid_control`、`queue.duplicate_name`、
  `*_too_large` → 409；`protocol.invalid_request` → 400；daemon 不可达或超时 → 503；
  `protocol.invalid_response` → 502；其余 500。
- SSE 每帧为 `data: {"event":…,"data":{…}}`，首帧 `retry: 2000`，每 15 s 一条 `: keepalive` 注释。
  浏览器按会话 `seq` 丢弃旧事件；断线后自动退避重连（1 s 起、最长 8 s），重连成功即重新 `session.read`。
- bridge 不缓存状态、不做锁：并发由 daemon 的 `Concurrency` 按会话串行化，同时开多个浏览器窗口与开多个
  CLI 进程等价。

## 4. 安全边界

- 只监听 `127.0.0.1`，不监听网络地址。
- `Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403
  `web.host_forbidden`（挡住 DNS rebinding）。
- 不发任何 `access-control-*` 头；写请求必须带 `application/json`，否则 415
  `web.unsupported_media_type`。跨站页面因此既发不出写请求，也读不到响应。
- 没有 token、没有登录。威胁模型只覆盖"用户浏览器里另一个页面"；本机其他 uid 访问回环端口不在防御范围内，
  也没有速率限制。

## 5. 已知限制

- 只支持 Linux x64（与 daemon 一致）。
- 前端不打包进 daemon：`pnpm build:web` 是独立步骤。未构建时入口 `dist/main.js` 不存在，该声明会被
  发现阶段丢弃，因此 `client list` 不显示 `web`，`client start web` 返回 `client.not_found`。
- 没有登录与多用户、没有消息搜索、没有客户端侧缓存与事件重放。
- daemon 重启后 bridge 的连接失效，需要重启客户端进程（见 §1）。
- 前端组件没有 DOM 级测试：组件由 `vue-tsc` 把关，逻辑（store、轨道计算）与 bridge 由 vitest 覆盖。

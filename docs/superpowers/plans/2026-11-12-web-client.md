# Web 客户端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `extensions/builtin/web-client`：一个由 `pisces client start web` 拉起、监听 `127.0.0.1` 的 Express + Vue 操作台。

**Architecture:** Express 服务端是纯转译层（一端点对一协议方法 + 一个 SSE 端点），通过 `@pisces/protocol` 的 NDJSON 编解码与 daemon 的 Unix socket 通信；Vue 3 单页应用只经 `/api/*` 与 SSE 交互，状态集中在一个 store 里，事件按 `seq` 水位去重。

**Tech Stack:** TypeScript + ESM、Express 5、Vue 3 + Vite + `vue-tsc`、`@pisces/protocol`（工作区包）、vitest。

**Spec:** `docs/superpowers/designs/2026-11-12-web-client.md`；协议契约见 `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §3、§5.8.2。

## Global Constraints

- Node `>=22.19.0`，ESM，pnpm 工作区；除 `express`、`vue`、`vite`、`@vitejs/plugin-vue`、`vue-tsc` 与 `@pisces/protocol` 外不新增依赖。
- 只监听 `127.0.0.1`；无 token、无登录、无 CORS 头；`Host` 头必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。
- 协议错误码是契约，原样进入响应体 `{ error: { code, message } }`；HTTP 状态只做粗分类（404/409/400/503/500）。
- bridge 不缓存会话状态、不做锁、不做事件重放；每次浏览器刷新都靠 `session.read` 对齐。
- 浅色主题；不得引入 UI 组件库。
- 不写 `.vue` 的 DOM 测试；`.vue` 靠 `vue-tsc` 把关，逻辑抽到 `.ts` 再测。
- 门禁：`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm lint`，以及 `pnpm -C extensions/builtin/web-client typecheck`。
- 提交信息 `{feat,fix,docs}[(core,daemon,protocol)]: <message>`；不提交到 `main`。

## Review Focus

1. `Host: evil.com`（DNS rebinding）→ 403，且不进入任何协议调用。（Task 4）
2. daemon 未运行或中途断开 → REST 返回 503 固定文案，不挂起、不 500。（Task 3、Task 6）
3. 浏览器关闭 SSE 后订阅被释放，daemon 不再为该会话推送。（Task 5）
4. 重复或回退的 `seq` 不覆盖已应用状态，`turn.ended` 后临时节点被清除不残留。（Task 7）
5. 端口被占用或 `PISCES_SOCKET_PATH` 缺失 → 进程以固定文案退出，不留下半开的监听端口。（Task 1、Task 10）

---

### Task 1: 包骨架、静态服务与 `startServer`

**Files:**
- Modify: `pnpm-workspace.yaml`（`packages:` 增加 `- extensions/builtin/*`）
- Modify: `vitest.config.ts`（include 增加 `extensions/builtin/*/test/**/*.test.ts`）
- Create: `extensions/builtin/web-client/package.json`
- Create: `extensions/builtin/web-client/tsconfig.json`（服务端：`src/server/**` → `dist/`）
- Create: `extensions/builtin/web-client/tsconfig.web.json`（`vue-tsc`，`web/src/**` + `web/src/**/*.vue`）
- Create: `extensions/builtin/web-client/src/server/app.ts`
- Create: `extensions/builtin/web-client/src/server/main.ts`
- Test: `extensions/builtin/web-client/test/app.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/server/app.ts
  export interface AppOptions {
    assetsDir: string;                 // 已构建 SPA 的绝对目录（含 index.html）
    now?: () => number;                // 测试 seam（SSE 保活）
  }
  export function createApp(options: AppOptions): import("express").Express;

  // src/server/main.ts
  export interface ServerHandle { port: number; close(): Promise<void>; }
  export interface StartOptions { port?: number; socketPath?: string; assetsDir?: string }
  export async function startServer(options?: StartOptions): Promise<ServerHandle>;
  export const DEFAULT_PORT = 7801;
  ```
- `package.json`：`name: "@pisces/web-client"`、`private: true`、`type: "module"`、
  `pisces.clients: [{ id: "web", entry: "./dist/main.js" }]`、
  scripts：`build`（`tsc -p tsconfig.json && vite build --config web/vite.config.ts`）、
  `typecheck`（`tsc -p tsconfig.json --noEmit && vue-tsc -p tsconfig.web.json --noEmit`）。
  `dependencies`：`express`、`@pisces/protocol: workspace:*`；`devDependencies`：`vue`、`vite`、
  `@vitejs/plugin-vue`、`vue-tsc`、`typescript`（用 `pnpm add` 取当前稳定版）。
- `tsconfig.json` 里加 `paths: { "@pisces/protocol": ["../../packages/protocol/src/index.ts"] }`，
  让类型检查不依赖 `packages/protocol/dist`；运行时仍解析到构建后的包。
- `startServer` 从 `process.env.PISCES_CLIENT_WEB_PORT` 读端口（`StartOptions.port` 优先），
  `assetsDir` 缺省为 `new URL("../web/", import.meta.url)` 指向的目录，`socketPath` 缺省取
  `process.env.PISCES_SOCKET_PATH`；成功后在 stdout 打印
  `web client listening on http://127.0.0.1:<port>/`；`EADDRINUSE` 或缺少 socketPath 时打印固定文案并
  `process.exitCode = 1`（由 `main.ts` 的入口判断完成，`startServer` 本身 reject）。

- [ ] **Step 1: 写失败测试** `test/app.test.ts`

```ts
test("serves the built index.html and falls back to it for unknown pages", ...)   // GET / 与 GET /sessions 都回 200 + text/html
test("answers 404 JSON for unknown /api paths", ...)                              // { error: { code: "protocol.unknown_method" } }
test("startServer listens on the loopback interface only", ...)                    // handle.port > 0；fetch 成功；close() 后 fetch 拒绝
```

测试自己写一个临时 `assetsDir`（`index.html` + `assets/app.js`），用 `listen(0)` 取端口，不依赖真实构建产物。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/app.test.ts`
Expected: FAIL，`Cannot find module '../src/server/app.js'`。

- [ ] **Step 3: 实现骨架**

`createApp` 用 `express.static(assetsDir, { index: "index.html" })` 托管，`/api` 前缀下未匹配的路由返回
`404 { error: { code: "protocol.unknown_method", message: "Unknown API route" } }`，其余 GET 回落到
`index.html`。`main.ts` 末尾用 `isEntryPath` 模式（`realpath` 比较 `process.argv[1]`）只在作为入口时执行，
测试导入无副作用。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run extensions/builtin/web-client/test/app.test.ts`
Expected: PASS（3 passed）。

Run: `pnpm -C extensions/builtin/web-client typecheck`
Expected: 服务端 tsc 通过（此时 `tsconfig.web.json` 还没有文件，允许 noEmit 空集合）。

- [ ] **Step 5: 提交**

```bash
git add pnpm-workspace.yaml vitest.config.ts extensions/builtin/web-client/package.json extensions/builtin/web-client/tsconfig.json extensions/builtin/web-client/tsconfig.web.json extensions/builtin/web-client/src/server/app.ts extensions/builtin/web-client/src/server/main.ts extensions/builtin/web-client/test/app.test.ts
git commit -m "feat(web-client): scaffold the loopback bridge package"
```

---

### Task 2: daemon 透传 `PISCES_CLIENT_*`

**Files:**
- Modify: `packages/daemon/src/client-registry/registry.ts`（`childEnv`）
- Test: `packages/daemon/test/client-registry.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `childEnv(options, id)`。
- Produces: 子进程 env 在原有三键之外，额外包含 daemon 环境中所有以 `PISCES_CLIENT_` 开头的键（`PISCES_CLIENT_ID` 仍由 daemon 覆盖）。

- [ ] **Step 1: 写失败测试**

在 `packages/daemon/test/client-registry.test.ts` 的既有 fake spawn 断言后追加：

```ts
test("forwards PISCES_CLIENT_ overrides without leaking anything else", async () => {
  // env: { PATH, PISCES_CLIENT_WEB_PORT: "7900", PISCES_CLIENT_ID: "spoofed", PISCES_API_KEY: "sk-secret" }
  // 断言 env 深等于 { PATH, PISCES_CLIENT_WEB_PORT: "7900", PISCES_SOCKET_PATH, PISCES_CLIENT_ID: "repl" }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/daemon/test/client-registry.test.ts`
Expected: FAIL，收到 env 里没有 `PISCES_CLIENT_WEB_PORT`。

- [ ] **Step 3: 实现**

`childEnv` 先展开 `Object.entries(env).filter(([key]) => key.startsWith("PISCES_CLIENT_"))`，再显式写入
`PISCES_SOCKET_PATH` 与 `PISCES_CLIENT_ID`（后者覆盖任何同名继承值）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/daemon/test/client-registry.test.ts packages/daemon/test/clients-socket.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/daemon/src/client-registry/registry.ts packages/daemon/test/client-registry.test.ts
git commit -m "feat(daemon): forward PISCES_CLIENT_ overrides to spawned clients"
```

---

### Task 3: `wire` —— 上游协议客户端

**Files:**
- Create: `extensions/builtin/web-client/src/server/wire.ts`
- Test: `extensions/builtin/web-client/test/wire.test.ts`

**Interfaces:**
- Consumes: `@pisces/protocol` 的 `createNdjsonDecoder`、`encodeFrame`、`PROTOCOL_VERSION`、`MAX_FRAME_BYTES`。
- Produces:
  ```ts
  export interface WireEvent { event: string; data: unknown }
  export interface WireClient {
    request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
    onEvent(listener: (event: WireEvent) => void): () => void;   // 返回取消订阅函数
    close(): void;
  }
  export class WireError extends Error { readonly code: string; }  // code ∈ {"daemon.unreachable","daemon.timeout","protocol.invalid_response"}
  export async function connectWire(socketPath: string, timeoutMs?: number): Promise<WireClient>;
  ```
- 握手：连接后立刻发 `protocol.hello { versions: [PROTOCOL_VERSION] }`；握手失败或版本不兼容 → 以
  `daemon.unreachable` reject 并关闭 socket。请求按 id 路由；socket 关闭时所有在途请求以
  `daemon.unreachable` reject。固定文案：`Daemon is not reachable`、`Daemon did not respond`。

- [ ] **Step 1: 写失败测试** `test/wire.test.ts`

用 `node:net` 起一个假 daemon（同一 Unix socket 路径，`mkdtemp` 目录下）：

```ts
test("completes the hello handshake before serving requests", ...)      // 假 daemon 断言第一帧是 protocol.hello
test("multiplexes concurrent requests by id", ...)                     // 两个请求乱序回复，各自 resolve 自己的结果
test("routes event frames to listeners and stops after unsubscribe", ...)
test("rejects in-flight requests when the socket closes", ...)          // code === "daemon.unreachable"
test("rejects with daemon.unreachable when nothing is listening", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/wire.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

参考 `packages/cli/src/client.ts` 的结构（握手、按 id 的 waiter 表、`{event,data}` 分派），但错误码用上表三值、
不引入 CLI 的 `ClientError`。请求/事件编码上限分别用 `MAX_FRAME_BYTES` 与现有常量。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run extensions/builtin/web-client/test/wire.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add extensions/builtin/web-client/src/server/wire.ts extensions/builtin/web-client/test/wire.test.ts
git commit -m "feat(web-client): add the NDJSON upstream client"
```

---

### Task 4: Host 校验与 JSON 约束

**Files:**
- Create: `extensions/builtin/web-client/src/server/security.ts`
- Modify: `extensions/builtin/web-client/src/server/app.ts`（挂载中间件）
- Test: `extensions/builtin/web-client/test/security.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function hostGuard(allowedHosts: readonly string[]): express.RequestHandler; // 不匹配 → 403 { error: { code: "web.host_forbidden" } }
  export function requireJson(): express.RequestHandler;                            // 非 application/json → 415 { error: { code: "web.unsupported_media_type" } }
  ```
- `createApp` 增加 `allowedHosts: readonly string[]` 选项（默认由 `startServer` 按端口生成
  `["127.0.0.1:<port>", "localhost:<port>"]`），`hostGuard` 挂在最前，`requireJson` 挂在所有 `POST`/`PATCH`/`DELETE` 之前。

- [ ] **Step 1: 写失败测试** `test/security.test.ts`

```ts
test("rejects a foreign Host header", ...)        // Host: evil.example → 403 web.host_forbidden，且 wire.request 未被调用
test("accepts 127.0.0.1 and localhost", ...)      // 两个 Host 都 200
test("rejects a write without a JSON content type", ...) // POST text/plain → 415 web.unsupported_media_type
test("never emits CORS headers", ...)             // 响应头不含 access-control-*
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/security.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现并挂载**

`hostGuard` 比较 `req.headers.host`（缺失也算失败）；不要用 `req.hostname`（它信任 `X-Forwarded-Host`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run extensions/builtin/web-client/test/security.test.ts extensions/builtin/web-client/test/app.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add extensions/builtin/web-client/src/server/security.ts extensions/builtin/web-client/src/server/app.ts extensions/builtin/web-client/test/security.test.ts extensions/builtin/web-client/test/app.test.ts
git commit -m "feat(web-client): guard the bridge against rebinding and form posts"
```

---

### Task 5: SSE 与按会话的订阅引用计数

**Files:**
- Create: `extensions/builtin/web-client/src/server/sse.ts`
- Test: `extensions/builtin/web-client/test/sse.test.ts`

**Interfaces:**
- Consumes: `WireClient.onEvent`、`wire.request("session.subscribe" | "session.unsubscribe")`。
- Produces:
  ```ts
  export interface SubscriptionHub {
    acquire(sessionId: string): Promise<() => void>;   // 每个会话首次 acquire 才发 subscribe；返回 release
  }
  export function createSubscriptionHub(wire: WireClient): SubscriptionHub;
  export function eventStream(hub: SubscriptionHub, wire: WireClient): express.RequestHandler;
  ```
- 首帧写 `retry: 2000`；事件写成 `data: {"id":seq,"event":type,"data":payload}\n\n`；每 15 s 写 `: keepalive`；
  `req.on("close")` 时 `release()` 并 `res.end()`。

- [ ] **Step 1: 写失败测试** `test/sse.test.ts`

```ts
test("subscribes once per session and unsubscribes on last release", ...)   // acquire×2 → 1 次 subscribe；release×2 → 1 次 unsubscribe（幂等 release 不再调用）
test("forwards only the subscribed session's events", ...)                   // 两个会话的事件，流里只出现自己的
test("closes the stream and releases when the browser disconnects", ...)     // abort fetch → unsubscribe 被调用、hub 里不再有该会话
test("keeps the connection alive with a comment frame", ...)                 // 用注入的 now/定时器推进，断言出现 ": keepalive"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/sse.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

hub 内部 `Map<sessionId, { count: number; listeners: Set<fn> }>`；`acquire` 在首次进入时 `await
wire.request("session.subscribe", { sessionId })`，失败即 reject（路由把它映射成 503/404）。`release` 必须幂等。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run extensions/builtin/web-client/test/sse.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add extensions/builtin/web-client/src/server/sse.ts extensions/builtin/web-client/test/sse.test.ts
git commit -m "feat(web-client): stream session events over SSE with refcounted subscriptions"
```

---

### Task 6: REST 路由映射

**Files:**
- Create: `extensions/builtin/web-client/src/server/api.ts`
- Modify: `extensions/builtin/web-client/src/server/app.ts`（挂载 `createApiRouter({ wire, hub })`）
- Test: `extensions/builtin/web-client/test/api.test.ts`

**Interfaces:**
- Consumes: `WireClient`（Task 3）、`SubscriptionHub` 与 `eventStream`（Task 5）。
- Produces:
  ```ts
  export interface ApiOptions { wire: WireClient; hub: import("./sse.js").SubscriptionHub }
  export function createApiRouter(options: ApiOptions): express.Router;
  export function statusForCode(code: string): number;   // 404 / 409 / 400 / 503 / 500（见设计 §4）
  ```
- 全部端点由本任务实现，逐条对应设计 §4 的表格（14 个端点，含 `PATCH /api/sessions/:id` →
  `session.configure`）；`GET /api/sessions/:id/events` 用 Task 5 的 `eventStream(hub, wire)`，
  `createApp` 用 `createSubscriptionHub(wire)` 构造 hub 后传给 router。
- 响应：成功时直接 `res.json(result)`；失败时 `statusForCode(error.code)` + `{ error: { code, message } }`。
  `WireError` 的 `daemon.unreachable` / `daemon.timeout` → 503，`protocol.invalid_response` → 502。

- [ ] **Step 1: 写失败测试** `test/api.test.ts`

用 fake `WireClient`（记录 `method`/`params`，可指定返回值或抛 `WireError`），`listen(0)` + `fetch`：

```ts
test("maps each REST endpoint to exactly one protocol method", ...)  // 表驱动：设计 §4 的 14 个端点各断言一次 method 与 params
test("propagates protocol error codes with a coarse status", ...)     // session.not_found→404、turn.active→409、protocol.invalid_request→400、storage.io→500
test("reports an unreachable daemon as 503", ...)                    // WireError("daemon.unreachable") → 503 + code 原样
test("passes query parameters through unchanged", ...)               // ?node=&limit=&cursor= → session.read 的同名参数
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/api.test.ts`
Expected: FAIL，`createApiRouter` 不存在。

- [ ] **Step 3: 实现**

参数只做"类型与存在性"校验（`sessionId` 非空字符串、`limit` 是正整数、`entries` 是数组），不做协议层语义校验——
那是 daemon 的职责。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run extensions/builtin/web-client/test/api.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add extensions/builtin/web-client/src/server/api.ts extensions/builtin/web-client/src/server/app.ts extensions/builtin/web-client/test/api.test.ts
git commit -m "feat(web-client): map REST endpoints onto protocol methods and mount the event stream"
```

---

### Task 7: 前端 store

**Files:**
- Create: `extensions/builtin/web-client/web/src/store.ts`
- Test: `extensions/builtin/web-client/test/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LiveTurn {
    turnId: string; step: number;
    text: string; reasoning: string;
    nodes: SessionNode[];          // 已解析出、尚未落盘的 assistant/tool 节点
  }
  export interface SessionState {
    meta: SessionMeta | null;
    records: SessionNode[];
    queue: QueueEntry[];
    selection: SelectionState;
    entries: EntrySnapshot[];
    effective: EffectiveEntry[];
    activeTurn: { turnId: string; startedAt: string } | null;
    live: LiveTurn | null;
    seq: number;
  }
  export const emptySession: SessionState;
  export function applyRead(state: SessionState, read: SessionReadResult): SessionState;
  export function applyEvent(state: SessionState, event: { event: string; data: unknown }): SessionState;
  export function isStale(state: SessionState, seq: number): boolean;
  ```
- 规则：`applyEvent` 在 `seq <= state.seq` 时原样返回旧 state（同一对象引用）；`session.updated` 追加节点
  （按 id 去重）、用 `turnId` 命中的 `live` 节点替换并清空 `live.nodes`；`queue.updated` / `selection.updated`
  整体替换；`turn.started` 建立 `live`；`turn.delta` 追加到 `live.text`/`live.reasoning`；`turn.step` 推进
  `step`；`turn.ended` 清空 `live` 与 `activeTurn`。事件缺少本会话必需的 `turnId`/`sessionId` 时原样返回。

- [ ] **Step 1: 写失败测试** `test/store.test.ts`

```ts
test("accumulates deltas per step and kind", ...)
test("ignores events at or below the seq watermark", ...)     // 断言返回同一对象引用
test("replaces a live assistant node with the persisted one", ...)
test("clears the live turn on turn.ended and on cancel", ...)
test("replaces queue and selection wholesale", ...)
test("keeps records immutable in append order", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/store.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

全部函数是纯函数（返回新对象，不就地改）；类型从 `@pisces/protocol` 与手写的协议形态类型导入（协议的类型在
`@pisces/daemon` 的 gateway/protocol.ts，Web 端不引入 daemon 包——把需要的几个接口在本包 `web/src/protocol.ts`
里复制成局部类型，只保留用到的字段）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run extensions/builtin/web-client/test/store.test.ts`
Expected: PASS（6 passed）。

- [ ] **Step 5: 提交**

```bash
git add extensions/builtin/web-client/web/src/store.ts extensions/builtin/web-client/web/src/protocol.ts extensions/builtin/web-client/test/store.test.ts
git commit -m "feat(web-client): add the session store reducers"
```

---

### Task 8: 树形轨道 `computeRail`

**Files:**
- Create: `extensions/builtin/web-client/web/src/rail.ts`
- Test: `extensions/builtin/web-client/test/rail.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RailCell {
    id: string;
    lane: number;        // 轨道序号，0 为最左
    branch: boolean;     // 父节点不是上一个节点（分叉起点）
    lanes: number[];     // 本行需要画竖线的轨道（含自身轨道）
    color: number;       // 颜色序号 = lane % 4
  }
  export function computeRail(nodes: readonly { id: string; parentId: string }[]): RailCell[];
  ```
- 规则：维护 `laneOf: Map<nodeId, lane>` 与 `activeLanes: string[]`（每个轨道当前末端节点 id）。节点若父节点
  在某轨道上，沿用该轨道，`branch = (上一节点的 id !== 父节点 id)`；否则取最小的空闲轨道，`branch = true`。
  `lanes` 是放置完本节点后仍存活的轨道集合，按升序。会话树永不合并（每节点一个父、只追加），因此不实现合并。

- [ ] **Step 1: 写失败测试** `test/rail.test.ts`

```ts
test("keeps a linear chain on lane 0", ...)
test("starts a new lane when a node forks from an earlier node", ...)   // A→B, 再 A→C：C 在 lane 1，branch=true，B 行 lanes=[0,1]
test("reuses lane 0 when a branch continues from its own parent", ...)  // A→C→D 时 D 仍在 lane 1
test("never allocates a lane twice", ...)                                // 三条分叉 → lane 2
test("treats a fork from a non-tip node as a branch but continuation as linear", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/rail.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**（纯函数，不依赖 Vue）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run extensions/builtin/web-client/test/rail.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add extensions/builtin/web-client/web/src/rail.ts extensions/builtin/web-client/test/rail.test.ts
git commit -m "feat(web-client): compute the session tree rail"
```

---

### Task 9: 前端组件与浅色主题

**Files:**
- Create: `extensions/builtin/web-client/web/index.html`
- Create: `extensions/builtin/web-client/web/vite.config.ts`（`root: web`、`build.outDir: ../dist/web`、`server.proxy["/api"] → http://127.0.0.1:7801`）
- Create: `extensions/builtin/web-client/web/src/main.ts`、`App.vue`
- Create: `extensions/builtin/web-client/web/src/api.ts`（fetch 包装 + `EventSource` + 退避重连）
- Create: `extensions/builtin/web-client/web/src/theme.css`（浅色变量：`--bg #ffffff`、`--panel #f7f8fa`、`--line #e5e7eb`、`--text #111827`、`--muted #6b7280`、4 个轨道色）
- Create: `web/src/components/SessionList.vue`、`RecordColumn.vue`、`MessageNode.vue`、`ControlChip.vue`、`RailCell.vue`、`ActiveTurn.vue`、`Composer.vue`、`QueueStack.vue`、`EntriesPanel.vue`、`ModelPanel.vue`

**Interfaces:**
- Consumes: `store.ts`（Task 7）、`rail.ts`（Task 8）、`/api/*`（Task 5、6）。
- Produces: 无对外接口；`App.vue` 持有 store，向下用 props/emit。

组件职责（不要越界）：
- `SessionList`：分组渲染会话、新建按钮、活跃点；emit `select(id)` / `create()`。
- `RecordColumn`：把 `records` 交给 `computeRail`，逐行渲染 `RailCell` + `MessageNode`/`ControlChip`。
- `MessageNode`：user/assistant/tool/system 四种样式；底部操作行"复制"与"以此为分支起点"（emit `branch(nodeId)`）。
- `ControlChip`：`declaration`/`compaction`/`cancel` 的窄条，点击展开摘要（只读）。
- `ActiveTurn`：`— Working —` 分隔线 + step 数 + 已用时间 + Cancel；下面渲染 `live` 文本（正文/推理分块）。
- `Composer`：受控 textarea，`Enter` 发送、`Shift+Enter` 换行，模式标签"发送并开始 turn"/"追加（steer）"。
- `QueueStack`：折叠为一行摘要 `↳ N 条排队消息 · Alt+↑ 展开`；展开后逐条编辑/删除/清空，已确认条目只可删除；
  `Alt+↑` 全局快捷键绑定在 `App.vue`。
- `EntriesPanel`：按类型分组、勾选、`stale` 禁用、待确认标记。
- `ModelPanel`：显示当前 provider/model 与 `contextWindow`（来自 `provider.list`），供应商与模型成对切换，
  经 `PATCH /api/sessions/:id` → `session.configure`；活跃 turn 中 daemon 返回 `turn.active` 时原样展示错误。

- [ ] **Step 1: 先落 `vite.config.ts` 与 `main.ts` 骨架，确认 `vue-tsc` 能跑**

Run: `pnpm -C extensions/builtin/web-client typecheck`
Expected: 通过（此时组件为最小占位实现）。

- [ ] **Step 2: 逐个组件实现，每完成一个跑一次**

Run: `pnpm -C extensions/builtin/web-client typecheck && pnpm vitest run extensions/builtin/web-client/test`
Expected: 类型通过、既有测试仍全绿。

- [ ] **Step 3: 交互自检清单**（在 `pnpm -C extensions/builtin/web-client build` 后手写一份到 PR 描述/提交信息）

左栏分组与活跃点；记录列轨道分叉可见；分叉节点点击后 `POST /api/sessions/:id/turns {nodeId}`；composer 两种模式；
队列折叠/展开/编辑/删除；活跃 turn 的流式文本原位增长且结束后并入记录；`declaration` chip 可展开；条目面板 toggle 后
出现"待确认"标记；右栏折叠。

- [ ] **Step 4: 提交**

```bash
git add extensions/builtin/web-client/web
git commit -m "feat(web-client): add the light-theme Vue console"
```

---

### Task 10: 构建产物、启动自检与端到端

**Files:**
- Modify: `extensions/builtin/web-client/src/server/main.ts`（`isEntryPath` 入口判断、固定失败文案、退出码）
- Test: `extensions/builtin/web-client/test/start-e2e.test.ts`
- Modify: `package.json`（根 scripts 增加 `build:web`：`pnpm -C extensions/builtin/web-client build`）

**Interfaces:**
- Consumes: 全部前置任务；`pisces client start web`（已交付）。
- Produces: 无新接口；失败文案 `web client: missing PISCES_SOCKET_PATH`、`web client: port <n> is already in use`。

- [ ] **Step 1: 写端到端测试** `test/start-e2e.test.ts`

`test.skipIf(!existsSync(dist/main.js))`：用临时 dataDir 起真实 `startDaemon`，`client.list` 含 `web`，
`client.start {id:"web"}`，轮询 `http://127.0.0.1:<port>/api/sessions` 直到 200（端口从
`PISCES_CLIENT_WEB_PORT` 指定，避免与开发实例冲突），断言返回 `{ sessions: [] }`，最后 SIGKILL 该 pid 并 `host.stop()`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run extensions/builtin/web-client/test/start-e2e.test.ts`
Expected: SKIP（未构建）或 FAIL（`dist` 存在但入口未接线）。

- [ ] **Step 3: 实现入口与启动自检**

`build` 先跑 `tsc` 再跑 `vite build`；`main.ts` 作为入口时做的事：读 env → `startServer` → 打印 URL；捕获失败并按固定文案写 stderr、`exitCode = 1`。`PISCES_SOCKET_PATH` 缺失时不监听端口。

- [ ] **Step 4: 构建后跑测试**

Run: `pnpm build && pnpm -C extensions/builtin/web-client build && pnpm vitest run extensions/builtin/web-client/test/start-e2e.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑全量门禁**

Run: `pnpm test && pnpm typecheck && pnpm -C extensions/builtin/web-client typecheck && pnpm lint`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add package.json extensions/builtin/web-client/src/server/main.ts extensions/builtin/web-client/test/start-e2e.test.ts
git commit -m "feat(web-client): wire the built entry point and add an end-to-end check"
```

---

### Task 11: 文档

**Files:**
- Create: `docs/web-client.md`（用法：启动、端口、地址、安全边界、只读与写操作的边界、已知限制）
- Modify: `docs/cli.md`（`client list|start` 小节加一句指向 `docs/web-client.md`；本阶段未交付清单不变）
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §5.8.2（`PISCES_CLIENT_` 透传规则）
- Modify: `docs/1 High-Level Design/1 High-Level Design.md` §6.7（同上，一句）
- Modify: `docs/implementation-gaps.md`（若 `client` 相关缺口已清空则只更新基线一行）

- [ ] **Step 1: 写文档**（每条都要与代码一致；不确定的写法先去代码里确认）

- [ ] **Step 2: 交叉检查**

Run: `rg -n "web-client|PISCES_CLIENT_WEB_PORT|7801" docs`
Expected: 文档与代码中的端口默认值、环境变量名、失败文案一致，没有未实现的承诺。

- [ ] **Step 3: 提交**

```bash
git add docs/web-client.md docs/cli.md "docs/2 Detailed Design Specification/2 Detailed Design Specification.md" "docs/1 High-Level Design/1 High-Level Design.md" docs/implementation-gaps.md
git commit -m "docs: document the web client"
```

---

## 完成标准

- `pisces client start web` 在构建后可拉起操作台，浏览器能看会话、发消息（新 turn 与 steer）、编辑/删除队列、
  提交声明 toggle、取消 turn。
- 会话记录带树形轨道，Active Turn 在同一栏用 `Working` 分隔并与记录区分；流式文本原位增长，结束后并入记录。
- 队列默认折叠为一行摘要，`Alt+↑` 展开后可编辑。
- 无 token、无 CORS 头、非回环 Host 被拒；daemon 不可达时 REST 返回 503 固定文案。
- 全量门禁绿；未改动核心层与协议层，daemon 侧唯一改动是 `PISCES_CLIENT_` 透传。

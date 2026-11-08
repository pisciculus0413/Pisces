# Gateway and Turn Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the daemon `Gateway` that routes `provider.list`, `session.create/read/configure`, and `turn.start/cancel/list` onto the existing core `Context`, `Sessions`, `ProviderManagement`, `ProviderHost`, and `AgentLoopDriver`, with `active-turn.json` write/cleanup and daemon-restart recovery that synthesizes interrupted tool results.

**Architecture:** `Gateway` keeps one `SessionRuntime` per session (`meta`, shared `Context`, shared `SessionEventClock`, marker-aware `Sessions`, per-session `AgentLoopDriver`), serializes every session-domain method through plan A's `Concurrency`, and starts each turn asynchronously after registering its `AbortController`. Persisted sessions write `active-turn.json` before the driver starts; temporary sessions write it from a `Sessions` decorator after the first `create`, and a write failure throws `storage.io` so the turn fails before any provider request. Recovery scans only nodes at or after the marker's `startOffset`, appends synthetic `interrupted` tool results, then a `cancel` control message.

**Tech Stack:** TypeScript, Node >=22.19.0, ESM, pnpm 12.8.1, node `fs/promises`, Vitest; no new dependencies.

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §3.4, §4.2, §5.2–5.6, §6.1–6.5, §7.2, §8.1–8.4; `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §2.3–2.6, §3.4, §3.6–3.10, §4.2, §4.4, §5.2–5.4, §6.1–6.5; `docs/2 Detailed Design Specification/P0 Decision Table.md` P0-04, P0-05, P0-06, P0-11, P0-13.

**Dependency:** Plan A (`2026-11-08-runtime-foundations.md`) must be implemented first on a `dev-*` branch. Do not merge it. Start plan B from the actual `HEAD` left by plan A and record that commit as the diff base for Task 9. This plan imports `createConcurrency`, `createEventBus`, `createSessionEventClock`, and `ActiveTurn` from `@pisces/daemon` runtime modules.

## Global Constraints

- Work on the existing `dev-pi` branch after plan A is implemented; only `dev-*` branches; never commit to `main`, push, or merge. Read the current `git log --oneline -1` at the start of plan B and record that actual commit as the diff base for Task 9. Do not create or merge a branch for plan B.
- Only `packages/daemon` and the design document in the final task are modified. Do not change `packages/core` or `packages/protocol`; core must not import daemon, protocol, Node `fs`, or Node networking.
- `@pisces/protocol` still exports only `PROTOCOL_VERSION`. This plan does not add `Request`/`Response`/`Event` types, `Transport`, framing, `session.subscribe`/`unsubscribe`, event push, `Extensions`, a concrete `CredentialStore`, `TemplateStore`, `ClientRegistry`, or CLI. The Gateway seam is a transport-neutral `handle(request): Promise<response>`.
- Implemented protocol methods are exactly `provider.list`, `session.create`, `session.read`, `session.configure`, `queue.enqueue`, `turn.start`, `turn.cancel`, `turn.list`. `queue.edit`/`queue.remove`/`queue.clear`, `entries.snapshot`, `session.list`, templates, and clients are not implemented; they stay unrouted.
- Core `Context.assemble` and `AgentLoopDriver.run` acquire the session lock themselves. The Gateway must never hold the session lock while awaiting them, and must start `driver.run` only after the lock-holding `turn.start` block returns.
- Session-domain methods run under `Concurrency.runExclusive(sessionId, …)`; `turn.cancel` never takes the session lock (§5.3.2). `cancelAll` from plan A is the only bulk cancellation path.
- One `AgentLoopDriver` and one `SessionEventClock` exist per session and are shared by the Gateway and that session's `Context`.
- `session.read` selects `selection` only from persisted records via `Context.selectionFor`; `queue`/`selection` are returned on the first page only and later pages must not advance the `seq` waterline.
- `session.configure` rejects the whole request with `turn.active` while a turn is running; never partially updates meta, queue, or records.
- Records keep `ToolCall.name` as `EntryName`; system messages, including repeated `source="instruction"` messages, are preserved in order by the existing core. Do not add instruction filtering in the Gateway.
- `provider.list` projects descriptors without `dialect`/`baseUrl`/`auth`/`headers`; a provider with no models is valid and always reports `ready=false`. Provider readiness never triggers OAuth refresh.
- Provider retry/timeout/safe-error behavior stays inside the existing `ProviderHost`; the Gateway never parses provider payloads or exposes credentials.
- `Gateway.handle` never exposes a raw `cause`, request/response headers, body, or credential material. A `PiscesError` maps to `{code, message}` only. Any non-`PiscesError` maps to `{code:"internal.error", message:"Internal error"}`; it is never rethrown to the caller. Future server-side logging must not copy those values into a protocol response.
- Marker removal failure is never swallowed. A turn stays registered and blocks new turns for the same session from `turn.ended` until its marker is safely deleted. A normal completed turn that cannot delete its marker publishes a safe `turn.cleanup_failed` event, appends a same-`turnId` `cancel` node with `reason:"cleanup_failed"` when no cancel exists, retries removal once, and leaves the marker plus the registered turn in `cleanup_failed` state if the retry fails. Recovery dedupes by `turnId`; see Task 8.
- A session turn lifecycle is `running -> cleanup -> (unregistered | cleanup_failed)`. `turn.list` lists the turn in all three non-unregistered states. `turn.start` steers only while `running`; during `cleanup`/`cleanup_failed` it returns `turn.active` and does not confirm or enqueue. `turn.cancel` returns `{cancelled:false}` during cleanup without invoking the abort handle again. No new turn may overwrite or remove another turn's marker.
- `bootstrapGateway` is the only assembly path that initializes storage, runs recovery, and then constructs the Gateway. It must resolve before any request is served. No daemon start/stop/CLI lifecycle is implemented here.
- With no `Extensions` loader/inventory there is no source of frozen `DefinitionSnapshot`s. `parseDeclaration` only validates shape, and `Context.materialize`/`projectTools` require a definition for every enabled tool/wrapper. Therefore this stage accepts no non-empty effective `extensions` (explicit `session.create.extensions` or `SessionDefaults.extensions`) and no client `declaration` in `queue.enqueue`: both are rejected atomically with `queue.invalid_control` before any session/runtime/queue/marker is created. Do not shape-validate a non-empty extension list and then silently ignore it. Empty/omitted extension lists remain valid and produce no declaration entry. A future inventory/definition dependency must be explicitly constructed, validated, and tested before non-empty extensions or declarations are accepted.
- `templateId` is rejected with `protocol.invalid_request` until `TemplateStore` exists. Do not fake templates.
- Use TDD. Every production behavior starts with a test that is run and observed to fail.
- Before every commit in every task, run the full verification block and require all six results:
  1. `node_modules/.bin/vitest run` — exit 0.
  2. `node_modules/.bin/tsc -p tsconfig.json` — exit 0.
  3. `node_modules/.bin/tsc -b tsconfig.build.json` — exit 0.
  4. `node_modules/.bin/biome check .` — exit 0.
  5. `rg -n 'from "@pisces/(daemon|protocol)"|node:(fs|net|http|https|tls|dgram|dns)' packages/core/src` — exit 1 with no output.
  6. `git status --short` — inspect; stage only the exact files named by the task.
  Never use `git add -A` or `git add .`. Focused red/green commands are allowed while developing, but the commit step must run this block.

## Review Focus

- Two different sessions must run turns at the same time, while a second `turn.start` on the same session becomes `mode:"steer"`, confirms new queue entries, and never starts a second driver or writes a second marker. Task 8 covers this.
- `turn.cancel` must abort a turn that was registered microseconds earlier, must not affect other sessions or turns, and must never remove another turn's marker; a repeated or unknown cancel returns `{cancelled:false}` and leaves state unchanged. Task 8 covers this.
- A temporary session's marker write happens after its first `create`; if that write fails the committed nodes and consumed/confirmed queue stay committed, the turn ends `failed`/`storage.io`, the provider is never called, and no marker is left. A persisted session writes its marker before the driver starts. Task 8 covers this.
- Recovery must scan only nodes at or after `startOffset`, ignore a pre-existing sibling branch, synthesize `synthetic:"interrupted"` results only for calls that have no result, append exactly one `cancel` for the marker's `turnId`, and retain the marker when append fails. Dedupe by same-`turnId` cancel is scoped to the walked path inside the offset window; a cancel outside the window or on a non-selected sibling branch must not delete the marker. `cancel.at` is the real `endpointId` before recovery, not a generated synthetic id. If the append commits but throws `storage.io`, the next recovery must find the same-`turnId` cancel and only delete the marker. Tasks 1–3 cover this.
- Marker cleanup failure must be observable and must not turn a completed turn into a later spurious `daemon_restart` cancel: publish `turn.cleanup_failed`, append a same-`turnId` `cleanup_failed` cancel when needed, retry removal, and leave the marker plus the registered turn in `cleanup_failed` state. The turn remains in `turn.list`; a new `turn.start` for that session returns `turn.active` (not `steer`) until the marker is deleted or the process restarts into recovery. Task 8 covers this.
- `queue.enqueue` is a public method that validates under the session lock, rejects declarations while no inventory exists, preserves core size/error codes, and publishes `queue.updated`; tests enqueue through `Gateway.handle`, not a test-only internals API. Task 5 covers this.
- Non-empty effective extensions must be rejected atomically before a session exists; `parseDeclaration` shape checks alone are not enough. Task 5 covers this, including defaults and explicit lists.
- `Gateway.handle` must never leak raw causes, headers, bodies, or credentials; `PiscesError` maps to code/message and any other exception maps to a fixed `internal.error`. Task 4 covers this.
- Bootstrap must call `store.initialize()`, then `recoverActiveTurns`, and construct the Gateway only after both settle; no daemon listen/start/stop is claimed. Task 4 covers this.
- `session.read` pagination must return `queue`/`selection` only on the first page, must not let later pages raise the `seq` waterline, must reject `nodeId`/`cursor` values outside the session, and `session.configure` must reject atomically under an active turn. Tasks 6–7 cover this.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/daemon/src/session-store/session-store.ts` | Internal read accessors `getMeta`, `commitOffset`, `readTreeSince` | 1 |
| `packages/daemon/src/gateway/active-turn.ts` | `active-turn.json` read/write/remove/scan with strict validation | 2 |
| `packages/daemon/src/gateway/recovery.ts` | Restart recovery: interrupted results, `cancel` append, same-`turnId` dedupe | 3 |
| `packages/daemon/src/gateway/protocol.ts` | Daemon-local transport-neutral request/response and param/result types | 4 |
| `packages/daemon/src/gateway/bootstrap.ts` | Initialize storage, recover turns, then construct the Gateway | 4 |
| `packages/daemon/src/gateway/gateway.ts` | Dispatch, session runtimes, method routing, turn lifecycle | 4–8 |
| `packages/daemon/src/index.ts` | Export gateway, bootstrap, marker store, recovery, protocol types | 4, 8 |
| `packages/daemon/test/support/gateway-harness.ts` | Shared real-store/concurrency/bus harness plus fake provider and executor | 4 |
| `packages/daemon/test/session-store-accessors.test.ts` | Accessor behavior and error codes | 1 |
| `packages/daemon/test/active-turn.test.ts` | Marker file layout, validation, replacement, removal | 2 |
| `packages/daemon/test/recovery.test.ts` | Offset window, synthetic results, idempotency, committed-but-threw append, marker retention | 3 |
| `packages/daemon/test/gateway-provider.test.ts` | `provider.list` projection, safe dispatch errors | 4 |
| `packages/daemon/test/gateway-bootstrap.test.ts` | Initialize/recover-before-serve integration point | 4 |
| `packages/daemon/test/gateway-session-create.test.ts` | Defaults, workspace/model validation, extension rejection, queue materialization | 5 |
| `packages/daemon/test/gateway-queue.test.ts` | Public `queue.enqueue` validation, limits, events, lock behavior | 5 |
| `packages/daemon/test/gateway-session-read.test.ts` | Tree/branch reads, pagination, temp sessions, `seq` | 6 |
| `packages/daemon/test/gateway-session-configure.test.ts` | Meta update, instruction update, `turn.active` | 7 |
| `packages/daemon/test/gateway-turn.test.ts` | Turn start/steer/list/cancel, markers, temp marker failure, cleanup failure | 8 |
| `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` | §3.5/§5.3/§5.4/§6.5 synchronization | 9 |

## Fixed Interface Decisions

```ts
// packages/daemon/src/session-store/session-store.ts (added to SessionStore)
export interface SessionStore extends SessionRepository {
  initialize(): Promise<RecoveryIssue[]>;
  getMeta(sessionId: SessionId): Promise<SessionMeta>;
  commitOffset(sessionId: SessionId): Promise<number>;
  readTreeSince(sessionId: SessionId, offset: number): AsyncIterable<SessionNode>;
}
```

- `getMeta` throws `session.not_found` for a missing session, `storage.corrupt` for an invalid meta, and returns a detached clone. `commitOffset` returns the current `events.commit` value. `readTreeSince` yields committed nodes whose byte offset is `>= offset`, in commit order; `offset` must be a non-negative safe integer, otherwise `TypeError`. `SessionStore` still ignores `active-turn.json`.

```ts
// packages/daemon/src/gateway/active-turn.ts
import type { NodeId, SessionId, TurnId } from "@pisces/core";

export interface ActiveTurnMarker {
  turnId: TurnId;
  startedAt: string;
  startOffset: number;
  startNodeId?: NodeId;
}

export interface ActiveTurnStore {
  read(sessionId: SessionId): Promise<ActiveTurnMarker | undefined>;
  write(sessionId: SessionId, marker: ActiveTurnMarker): Promise<void>;
  remove(sessionId: SessionId, turnId: TurnId): Promise<void>;
  list(): Promise<{ sessionId: SessionId; marker: ActiveTurnMarker }[]>;
}

export interface ActiveTurnStoreOptions {
  dataDir: string;
}
export function createActiveTurnStore(options: ActiveTurnStoreOptions): ActiveTurnStore;
```

- Path is `<dataDir>/sessions/<sessionId>/active-turn.json`. `write` validates first, writes `active-turn.json.tmp` with fsync, then renames over the marker and fsyncs the session directory; the session directory must already exist (`storage.io` on ENOENT). `startedAt` must be the 24-byte RFC3339 UTC millisecond timestamp; `turnId`/`startNodeId` must be non-empty `[A-Za-z0-9_-]+` strings; `startOffset` must be a non-negative safe integer. Unknown or missing fields on read are `storage.corrupt`.
- `remove(sessionId, turnId)` reads first and deletes only when the stored `turnId` matches; a missing file is a no-op. `read` returns `undefined` when the file is absent. `list` scans existing session directories in UTF-16 order and ignores valid directories without a marker.

```ts
// packages/daemon/src/gateway/protocol.ts
import type {
  EntryName,
  JsonValue,
  NodeId,
  QueueEntry,
  QueueEntryId,
  QueueEntryInput,
  SelectionState,
  SessionId,
  SessionMeta,
  SessionNode,
  TurnId,
} from "@pisces/core";
import type { ActiveTurn } from "../runtime/concurrency.js";

export interface ProtocolError {
  code: string;
  message: string;
}

export interface GatewayRequest<P = JsonValue> {
  id: string;
  method: string;
  params: P;
}

export interface GatewayResponse<R = JsonValue> {
  id: string;
  result?: R;
  error?: ProtocolError;
}

export interface SessionDefaults {
  workspace?: string;
  provider?: string;
  model?: string;
  extensions?: EntryName[];
}

export interface CreateSessionParams {
  workspace?: string;
  templateId?: string;
  model?: string;
  provider?: string;
  systemPrompt?: string[];
  extensions?: EntryName[];
}
export interface SessionReadParams {
  sessionId: SessionId;
  nodeId?: NodeId;
  limit?: number;
  cursor?: NodeId;
}
export interface SessionReadResult {
  meta: SessionMeta;
  seq: number;
  records: SessionNode[];
  queue: QueueEntry[];
  selection: SelectionState;
  nextCursor?: NodeId;
}
export interface ConfigureSessionParams {
  sessionId: SessionId;
  model?: string;
  provider?: string;
  systemPrompt?: string;
}
export interface QueueEnqueueParams {
  sessionId: SessionId;
  entries: QueueEntryInput[];
}
export interface QueueEnqueueResult {
  ids: QueueEntryId[];
}
export interface TurnStartParams {
  sessionId: SessionId;
  nodeId?: NodeId;
}
export interface TurnStartResult {
  turnId: TurnId;
  mode: "new" | "steer";
}
export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
  pricing?: { input: number; output: number; currency: string };
}
export interface ProviderInfo {
  id: string;
  ready: boolean;
  models: ModelInfo[];
}
export interface ProviderListResult {
  providers: ProviderInfo[];
}
export interface TurnListResult {
  turns: ActiveTurn[];
}
```

- `GatewayResponse` carries exactly one of `result`/`error`. `Gateway.handle` echoes `id` and never leaks credentials, headers, provider bodies, or raw causes. A `PiscesError` maps to `{code, message}` only; `data` and `cause` are omitted in this stage. Every non-`PiscesError` maps to `{code:"internal.error", message:"Internal error"}`.
- Unknown methods return `protocol.unknown_method`. Malformed parameters (`params` not an object, missing/blank `sessionId`, non-string prompt entries, non-integer `limit`, blank ids) return `protocol.invalid_request`. Exceptions are never rethrown from `handle`; the fixed mapping above is the only outward error path.
- `SessionDefaults` and every injected facade are consumed read-only; the Gateway clones what it hands to core. There is no inventory/definition dependency in this stage: `entries` only classifies persisted names and cannot supply frozen definitions.

```ts
// packages/daemon/src/gateway/gateway.ts
import type {
  ContextEntries,
  EventBus,
  ProviderManagement,
  SessionId,
  SessionNodeDraft,
  Skills,
  ContextSourceRegistry,
  Tools,
  TurnId,
  QueueEntryId,
  NodeId,
} from "@pisces/core";
import type { Concurrency } from "../runtime/concurrency.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { ProviderHost } from "../provider/provider-host.js";
import type { ActiveTurnStore } from "./active-turn.js";
import type {
  GatewayRequest,
  GatewayResponse,
  SessionDefaults,
} from "./protocol.js";

export interface GatewayDeps {
  store: SessionStore;
  providers: ProviderManagement;
  providerHost: ProviderHost;
  concurrency: Concurrency;
  events: EventBus;
  markers: ActiveTurnStore;
  defaults?: SessionDefaults;
  createTools?: () => Tools;
  entries?: ContextEntries;
  skills?: Skills;
  sources?: ContextSourceRegistry;
  validateWorkspace?: (workspace: string) => Promise<boolean>;
  newSessionId?: () => SessionId;
  newTurnId?: () => TurnId;
  newQueueEntryId?: () => QueueEntryId;
  newNodeId?: () => NodeId;
  now?: () => string;
}

export interface Gateway {
  handle(request: GatewayRequest): Promise<GatewayResponse>;
}

export function createGateway(deps: GatewayDeps): Gateway;
```

- There is no test-only production factory and no debug API on `Gateway`. Tests set up queue state through the public `queue.enqueue` method and observe events through a test harness subscription.

- Defaults: ids use `crypto.randomUUID()`; `now` uses `new Date().toISOString()`; `createTools` uses `createTools()` from core; `entries` is `{ kind: () => undefined }`; `skills` is `{ selected: () => [] }`; `sources` is `{ get: () => undefined }`; `validateWorkspace` requires an absolute path, an existing directory, and `W_OK` access, returning `false` instead of throwing.
- The runtime factory creates `Sessions` with the injected `newNodeId`/`now`, one `Context` bound to the shared clock and `runExclusive` for that session, and one `AgentLoopDriver` whose `options.runExclusive` ignores its argument and uses `concurrency.runExclusive(sessionId, task)` so each session has exactly one single-turn driver.
- `createGateway` subscribes once to `deps.events`; the only handler synchronously moves the runtime for `turn.ended` to phase `"cleanup"` (idempotent, never throws). It does not unregister; unregistration happens only after marker deletion in `launch`. Per-connection protocol event push is not implemented in this stage.
- `createGateway` is the low-level constructor. Production assembly must use `bootstrapGateway`: `createGateway` itself never initializes storage or recovery.
- Environment variables, credentials, and CLI options are not read here. The eventual assembly loads configuration and passes a frozen `SessionDefaults`.

```ts
// packages/daemon/src/gateway/recovery.ts
import type { Sessions } from "@pisces/core";
import type { RecoveryIssue, SessionStore } from "../session-store/session-store.js";
import type { ActiveTurnStore } from "./active-turn.js";

export interface RecoveryDeps {
  store: SessionStore;
  markers: ActiveTurnStore;
  sessions: Sessions;
}

export function recoverActiveTurns(deps: RecoveryDeps): Promise<RecoveryIssue[]>;
```

- Recovery does not create events and does not run the driver. It assumes `store.initialize()` already ran. If the walked path inside the `startOffset` window already contains a `cancel` payload with the marker's `turnId`, recovery synthesizes and appends nothing and deletes the marker only. A same-`turnId` cancel outside the offset window or on a non-selected sibling branch is ignored: it must not delete the marker by itself. An append that commits but throws `storage.io` leaves the marker; the next recovery finds the committed cancel on the walked path and deletes the marker. Other per-session failures are collected as `RecoveryIssue` and leave the marker in place; successes delete the marker.

```ts
// packages/daemon/src/gateway/bootstrap.ts
export interface BootstrapResult {
  gateway: Gateway;
  initializationIssues: RecoveryIssue[];
  recoveryIssues: RecoveryIssue[];
}
export function bootstrapGateway(deps: GatewayDeps): Promise<BootstrapResult>;
```

- `bootstrapGateway` calls `deps.store.initialize()` first, then creates a recovery `Sessions` with `deps.store`/`deps.newNodeId`/`deps.now`, calls `recoverActiveTurns`, and only after both settle calls `createGateway(deps)`. It is the integration point tests exercise; it does not start/stop a daemon, listen on a socket, or handle signals. A future daemon entry must await it before serving and must surface the returned issues; readiness is not reported early.

```ts
// packages/daemon/test/support/gateway-harness.ts
export interface GatewayHarnessOptions {
  defaults?: SessionDefaults;
  execute?: ExecuteProvider;
  adapter?: LlmAdapter;
  validateWorkspace?: (workspace: string) => Promise<boolean>;
  markerStore?: ActiveTurnStore;
  newSessionId?: () => SessionId;
  providers?: ProviderManagement;
}
export interface GatewayHarness {
  gateway: Gateway;
  store: SessionStore;
  markers: ActiveTurnStore;
  concurrency: Concurrency;
  bus: EventBus;
  providers: ProviderManagement;
  dataDir: string;
  executed: string[];
  events(): EngineEvent[];
  waitForEvent(type: string): Promise<EngineEvent>;
  waitForTurnEnd(turnId: TurnId): Promise<TurnEndedEvent>;
  seed(drafts: SessionNodeDraft[], meta?: SessionMeta): Promise<{ meta: SessionMeta; nodes: SessionNode[] }>;
  enqueue(sessionId: SessionId, entries: QueueEntryInput[]): Promise<QueueEntryId[]>;
  close(): Promise<void>;
}
export function createGatewayHarness(options?: GatewayHarnessOptions): Promise<GatewayHarness>;
export function descriptor(overrides?: Partial<ProviderDescriptor>): ProviderDescriptor;
export function gatewayModel(id: string): ModelDescriptor;
export function draftUser(value: string): SessionNodeDraft;
export function draftDeclaration(toggle: EntryName[]): SessionNodeDraft;
export function draftQueueUser(value: string): QueueEntryInput;
```

- The harness uses a real temporary `dataDir`, real `createSessionStore`/`createConcurrency`/`createEventBus`/`createSessionEventClock`/`createActiveTurnStore`, a real `createProviderManagement` pre-registered with descriptor `p` / model `m` under dialect `test` (unless `providers` is injected), and a fake `ProviderHost` (`ready` is true when the provider exists and has models; `execute` returns the injected iterable or yields the single string `"frame"`). The default adapter emits `{type:"content",delta:"ok"}` then `{type:"stop",reason:"stop"}` for every chunk. It constructs the gateway through `bootstrapGateway` so storage initialization and recovery happen before any request; it does not expose internals. `enqueue` calls `gateway.handle({method:"queue.enqueue",…})` and returns `ids`. `events()` returns cloned published events; `waitForEvent` resolves from an already recorded event or the next matching one; `waitForTurnEnd` is the `turn.ended` specialization. `seed` writes a persisted session directly through `SessionStore` with deterministic ids. `descriptor`/`gatewayModel` build valid fixtures; `draftUser`/`draftDeclaration`/`draftQueueUser` build seed drafts and queue entries. `close` removes the temporary directory.

---

### Task 1: SessionStore read accessors

**Files:**
- Modify: `packages/daemon/src/session-store/session-store.ts`
- Test: `packages/daemon/test/session-store-accessors.test.ts`

**Interfaces:**
- Consumes: existing `SessionStore` internals (`load`, `cache`, `issuesBySession`, `ready`).
- Produces: `getMeta`, `commitOffset`, `readTreeSince` as declared above.

- [ ] **Step 1: Write the failing accessor tests.**

```ts
const ids = (nodes: SessionNode[]) => nodes.map((node) => node.id);

test("exposes metadata, commit offset, and nodes since an offset", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  await store.create(meta, [node("n1"), node("n2", "n1")]);
  const first = await store.commitOffset(sid);
  await store.append(sid, [node("n3", "n2")]);
  expect(await store.getMeta(sid)).toEqual(meta);
  expect(await store.commitOffset(sid)).toBeGreaterThan(first);
  expect(ids(await collect(store.readTreeSince(sid, first)))).toEqual(["n3"]);
  expect(ids(await collect(store.readTreeSince(sid, 0)))).toEqual(["n1", "n2", "n3"]);
  expect(() => store.readTreeSince(sid, -1)).toThrow(TypeError);
});
```

Also assert `getMeta` returns a clone that cannot mutate the cache, `session.not_found` for a missing session, `storage.corrupt` for a bad `meta.json`, an uninitialized store throws `TypeError`, and `readTreeSince(sid, commitOffset)` yields `[]`.

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/session-store-accessors.test.ts`

Expected: FAIL because the methods do not exist.

- [ ] **Step 3: Implement the three accessors.**

Read through `load`, clone meta, validate the offset in `readTreeSince`, and filter `index.positions` entries by `position.offset >= offset` in insertion order.

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/session-store/session-store.ts packages/daemon/test/session-store-accessors.test.ts
git commit -m "feat(daemon): expose session commit read accessors"
```

### Task 2: `active-turn.json` store

**Files:**
- Create: `packages/daemon/src/gateway/active-turn.ts`
- Test: `packages/daemon/test/active-turn.test.ts`

**Interfaces:**
- Consumes: `sessionStoreIo` from `../session-store/session-store-io.js`, `PiscesError`, id brands.
- Produces: `ActiveTurnMarker`, `ActiveTurnStore`, `ActiveTurnStoreOptions`, `createActiveTurnStore`.

- [ ] **Step 1: Write the failing marker tests.**

```ts
test("writes, replaces, reads, scans and conditionally removes the marker", async () => {
  const store = createActiveTurnStore({ dataDir });
  const marker = { turnId: "t1" as TurnId, startedAt: NOW, startOffset: 12 };
  await store.write(sid, marker);
  expect(await store.read(sid)).toEqual(marker);
  expect(await store.list()).toEqual([{ sessionId: sid, marker }]);
  await store.write(sid, { ...marker, turnId: "t2" as TurnId });
  await store.remove(sid, "t1" as TurnId);
  expect(await store.read(sid)).toMatchObject({ turnId: "t2" });
  await store.remove(sid, "t2" as TurnId);
  expect(await store.read(sid)).toBeUndefined();
  expect(await store.list()).toEqual([]);
});
```

Seed the session directory with `mkdir(join(dataDir, "sessions", sid), { recursive: true })` first. Also assert the file path is exactly `sessions/<sid>/active-turn.json`, a write into a missing session directory is `storage.io`, unknown or missing fields read as `storage.corrupt`, a non-24-byte timestamp is rejected on write, and `startNodeId` round-trips.

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/active-turn.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the marker store.**

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/gateway/active-turn.ts packages/daemon/test/active-turn.test.ts
git commit -m "feat(daemon): persist active turn markers"
```

### Task 3: Daemon restart recovery

**Files:**
- Create: `packages/daemon/src/gateway/recovery.ts`
- Test: `packages/daemon/test/recovery.test.ts`

**Interfaces:**
- Consumes: Task 1 `commitOffset`/`readTreeSince`, Task 2 `ActiveTurnStore`, core `Sessions`/`SessionNodeDraft`/`CancelPayload`.
- Produces: `RecoveryDeps`, `recoverActiveTurns`.

- [ ] **Step 1: Write the failing recovery test.**

```ts
test("ignores the pre-turn sibling branch, synthesizes interrupted results, and cancels once", async () => {
  const h = await createRecoveryHarness(); // real store + Sessions + marker store
  const root = await h.appendRoot("n1"); // user node committed before the turn
  await h.appendOldBranch(root, "old"); // historical child, committed before the turn starts
  const startOffset = await h.store.commitOffset(sid);
  await h.markers.write(sid, { turnId: "t1" as TurnId, startedAt: NOW, startOffset, startNodeId: root });
  const endpoint = await h.appendTurnAssistant(root, "turn", "call_1"); // committed after startOffset
  const issues = await recoverActiveTurns(h.deps);
  expect(issues).toEqual([]);
  const nodes = await h.tree();
  const tail = nodes.slice(-2);
  expect(tail[0]).toMatchObject({
    kind: "agent",
    role: "tool",
    content: [{ type: "toolResult", toolCallId: "call_1", synthetic: "interrupted" }],
  });
  expect(JSON.parse((tail[1]!.content[0] as { text: string }).text)).toEqual({
    turnId: "t1",
    reason: "daemon_restart",
    at: endpoint.id,
  });
  expect(nodes.at(-2)?.parentId).toBe(endpoint.id);
  expect(nodes.at(-1)?.parentId).toBe(nodes.at(-2)?.id);
  expect(await h.markers.read(sid)).toBeUndefined();
});
```

Do not expect `cancel.at` to name the synthetic node: ids are generated inside the single `Sessions.append` batch. `cancel.at` is the real committed endpoint `endpoint.id` before recovery, matching HLD `CancelPayload.at = 中止发生时最后已写节点`. Parent pointers still chain `endpoint -> synthetic(s) -> cancel` in one atomic batch.

Also assert: a temporary session marker without `startNodeId` starts from the root with `startOffset: 0`; a call that already has a matching `toolResult` gets no synthetic node; a `cancel` payload already carrying the marker's `turnId` **on the walked path inside the recovery window** causes no append and only marker deletion; a same-`turnId` cancel on a non-selected sibling branch or before `startOffset` is ignored, does not delete the marker by itself, and recovery still appends the current branch's synthetic/cancel before deleting the marker; an append that commits and then throws `storage.io` keeps the marker, and a second recovery finds the committed `cancel` and deletes the marker without adding another synthetic/cancel node; a pure append failure returns one `RecoveryIssue` and keeps the marker; a missing/corrupt session keeps the marker; a marker whose `startNodeId` is absent from the session is `session.node_not_found` and keeps the marker; calling `recoverActiveTurns` before `store.initialize()` throws `TypeError` and leaves the marker untouched.

Keep `createRecoveryHarness` local to the test file and build it on a real `createSessionStore`, `createSessions` with deterministic ids/timestamps, and `createActiveTurnStore`. It exposes `deps`, `store`, `markers`, `tree()`, `appendRoot(id)`, `appendOldBranch(parentId, id)`, `appendTurnAssistant(parentId, id, callId)` returning the committed endpoint node, `appendCancel(parentId, payload)` for pre-existing cancel fixtures, and `failNextAppendAfterCommit()` (a `Sessions` wrapper that delegates the repository append and then throws `storage.io` once), all appending through `Sessions`.

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/recovery.test.ts`

Expected: FAIL because recovery does not exist.

- [ ] **Step 3: Implement recovery.**

Walking rules: scan `readTreeSince(startOffset)`, start at `startNodeId` or the first scanned node for a temporary session, follow the last committed child at each step, stop at a node with no scanned child, then examine only the walked path. Collect `toolCall` ids from the last `assistant` node on the path and the `toolCallId`s of every `toolResult` on the path; synthesize one `kind=agent`/`role=tool` node per unmatched call in call order with `content:[{type:"toolResult",toolCallId,content:[{type:"text",text:"结果未知，可能已部分生效，请核验"}],synthetic:"interrupted"}]` and `source:"recovery"`. Parse existing `cancel` payloads defensively (`storage.corrupt` on invalid JSON) and check them for the marker's `turnId` only among nodes actually yielded by `readTreeSince(startOffset)` and on the walked path. A same-`turnId` cancel outside the offset window or on a non-selected sibling branch is not a match and must not cause marker deletion. If a matching cancel exists on the walked path, append nothing and delete the marker only. Otherwise append the synthetic nodes and then a `kind=control`/`role=cancel` node (`{turnId, reason:"daemon_restart", at:endpointId}`) as one chained `Sessions.append(sessionId, drafts, endpointId)` batch; `endpointId` is the real committed endpoint before recovery, because synthetic ids do not exist until the batch is built. Then delete the marker. On any failure keep the marker and push `{sessionId, error}`. A committed append that throws `storage.io` therefore leaves the marker, and the next run's scoped same-`turnId` check prevents duplicate synthetic/cancel nodes.

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/gateway/recovery.ts packages/daemon/test/recovery.test.ts
git commit -m "feat(daemon): recover interrupted turns"
```

### Task 4: Gateway dispatch, `provider.list`, and test harness

**Files:**
- Create: `packages/daemon/src/gateway/protocol.ts`
- Create: `packages/daemon/src/gateway/gateway.ts`
- Create: `packages/daemon/src/gateway/bootstrap.ts`
- Create: `packages/daemon/test/support/gateway-harness.ts`
- Test: `packages/daemon/test/gateway-provider.test.ts`
- Test: `packages/daemon/test/gateway-bootstrap.test.ts`

**Interfaces:**
- Consumes: plan A runtime, `ProviderManagement`, `ProviderHost`, `EventBus`, `SessionStore`, `ActiveTurnStore`, `recoverActiveTurns`.
- Produces: every type in `protocol.ts`, `GatewayDeps`, `Gateway`, `createGateway`, `BootstrapResult`, `bootstrapGateway`, and the harness contract above. Only `provider.list` is routed in this task.

- [ ] **Step 1: Write the failing provider, safe-error, and bootstrap tests.**

```ts
test("projects providers and models without configuration details", async () => {
  const h = await createGatewayHarness();
  h.providers.registerProvider(descriptor({ id: "empty", models: [] }));
  const response = await h.gateway.handle({ id: "1", method: "provider.list", params: {} });
  expect(response).toEqual({
    id: "1",
    result: {
      providers: [
        { id: "empty", ready: false, models: [] },
        {
          id: "p",
          ready: true,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    },
  });
  expect(JSON.stringify(response)).not.toMatch(/baseUrl|dialect|credentialRef|headers/);
});
```

Also assert an empty catalogue returns `{providers: []}`, an unknown method returns `protocol.unknown_method`, and `params: null` returns `protocol.invalid_request`.

Add a safe-error test that uses `createGatewayHarness({ providers: throwingProviders() })`, where `list()` throws `new Error("secret=sk-live headers={authorization} body=...")`. Expect `{id, error:{code:"internal.error", message:"Internal error"}}` and assert the serialized response contains none of those strings. Add a second case where a routed handler throws `new PiscesError("session.invalid_model", "Invalid model", {cause: new Error("raw cause"), data:{headers:{authorization:"secret"}}})`; expect only `{code,message}` and no `data`/`cause`/secret.

Add a bootstrap integration test that creates a real store in a temp `dataDir`, initializes it once to seed a session plus an `active-turn` marker, then calls `bootstrapGateway(deps)`. Assert the returned `gateway` is constructed only after `store.initialize()` and `recoverActiveTurns` complete by reading the store branch directly after bootstrap and seeing the recovered synthetic `interrupted` result and `daemon_restart` cancel. No daemon listen/start/stop is asserted or implemented.

- [ ] **Step 2: Run the red tests.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-provider.test.ts packages/daemon/test/gateway-bootstrap.test.ts`

Expected: FAIL because the gateway, bootstrap, and harness do not exist.

- [ ] **Step 3: Implement the harness, protocol types, dispatch, provider.list, and bootstrap.**

Dispatch checks the params object, looks up the handler in a `Record<string, (params) => Promise<unknown>>`, converts the return value to `{id, result}`, maps `PiscesError` to `{id, error:{code,message}}`, and maps any non-`PiscesError` to `{id, error:{code:"internal.error", message:"Internal error"}}`. `bootstrapGateway` initializes the store, creates a recovery `Sessions`, runs `recoverActiveTurns`, then calls `createGateway`.

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/gateway/protocol.ts packages/daemon/src/gateway/gateway.ts \
  packages/daemon/src/gateway/bootstrap.ts packages/daemon/test/support/gateway-harness.ts \
  packages/daemon/test/gateway-provider.test.ts packages/daemon/test/gateway-bootstrap.test.ts
git commit -m "feat(daemon): add gateway dispatch and provider listing"
```

### Task 5: `session.create`, public `queue.enqueue`, and session runtime

**Files:**
- Modify: `packages/daemon/src/gateway/gateway.ts`
- Test: `packages/daemon/test/gateway-session-create.test.ts`
- Test: `packages/daemon/test/gateway-queue.test.ts`

**Interfaces:**
- Consumes: Task 4 gateway skeleton; core `createContext`, `createSessions`, `createAgentLoopDriver`, `createTools`; `QueueEnqueueParams`/`QueueEnqueueResult`.
- Produces: internal `SessionRuntime` (`meta`, `persisted`, `context`, `sessions`, `driver`, `eventClock`, optional `pendingMarker`), the routed `session.create`, and the routed `queue.enqueue`.

- [ ] **Step 1: Write the failing create and queue tests.**

```ts
test("creates a temporary session from defaults and materializes the queue", async () => {
  const h = await createGatewayHarness({
    defaults: { workspace: "/workspace", provider: "p", model: "m" },
  });
  const created = await h.gateway.handle({
    id: "1",
    method: "session.create",
    params: { systemPrompt: ["be brief"] },
  });
  const meta = created.result as SessionMeta;
  expect(meta).toMatchObject({ model: "m", provider: "p", workspace: "/workspace", schemaVersion: 1 });
  expect(await h.store.list()).toEqual([]);
  const queued = h.events().filter((event) => event.type === "queue.updated").at(-1);
  expect(queued?.data).toMatchObject({
    queue: [
      { kind: "agent", role: "system", source: "create", content: [{ type: "text", text: "be brief" }] },
    ],
  });
});
```

The harness `enqueue` helper calls the public `queue.enqueue` method; there is no `h.queue` or runtime-count accessor.

Also assert: explicit `extensions: []` is accepted even when defaults are non-empty; omitted `workspace` with no default returns `session.workspace_required`; `validateWorkspace` returning false returns `session.invalid_workspace`; one of `provider`/`model` alone, or neither with no defaults, returns `session.model_required`; an unknown pair returns `session.invalid_model`; `templateId` returns `protocol.invalid_request`; `systemPrompt` with a non-string entry returns `protocol.invalid_request`.

Extension tests: a non-`package#name` name returns `queue.invalid_control`; duplicate names return `queue.duplicate_name`; a non-empty explicit list (`["pkg#tool"]`) and a non-empty default list both return `queue.invalid_control`. In every rejection case, use the harness's deterministic `newSessionId` and assert the error code, `store.list()` is empty, no `queue.updated` event was published, and a follow-up public `queue.enqueue` against that id returns `session.not_found` (proving no runtime was leaked). Do not accept a valid-looking list and then ignore it.

Queue tests in `gateway-queue.test.ts`:

```ts
test("enqueues through the public method and publishes queue.updated", async () => {
  const h = await createGatewayHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const response = await h.gateway.handle({
    id: "1",
    method: "queue.enqueue",
    params: { sessionId: meta.id, entries: [draftQueueUser("hello")] },
  });
  const result = response.result as QueueEnqueueResult;
  expect(result.ids).toHaveLength(1);
  expect(h.events().filter((event) => event.type === "queue.updated").at(-1)?.data).toMatchObject({
    queue: [{ kind: "agent", role: "user", content: [{ type: "text", text: "hello" }] }],
  });
});
```

Also assert: an empty entry list returns `{ids: []}`; an unknown session returns `session.not_found`; malformed params return `protocol.invalid_request`; a declaration, compaction, or cancel control entry returns `queue.invalid_control` (no inventory/definition source exists); invalid agent role/content returns `queue.invalid_control`; a >256 KiB entry returns `queue.entry_too_large`; a queue over 1 MiB returns `queue.too_large`; two concurrent calls on the same session both complete and their `queue.updated` events are serialized.

- [ ] **Step 2: Run the red tests.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-session-create.test.ts packages/daemon/test/gateway-queue.test.ts`

Expected: FAIL because `session.create` and `queue.enqueue` are not routed.

- [ ] **Step 3: Implement runtime creation, `session.create`, and `queue.enqueue`.**

Resolution order: explicit params, then frozen defaults. Validate workspace, provider/model, and effective extensions before creating anything. Resolve `extensions` as `params.extensions ?? defaults.extensions ?? []`; validate names and duplicates; if the effective list is non-empty, return `queue.invalid_control` without creating a runtime, queue, event, or marker. Build the temp `SessionMeta`, create the runtime with `persisted:false`, enqueue prompts under `runExclusive`, and delete the runtime entry if enqueue throws. The runtime's `Context` receives the shared clock, `runExclusive` bound to that session, the injected facades, and the marker-aware `Sessions`.

`queue.enqueue`: validate `{sessionId, entries}` shape, acquire `runExclusive(sessionId, …)`, load or create the runtime, call `context.initialize()`, reject every `kind="control"` entry with `queue.invalid_control` (no inventory), then delegate to `context.enqueue(entries)` and return `{ids}`. Core owns size/content/role validation and publishes `queue.updated` through `Context`; do not reimplement those limits in the Gateway.

Marker-aware `Sessions`: `create` delegates, flips `runtime.persisted`/`onPersisted`, and when `runtime.pendingMarker` is set writes `{turnId, startedAt, startOffset: 0}` (no `startNodeId`); a write failure throws `PiscesError("storage.io", "Active turn marker could not be written", {cause})`. `append`/`readBranch`/`readTree`/`list`/`updateMeta` delegate unchanged.

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/gateway/gateway.ts packages/daemon/test/gateway-session-create.test.ts \
  packages/daemon/test/gateway-queue.test.ts
git commit -m "feat(daemon): create sessions and enqueue messages"
```

### Task 6: `session.read`

**Files:**
- Modify: `packages/daemon/src/gateway/gateway.ts`
- Test: `packages/daemon/test/gateway-session-read.test.ts`

**Interfaces:**
- Consumes: Task 5 runtime; `Context.snapshot`, `Context.selectionFor`; `Sessions.readTree`/`readBranch`.
- Produces: routed `session.read` returning `SessionReadResult`.

- [ ] **Step 1: Write the failing read tests.**

```ts
const byteLength = (node: SessionNode) => new TextEncoder().encode(JSON.stringify(node)).length;

test("reads persisted records and returns queue and selection on the first page only", async () => {
  const h = await createGatewayHarness();
  const { meta, nodes } = await h.seed([draftUser("one"), draftUser("two"), draftUser("three")]);
  const first = await h.gateway.handle({
    id: "1",
    method: "session.read",
    params: { sessionId: meta.id, limit: byteLength(nodes[0]!) + 8 },
  });
  const page = first.result as SessionReadResult;
  expect(page.meta).toEqual(meta);
  expect(page.records).toEqual([nodes[0]]);
  expect(page.queue).toEqual([]);
  expect(page.selection).toEqual([]);
  expect(page.nextCursor).toBe(nodes[0]!.id);
  const second = await h.gateway.handle({
    id: "2",
    method: "session.read",
    params: { sessionId: meta.id, limit: byteLength(nodes[1]!) + 8, cursor: page.nextCursor },
  });
  expect((second.result as SessionReadResult).records).toEqual([nodes[1]]);
  expect((second.result as SessionReadResult).queue).toEqual([]);
  expect((second.result as SessionReadResult).nextCursor).toBe(nodes[1]!.id);
});
```

Add a temporary-session test: `session.create` with `systemPrompt: ["be brief"]`, then `session.read` returns `{records: [], selection: [], queue: [<system create entry>]}`; the same read with a `nodeId` returns `session.node_not_found`.

Also assert: no `limit` returns all nodes; `nodeId` returns the root-to-node branch; an unknown `nodeId` or `cursor` returns `session.node_not_found`; an unknown session returns `session.not_found`; `seq` equals the shared clock value and a later page does not change it; `limit: 0` or `1.5` returns `protocol.invalid_request`; selection reflects only declarations on the requested branch (seed with `draftDeclaration(["pkg#tool"])`).

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-session-read.test.ts`

Expected: FAIL because `session.read` is not routed.

- [ ] **Step 3: Implement `session.read`.**

Inside one `runExclusive`: load or reuse the runtime (persisted sessions create `Context` with `persisted:true` and call `initialize`), validate params, collect records, compute selection via `context.selectionFor(nodeId)`, cut at `cursor`, accumulate page bytes with `TextEncoder` (always include at least one node), and set `nextCursor` only when nodes remain. `queue`/`selection` are filled only when `cursor` is undefined.

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/gateway/gateway.ts packages/daemon/test/gateway-session-read.test.ts
git commit -m "feat(daemon): read session records and queues"
```

### Task 7: `session.configure`

**Files:**
- Modify: `packages/daemon/src/gateway/gateway.ts`
- Test: `packages/daemon/test/gateway-session-configure.test.ts`

**Interfaces:**
- Consumes: Task 5 runtime; `SessionStore.updateMeta`; `Context.updateMeta`; `Context.edit`/`enqueue`.
- Produces: routed `session.configure`.

- [ ] **Step 1: Write the failing configure tests.**

```ts
test("updates persisted model/provider atomically and rejects while a turn is active", async () => {
  const h = await createGatewayHarness();
  h.providers.registerProvider(descriptor({ id: "p2", models: [gatewayModel("m2")] }));
  const { meta } = await h.seed([draftUser("hello")]);
  const updated = await h.gateway.handle({
    id: "1",
    method: "session.configure",
    params: { sessionId: meta.id, model: "m2", provider: "p2" },
  });
  expect((updated.result as SessionMeta).model).toBe("m2");
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m2", provider: "p2" });

  h.concurrency.registerTurn(meta.id, "t1" as TurnId, NOW, () => {});
  const rejected = await h.gateway.handle({
    id: "2",
    method: "session.configure",
    params: { sessionId: meta.id, model: "m", provider: "p", systemPrompt: "ignored" },
  });
  expect(rejected.error).toEqual({ code: "turn.active", message: expect.any(String) });
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m2", provider: "p2" });
});
```
Also assert: temp sessions update only memory (store still empty); one of `model`/`provider` returns `session.model_required`; an unknown pair returns `session.invalid_model` and leaves meta unchanged; `systemPrompt` updates an existing unconfirmed `source="instruction"` entry, adds one when absent, and never writes meta or records; `queue.updated` is published once per queue change; an unknown session is `session.not_found`.

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-session-configure.test.ts`

Expected: FAIL because `session.configure` is not routed.

- [ ] **Step 3: Implement `session.configure`.**

Inside `runExclusive`: load the runtime, check `concurrency.activeTurn(sessionId)` first, validate the pair, write `store.updateMeta` before `context.updateMeta` for persisted sessions, then handle `systemPrompt` through the queue. Return a clone of the runtime meta.

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/gateway/gateway.ts packages/daemon/test/gateway-session-configure.test.ts
git commit -m "feat(daemon): configure session metadata and instructions"
```

### Task 8: `turn.start` / `turn.list` / `turn.cancel` and marker lifecycle

**Files:**
- Modify: `packages/daemon/src/gateway/gateway.ts`
- Modify: `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/gateway-turn.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7; core `AgentLoopDriver`, `RunTurnInput`; plan A `Concurrency`; `ProviderHost.execute`; `ProviderManagement.select/createAdapter`.
- Produces: routed turn methods, per-turn `AbortController` registration/unregistration, runtime `phase` lifecycle (`running`/`cleanup`/`cleanup_failed`), persisted-session marker write, temp-session marker decorator, observable marker-cleanup failure handling, and the daemon export of gateway/bootstrap/marker/recovery/protocol types.

- [ ] **Step 1: Write the failing persisted turn test.**

```ts
test("writes the marker before the driver, appends the turn, and cleans up", async () => {
  const h = await createGatewayHarness();
  const { meta, nodes } = await h.seed([draftUser("hello")]);
  const started = await h.gateway.handle({ id: "1", method: "turn.start", params: { sessionId: meta.id } });
  const { turnId, mode } = started.result as TurnStartResult;
  const ended = await h.waitForTurnEnd(turnId);
  expect(mode).toBe("new");
  expect(ended.data.reason).toBe("completed");
  expect(await h.markers.read(meta.id)).toBeUndefined();
  const records = await collect(h.store.readBranch(meta.id));
  expect(records.map((n) => n.role)).toEqual(["user", "assistant"]);
  expect(records[1]!.parentId).toBe(nodes[0]!.id);
});
```

Also assert: at `execute` time the marker exists with `startOffset` equal to `commitOffset` before the turn and `startNodeId` equal to the last node (or the explicit `nodeId`); `turn.list` returns that `ActiveTurn`; after `turn.ended` and successful marker deletion `turn.list` is `[]`; during `cleanup`/`cleanup_failed` `turn.list` still contains it (covered by the cleanup test below); an explicit `nodeId` selects that branch; a temp session with `nodeId` returns `session.node_not_found`; an unknown session returns `session.not_found`; a model/provider removed from the catalogue returns `session.invalid_model` and starts nothing.

- [ ] **Step 2: Run the red persisted test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-turn.test.ts`

Expected: FAIL because turn methods are not routed.

- [ ] **Step 3: Implement the new-turn path.**

Under one `runExclusive`: check `activeTurn` and the runtime phase. If a turn is active and its phase is `"running"`, return the steer path (confirm newly enqueued entries, return the existing `turnId`, never register/write a second marker). If the phase is `"cleanup"` or `"cleanup_failed"`, throw `PiscesError("turn.active", "Previous turn is still finalizing")` before confirming/enqueuing anything. If no turn is active, validate `nodeId`; resolve provider/model/adapter/execute/contextWindow/maxOutput; compute `startNodeId` and `startOffset`; write the marker for persisted sessions; `context.confirm()`; create the `AbortController`; `registerTurn(sessionId, turnId, startedAt, () => controller.abort(new DOMException("Turn cancelled","AbortError")))`, and set the runtime phase to `"running"`. If confirm or marker writing fails, remove the marker (persisted) or clear `pendingMarker` and rethrow. After the locked block returns, start `driver.run(input)` with `void launch(...)`.

The runtime carries `phase: "running" | "cleanup" | "cleanup_failed"`. The `EventBus` handler for `turn.ended` synchronously sets that runtime's phase to `"cleanup"` and never throws; it does **not** unregister the turn. This closes the window between `turn.ended` and marker removal: `turn.list` still includes the turn, `turn.start` sees the active turn in `cleanup` phase and returns `turn.active` instead of `steer`, and `turn.cancel` returns `{cancelled:false}` without invoking the old abort handle.

`launch` clears `pendingMarker`, waits for the driver, then in a `finally` acquires `runExclusive` only long enough to set phase `"cleanup"` if it is still `"running"`, then releases the lock. New `turn.start` calls can now acquire the lock, see the registered turn in `cleanup` phase, and fail fast with `turn.active` instead of waiting on marker I/O. `launch` attempts `markers.remove(sessionId, turnId)` outside the session lock. On success it reacquires `runExclusive`, calls `unregisterTurn`, and clears the phase; only then may a new turn start. Marker removal failure is not swallowed. On failure, reacquire `runExclusive` to allocate the event sequence, publish a safe `EngineEvent` `{type:"turn.cleanup_failed", sessionId, seq, at, data:{turnId, code:"storage.io", message:"Active turn marker could not be removed"}}` through `deps.events.publish(structuredClone(event))` (catch publication failures so they cannot abort cleanup), and, if the current branch has no `cancel` with the same `turnId`, append one `kind=control`/`role=cancel` node `{turnId, reason:"cleanup_failed", at:lastNodeId}`. Release the lock and retry `markers.remove` once outside it. If the retry succeeds, reacquire `runExclusive`, `unregisterTurn`, and clear the phase. If the retry also fails, reacquire `runExclusive`, leave the marker, set phase `"cleanup_failed"`, keep the turn registered, and do not throw out of `launch`. The event is the observable error; the same-`turnId` cancel lets recovery delete the marker without appending a spurious `daemon_restart` cancel. If the append itself fails, leave the marker, set `"cleanup_failed"`, and still publish the event. A `cleanup_failed` turn stays in `turn.list` and blocks new turns until the process restarts and recovery deletes the marker; do not overwrite the marker or report the cleanup failure as a successful finalization.

- [ ] **Step 4: Write the failing steer and cancel tests.**

```ts
const blockedExecute = (): ExecuteProvider =>
  async function* (_request, signal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

test("steers into the active turn and rejects nodeId", async () => {
  const h = await createGatewayHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("hello")]);
  const first = await h.gateway.handle({ id: "1", method: "turn.start", params: { sessionId: meta.id } });
  const turnId = (first.result as TurnStartResult).turnId;
  const steer = await h.gateway.handle({ id: "2", method: "turn.start", params: { sessionId: meta.id } });
  expect(steer.result).toEqual({ turnId, mode: "steer" });
  const forbidden = await h.gateway.handle({
    id: "3",
    method: "turn.start",
    params: { sessionId: meta.id, nodeId: "n1" as NodeId },
  });
  expect(forbidden.error?.code).toBe("turn.node_id_forbidden");
  await h.gateway.handle({ id: "4", method: "turn.cancel", params: { turnId } });
  await h.waitForTurnEnd(turnId);
});
```

```ts
test("cancels by turn id without taking the session lock", async () => {
  const h = await createGatewayHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await h.gateway.handle({ id: "1", method: "turn.start", params: { sessionId: meta.id } });
  const turnId = (started.result as TurnStartResult).turnId;
  const cancelled = await h.gateway.handle({ id: "2", method: "turn.cancel", params: { turnId } });
  expect(cancelled.result).toEqual({ cancelled: true });
  expect((await h.waitForTurnEnd(turnId)).data.reason).toBe("cancelled");
  expect(await h.gateway.handle({ id: "3", method: "turn.cancel", params: { turnId } })).toEqual({
    id: "3",
    result: { cancelled: false },
  });
});
```

Also assert steer confirms newly enqueued entries (`h.enqueue(meta.id, [draftQueueUser("steer")])` before the second `turn.start`, then inspect the `queue.updated` event or `session.read` and see `confirmedAt` set) and never writes a second marker, that `turn.start` with `nodeId` under a live turn does not confirm entries, that cancel leaves the marker deleted and the `cancel` control node with `reason:"cancelled"` at the last node, and that cancelling one session's turn leaves another session's turn running. The harness `enqueue` calls the public `queue.enqueue` method; `draftQueueUser(value: string): QueueEntryInput` stays in the harness exports for that setup.

- [ ] **Step 5: Run the red steer/cancel tests.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-turn.test.ts`

Expected: FAIL until steer and cancel are implemented.

- [ ] **Step 6: Implement steer, list, and cancel.**

`turn.cancel`/`turn.list` take no session lock. Validate `turnId` as a non-empty string. `turn.cancel` calls `concurrency.cancelTurn` only when the runtime phase is `"running"`; for `"cleanup"`/`"cleanup_failed"`, unknown, or already-unregistered turns it returns `{cancelled:false}` without invoking the abort handle again. `turn.list` returns `concurrency.activeTurns()` as the real lifecycle snapshot: a turn is listed while `running`, `cleanup`, or `cleanup_failed`, and disappears only after successful marker deletion/unregistration. Never remove a turn from `turn.list` merely because `turn.ended` was published.

- [ ] **Step 7: Write the failing temporary-marker and cleanup-failure tests.**

```ts
test("writes the temporary marker after the first create and fails the turn before any request", async () => {
  const failing = await createGatewayHarness({ markerStore: failingMarkerStore() });
  const created = await failing.gateway.handle({
    id: "1",
    method: "session.create",
    params: { workspace: "/workspace", provider: "p", model: "m" },
  });
  const meta = created.result as SessionMeta;
  await failing.enqueue(meta.id, [draftQueueUser("hello")]);
  const started = await failing.gateway.handle({
    id: "2",
    method: "turn.start",
    params: { sessionId: meta.id },
  });
  const turnId = (started.result as TurnStartResult).turnId;
  const ended = await failing.waitForTurnEnd(turnId);
  expect(ended.data).toMatchObject({ reason: "failed", error: { code: "storage.io" } });
  expect(failing.executed).toEqual([]);
  expect(await failing.markers.read(meta.id)).toBeUndefined();
});
```

Use `markerStore: failingMarkerStore()` to wrap the real marker store and reject `write` once; define `failingMarkerStore` and `failingRemoveMarkerStore` as local test wrappers around the real store. Also assert the successful temporary path: the marker is written with `startOffset: 0` and no `startNodeId` after the first `create`, is visible inside the fake `execute`, and is deleted when the turn ends.

For the write-failure path, assert explicitly that the first `create` commit is not rolled back: `store.list()` contains the session, the committed assistant/user nodes remain, the confirmed queue entries were consumed (the next `session.read` shows no stale queue), no marker exists, and `executed` is empty. The observable error is `turn.ended` with `reason:"failed"` and `error.code="storage.io"`. Document that a process crash in the window after the commit and before the marker write is not recoverable; this plan only guarantees the write failure is observable and does not trigger a provider request.

Add a second lifecycle-race test using a marker store whose `remove` blocks on a test-controlled gate. Start a persisted turn, wait for `turn.ended` (phase `"cleanup"`), and before releasing `remove`: assert `turn.list` still contains the turn, a new `turn.start` returns `turn.active` instead of `steer`/`new`, `turn.cancel` returns `{cancelled:false}`, and the first marker is still the one on disk. Release the gate, wait for cleanup to finish, assert `turn.list` is `[]` and the marker is gone; only then may a new turn start. This proves the old cleanup cannot delete a new turn's marker.

Add a cleanup-failure test: use a marker store whose `remove` fails the first two times, seed a persisted session, and let the turn complete. Wait for both `turn.ended` and the subsequent `turn.cleanup_failed` event (the cleanup happens after the driver ends; use `h.waitForEvent("turn.cleanup_failed")`). Assert `turn.ended.reason` is `"completed"`, the `turn.cleanup_failed` event has `{turnId, code:"storage.io"}` and safe data, the branch ends with a `cancel` payload `{turnId, reason:"cleanup_failed"}`, and the marker still exists. Then, before any recovery, assert the lifecycle is still blocked: `turn.list` contains the same `turnId`, a new `turn.start` returns `turn.active` (not `steer`/`new`) and does not confirm queue entries or write a second marker, and `turn.cancel` returns `{cancelled:false}` without aborting anything. Then run `recoverActiveTurns` with the same store: it must delete the marker with no new synthetic/cancel nodes. This in-process recovery only proves marker deletion; the existing Gateway still has the `cleanup_failed` runtime registered, so a real new turn requires a process restart/bootstrap that rebuilds the runtime. Also assert the cleanup event data contains no cause, headers, body, or credential strings.

- [ ] **Step 8: Run the red temporary-marker and cleanup tests.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-turn.test.ts`

Expected: FAIL because the marker decorator or failure path is missing.

- [ ] **Step 9: Implement the temporary marker path, cleanup-failure handling, and export the daemon API.**

Set `runtime.pendingMarker` before starting the driver; the `Sessions.create` decorator writes the marker and flips `persisted`. Implement the `launch` cleanup failure sequence from Step 3, including the safe `turn.cleanup_failed` event, same-`turnId` `cleanup_failed` cancel, one removal retry, `phase` transitions, and `unregisterTurn` only after marker deletion. On final failure keep the turn registered in `cleanup_failed` and leave the marker. Export from `packages/daemon/src/index.ts`: `createGateway`, `Gateway`, `GatewayDeps`, `bootstrapGateway`, `BootstrapResult`, gateway protocol types (including `QueueEnqueueParams`/`QueueEnqueueResult`), `createActiveTurnStore`, `ActiveTurnStore`, `ActiveTurnMarker`, `recoverActiveTurns`, `RecoveryDeps`. Do not export any test-only internals.

- [ ] **Step 10: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/gateway/gateway.ts packages/daemon/src/index.ts \
  packages/daemon/test/gateway-turn.test.ts packages/daemon/test/support/gateway-harness.ts
git commit -m "feat(daemon): run gateway turns with active markers"
```

### Task 9: Synchronize DDS and run the whole-stage verification

**Files:**
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`
- Test: whole repository suite, typecheck, build, lint, core-boundary scan

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: DDS text matching the added `SessionStore` accessors, public `queue.enqueue`, extension rejection, bootstrap order, the temp-marker write path, recovery dedupe, and marker-cleanup failure handling.

- [ ] **Step 1: Add the documentation regression checks.**

Run:

```bash
rg -n "readTreeSince|commitOffset|getMeta" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
rg -n "Active turn marker could not be written" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
rg -n "queue.enqueue|cleanup_failed|Extension inventory" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
```

Expected before the edit: the first two exit 1 with no matches; the third may match existing `queue.enqueue` text, so use it only to locate the section to update.

- [ ] **Step 2: Update DDS §5.4.**

Document `getMeta`, `commitOffset`, and `readTreeSince` as `SessionStore` service-internal read accessors (not part of `SessionRepository`), their byte-offset semantics, and that `active-turn.json` remains outside `SessionStore`.

- [ ] **Step 3: Update DDS §3.5, §5.3, and §6.5.**

Document the implemented `queue.enqueue` route: params/result, session lock, core size/error codes, `queue.updated`, and that declarations are rejected while no inventory/definition source exists. Document that non-empty explicit/default `extensions` are rejected atomically before `session.create` creates a runtime.

Document the implemented recovery order: synthetic `interrupted` results are appended in call order after the recovered endpoint, the `cancel` node is chained after them, and the marker is deleted only after the append commits. `cancel.at` is the real committed endpoint before recovery (`endpointId`), not a synthetic node id generated inside the batch. A same-`turnId` cancel outside the `startOffset` window or on a non-selected sibling branch is ignored and must not delete the marker. A committed append that throws `storage.io` keeps the marker; recovery dedupes by the same-`turnId` cancel on the walked path and does not append synthetic/cancel nodes again. Document the temporary-session marker rule: written from the first `Sessions.create` completion; a write failure fails the turn with `storage.io` before any provider request, leaves the committed nodes and consumed queue in place, and leaves no marker; the commit-to-marker crash window is not recoverable.

Document marker-removal failure and the turn lifecycle `running -> cleanup -> (unregistered | cleanup_failed)`: `turn.ended` only moves the runtime to `cleanup` and does not unregister; `turn.list` lists the turn until marker deletion/unregistration; `turn.start` returns `turn.active` during cleanup/cleanup_failed instead of steering; `turn.cancel` returns `{cancelled:false}` during cleanup. `turn.cleanup_failed` is published with safe data; a same-`turnId` `cancel` with `reason:"cleanup_failed"` is appended when absent; removal is retried once; a remaining marker plus registered `cleanup_failed` turn blocks new turns until restart/recovery, which deletes the marker by same-`turnId` dedupe rather than a spurious `daemon_restart` cancel. Document `bootstrapGateway` as the initialize-then-recover-then-construct integration point; do not claim daemon start/stop/listen implementation.

- [ ] **Step 4: Inspect the diff for scope and secrets.**

Run: `git diff --stat <base> --` where `<base>` is the actual `HEAD` recorded at the start of plan B (not a merge commit), and `git diff <base> -- packages/daemon/src packages/daemon/test`.

Confirm there is no Transport, framing, `session.subscribe`, event push, Extensions loader, credential store, template/client method, CLI, network test, recorded key, or generated `dist` change.

- [ ] **Step 5: Run the full Verification Block and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. As an additional boundary check, run `rg -n 'from "@pisces/(daemon|core)"' packages/protocol/src` and require exit 1 with no matches. Then stage only the DDS and commit:

```bash
git add 'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
git commit -m "docs: align gateway runtime contracts"
```

## Plan Self-Review

- **Spec coverage:** `provider.list` projection and safe errors → Task 4; `bootstrapGateway` initialize/recover-before-serve → Task 4; `session.create` defaults/validation/extension rejection/queue materialization → Task 5; public `queue.enqueue` validation, limits, errors, lock, events → Task 5; `session.read` tree/branch/pagination/`seq`/selection → Task 6; `session.configure` meta/instruction/`turn.active` → Task 7; `turn.start/steer/list/cancel`, markers, lifecycle phases, temp-marker failure, cleanup failure/blocking → Task 8; marker file contract → Task 2; §6.5 offset-window scoped same-`turnId` dedupe, `cancel.at=endpointId`, synthetic interrupted results, committed-but-threw append, marker retention → Tasks 1–3; `SessionStore` accessors → Task 1; DDS consistency → Task 9.
- **Deliberate exclusions, stated once:** `Transport`/framing/`protocol.hello`, `session.subscribe`/`unsubscribe` and per-connection event push, `session.list`, `queue.edit/remove/clear`, `entries.snapshot`, templates, clients, `Extensions`/inventory/definitions, a concrete `CredentialStore`, CLI, daemon startup/stop wiring, and engine-level shutdown belong to later stages. Events are published to the injected `EventBus` only.
- **Step scan:** each step names one file set, one command with an expected result, or one exact interface; no step says "handle edge cases".
- **Type consistency:** `ActiveTurn` comes from plan A; `SessionReadResult`, `QueueEnqueueParams`, `QueueEnqueueResult`, `TurnStartResult`, `ProviderInfo`, `ModelInfo`, `SessionDefaults`, `ActiveTurnMarker`, `ActiveTurnStore`, and `BootstrapResult` keep one spelling from the interface block through the task steps. `GatewayInternals`/`createGatewayWithInternals` no longer exist.
- **Review Focus mapping:** cross-session parallelism and steer → Task 8; cancel registration and marker ownership → Task 8; marker lifecycle phases (`running`/`cleanup`/`cleanup_failed`), new-turn blocking, temp-write failure, and cleanup failure → Task 8; offset-window scoped same-`turnId` idempotency and `cancel.at=endpointId` → Tasks 1–3; read/configure atomicity and pagination → Tasks 6–7; provider projection and `ready=false` → Task 4; queue.enqueue → Task 5; extension rejection → Task 5; safe errors/bootstrap → Task 4.

## Approvals Needed

1. **Protocol seam stays daemon-local.** `packages/protocol` remains `PROTOCOL_VERSION` only, and `gateway/protocol.ts` defines the request/response and parameter/result types for this stage. Approve this duplication until the `Transport`/client phase moves them into `@pisces/protocol`, or require the envelope types there now.
2. **Method subset, public queue, and no test seam.** Only `provider.list`, `session.create/read/configure`, `queue.enqueue`, and `turn.start/cancel/list` are routed; `queue.edit/remove/clear`, `entries.snapshot`, `session.list`, subscribe/unsubscribe, templates, clients, and per-connection event push stay unimplemented. Tests use the public `Gateway.handle` for queue setup and a harness event subscription for observation. Approve dropping `createGatewayWithInternals`/`GatewayInternals` entirely.
3. **Minimal injection contract and extension boundary.** Approve `GatewayDeps` as the executable seam: `store`, `providers`, `providerHost`, `concurrency`, `events`, `markers`, frozen `SessionDefaults`, `createTools`, `entries`/`skills`/`sources` facades, `validateWorkspace`, and id/now generators. With no Extensions loader/inventory, non-empty effective extensions and client declarations are rejected atomically with `queue.invalid_control`; empty lists are accepted. `templateId` is rejected with `protocol.invalid_request`. Approve this stricter boundary over shape-only acceptance.
4. **SessionStore additions and marker ownership.** Approve `getMeta`/`commitOffset`/`readTreeSince` as service-internal read accessors, and owning `active-turn.json` in `gateway/active-turn.ts` rather than `SessionStore`.
5. **Temporary marker failure semantics.** A write failure throws `storage.io` through `Context`'s commit path after the first `create` committed: nodes and confirmed queue consumption are not rolled back, the provider is never called, the turn ends `failed`, and no marker exists. Approve this over preserving the queue. The crash window between commit and marker write is explicitly unrecoverable.
6. **Recovery cancel placement and idempotency.** Synthetic results are chained after the recovered endpoint and `cancel.at` is the real committed endpoint `endpointId` before recovery, not the generated synthetic id; this matches HLD `CancelPayload.at = 中止发生时最后已写节点` and keeps one atomic `Sessions.append` batch. Dedupe is scoped to a same-`turnId` cancel on the walked path inside the `startOffset` window; a cancel outside the window or on a non-selected sibling branch must not delete the marker. A committed append that throws `storage.io` leaves the marker; the next recovery finds the walked-path cancel and deletes the marker without appending again. Approve, or require a two-phase idempotent scheme that can persist a forward reference to the synthetic id.
7. **Marker removal is not best effort and cleanup blocks new turns.** `turn.ended` only moves the runtime to `cleanup`; it does not unregister. Until marker deletion succeeds or a `cleanup_failed` turn is left for restart recovery, `turn.list` still lists the turn, `turn.start` returns `turn.active` (never `steer`/`new`), and `turn.cancel` returns `{cancelled:false}`. If deletion fails, publish a safe `turn.cleanup_failed` event, append a same-`turnId` `cleanup_failed` cancel when absent, retry removal once, and leave the marker plus registered `cleanup_failed` turn on final failure. Recovery dedupes by `turnId` so it does not append a spurious `daemon_restart` cancel. Approve this lifecycle and blocking behavior.
8. **Safe outward errors.** `Gateway.handle` maps `PiscesError` to `{code,message}` only and every other exception to `{code:"internal.error", message:"Internal error"}`; it never rethrows or includes `data`, `cause`, headers, body, or credentials. Approve dropping `data` from outward errors in this stage.
9. **Runtime type locations.** `ActiveTurn` stays in plan A's daemon runtime module; `ProviderInfo`/`ModelInfo`/`SessionDefaults`/`BootstrapResult` stay in `gateway/protocol.ts`/`gateway/bootstrap.ts`. Approve the later move into the protocol package.

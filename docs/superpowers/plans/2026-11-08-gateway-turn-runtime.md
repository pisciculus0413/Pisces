# Gateway and Turn Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the daemon `Gateway` that routes `provider.list`, `session.create/read/configure`, and `turn.start/cancel/list` onto the existing core `Context`, `Sessions`, `ProviderManagement`, `ProviderHost`, and `AgentLoopDriver`, with `active-turn.json` write/cleanup and daemon-restart recovery that synthesizes interrupted tool results.

**Architecture:** `Gateway` keeps one `SessionRuntime` per session (`meta`, shared `Context`, shared `SessionEventClock`, marker-aware `Sessions`, per-session `AgentLoopDriver`), serializes every session-domain method through plan A's `Concurrency`, and starts each turn asynchronously after registering its `AbortController`. Persisted sessions write `active-turn.json` before the driver starts; temporary sessions write it from a `Sessions` decorator after the first `create`, and a write failure throws `storage.io` so the turn fails before any provider request. Recovery scans only nodes at or after the marker's `startOffset`, appends synthetic `interrupted` tool results, then a `cancel` control message.

**Tech Stack:** TypeScript, Node >=22.19.0, ESM, pnpm 12.8.1, node `fs/promises`, Vitest; no new dependencies.

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §3.4, §4.2, §5.2–5.6, §6.1–6.5, §7.2, §8.1–8.4; `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §2.3–2.6, §3.4, §3.6–3.10, §4.2, §4.4, §5.2–5.4, §6.1–6.5; `docs/2 Detailed Design Specification/P0 Decision Table.md` P0-04, P0-05, P0-06, P0-11, P0-13.

**Status:** Awaiting main-agent/user review. Do not start plan B until that review approves this document.

**Dependency:** Plan A (`2026-11-08-runtime-foundations.md`) is complete on `dev-pi` at `f156100` (fresh six-item verification: 30 files/494 tests, both `tsc` builds exit 0, `biome check` clean, core-boundary `rg` exit 1 with no output). Plan B's diff baseline is `f156100`; record `git log --oneline -1` at the start of plan B and use that actual commit for Task 9 if it differs. Do not merge or push either plan. This plan imports `createConcurrency`, `createEventBus`, `createSessionEventClock`, and `ActiveTurn` from `@pisces/daemon` runtime modules.

## Global Constraints

- Work on the existing `dev-pi` branch; only `dev-*` branches; never commit to `main`, push, or merge. Plan A is already committed at `f156100`, so the diff baseline for Task 9 is `f156100` (or the actual `git log --oneline -1` at plan B start), never a future merge commit. Do not create or merge a branch for plan B.
- Only `packages/daemon` and the design document in the final task are modified. Do not change `packages/core` or `packages/protocol`; core must not import daemon, protocol, Node `fs`, or Node networking.
- `@pisces/protocol` still exports only `PROTOCOL_VERSION`. This plan does not add `Request`/`Response`/`Event` types, `Transport`, framing, `session.subscribe`/`unsubscribe`, event push, `Extensions`, a concrete `CredentialStore`, `TemplateStore`, `ClientRegistry`, or CLI. The Gateway seam is a transport-neutral `handle(request): Promise<response>`.
- Implemented protocol methods are exactly `provider.list`, `session.create`, `session.read`, `session.configure`, `queue.enqueue`, `turn.start`, `turn.cancel`, `turn.list`. `queue.edit`/`queue.remove`/`queue.clear`, `entries.snapshot`, `session.list`, templates, and clients are not implemented; they stay unrouted.
- Core `Context.assemble` and `AgentLoopDriver.run` acquire the session lock themselves. The Gateway must never hold the session lock while awaiting them, and must start `driver.run` only after the lock-holding `turn.start` block returns.
- Session-domain methods run under `Concurrency.runExclusive(sessionId, …)`; `turn.cancel`/`turn.list` never take the session lock (§5.3.2). `Concurrency.cancelTurn(turnId)` is the only cancellation entry point in this plan: the Gateway never calls `AgentLoopDriver.cancel` directly, never searches runtimes for a driver to cancel, and never calls `cancelAll` itself. `cancelAll` remains plan A's bulk API but is only reachable from a host/shutdown path that this plan does not implement.
- The `cancel` handle registered with `registerTurn` must be a total function: it only calls `AbortController.abort(reason)` inside `try/catch`, records the failure on the runtime without rethrowing, and never awaits or acquires the session lock. `{cancelled:true}` means "the registered turn was handed a cancel request", never "the turn ended". A driver that ignores the abort stays registered in phase `"running"`, stays in `turn.list`, and keeps blocking new turns until it ends naturally or restart recovery deletes the marker. The raw handle error stays on the runtime and is never copied into a protocol response, event, log, or exported type. Node reports exceptions thrown by `abort` listeners as later-tick uncaught exceptions; do not install a process-level handler and do not claim to contain them.
- Host shutdown is out of scope. If a host calls `cancelAll` and a turn remains registered past the timeout, this plan makes no claim that shutdown cancelled or awaited it: the phase stays `"running"`, `turn.list` still lists it, `turn.start` still sees an active turn, and only natural end or restart recovery resolves it. `bootstrapGateway` is not a daemon lifecycle; no start/stop/listen/signal wiring is implemented or claimed.
- `EventBus` dedupes handlers by function reference. `createGateway` subscribes exactly one handler, created as a closure inside that `createGateway` call, and routes `turn.ended` by `sessionId` to its own runtime, ignoring unknown/absent sessions without throwing. Never use a module-level or otherwise shared handler, and never subscribe one handler per session: a shared reference would be deduped into a single `Set` entry and `off()` from one gateway would detach the others. Unsubscribing one gateway must leave every other gateway's subscription intact.
- Each session has exactly one `SessionEventClock`, created with its `SessionRuntime` and shared by that runtime's `Context`, driver, and the Gateway; `next()` is only called inside that session's `runExclusive`. The Gateway keeps runtimes for the process lifetime: no eviction and no re-creation for a `sessionId` that already has a runtime. `SessionNode` carries no `seq`, and no reliable persisted `seq` source exists, so a restarted daemon rebuilds each runtime with a clock starting at `0`. This is legal under DDS §3.4.3/§5.3.3 only because events are not replayed and a reconnecting client must `session.read` first and adopt the returned `seq` as its waterline. Do not invent a persisted sequence store in this plan.
- `session.read` selects `selection` only from persisted records via `Context.selectionFor`; `queue`/`selection` are returned on the first page only and later pages must not advance the `seq` waterline.
- `session.configure` rejects the whole request with `turn.active` while a turn is running; never partially updates meta, queue, or records.
- Records keep `ToolCall.name` as `EntryName`; system messages, including repeated `source="instruction"` messages, are preserved in order by the existing core. Do not add instruction filtering in the Gateway.
- `provider.list` projects descriptors without `dialect`/`baseUrl`/`auth`/`headers`; a provider with no models is valid and always reports `ready=false`. Provider readiness never triggers OAuth refresh.
- Provider retry/timeout/safe-error behavior stays inside the existing `ProviderHost`; the Gateway never parses provider payloads or exposes credentials.
- `Gateway.handle` never exposes a raw `cause`, request/response headers, body, or credential material. A `PiscesError` maps to `{code, message}` only. Any non-`PiscesError` maps to `{code:"internal.error", message:"Internal error"}`; it is never rethrown to the caller. Future server-side logging must not copy those values into a protocol response.
- Marker removal failure is never swallowed. A turn stays registered and blocks new turns for the same session from `turn.ended` until its marker is safely deleted. A normal completed turn that cannot delete its marker publishes a safe `turn.cleanup_failed` event, appends a same-`turnId` `cancel` node with `reason:"cleanup_failed"` when no cancel exists, retries removal once, and leaves the marker plus the registered turn in `cleanup_failed` state if the retry fails. Recovery dedupes by `turnId`; see Task 8.
- A session turn lifecycle is `running -> cleanup -> (unregistered | cleanup_failed)`. `turn.list` lists the turn in all three non-unregistered states. `turn.start` steers only while `running`; during `cleanup`/`cleanup_failed` it returns `turn.active` and does not confirm or enqueue. While the turn is still registered in phase `running`, every `turn.cancel` returns `{cancelled:true}`: `Concurrency.cancelTurn` invokes the abort handle only on the first call and returns `true` for later calls without invoking it again. Once the runtime is in `cleanup`/`cleanup_failed` (which includes the window after `turn.ended` and before marker cleanup), or the turn is unknown or already unregistered, `turn.cancel` returns `{cancelled:false}` without invoking the abort handle again. No new turn may overwrite or remove another turn's marker.
- `bootstrapGateway` is the only assembly path that initializes storage, runs recovery, and then constructs the Gateway. It must resolve before any request is served. No daemon start/stop/CLI lifecycle is implemented here, and none is claimed by `Gateway`, `bootstrapGateway`, task text, or DDS updates.
- `AgentLoopDriver.run` runs fire-and-forget only after the `turn.start` `runExclusive` call has resolved and released the session lock. `launch` is invoked by `void launch(...)` after the awaited lock block, is never the `runExclusive` task, and is never awaited by `turn.start`. The driver's own `runExclusive` calls are non-reentrant, so starting `run` inside the callback fails with `TypeError("Session lock is not reentrant")`; Task 8 pins this with a probe test.
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
- `turn.cancel` must abort a turn that was registered microseconds earlier, must not affect other sessions or turns, and must never remove another turn's marker; while the turn is still registered in phase `running`, every cancel returns `{cancelled:true}` and the abort handle runs only on the first one (a repeat is idempotent and does not abort twice); a turn that is unknown, already unregistered, or in `cleanup`/`cleanup_failed` returns `{cancelled:false}` without re-invoking the handle — including the window after `turn.ended` and before marker cleanup, so any repeat-cancel-returns-false assertion must be issued after `turn.ended`; turns left registered after a host `cancelAll` timeout remain listed and blocking until natural end or restart recovery. Task 8 covers this.
- A temporary session's marker write happens after its first `create`; if that write fails the committed nodes and consumed/confirmed queue stay committed, the turn ends `failed`/`storage.io`, the provider is never called, and no marker is left. A persisted session writes its marker before the driver starts. Task 8 covers this.
- Recovery must scan only nodes at or after `startOffset`, ignore a pre-existing sibling branch, synthesize `synthetic:"interrupted"` results only for calls that have no result, append exactly one `cancel` for the marker's `turnId`, and retain the marker when append fails. Dedupe by same-`turnId` cancel is scoped to the walked path inside the offset window; a cancel outside the window or on a non-selected sibling branch must not delete the marker. `cancel.at` is the real `endpointId` before recovery, not a generated synthetic id. If the append commits but throws `storage.io`, the next recovery must find the same-`turnId` cancel and only delete the marker. Tasks 1–3 cover this.
- Marker cleanup failure must be observable and must not turn a completed turn into a later spurious `daemon_restart` cancel: publish `turn.cleanup_failed`, append a same-`turnId` `cleanup_failed` cancel when needed, retry removal, and leave the marker plus the registered turn in `cleanup_failed` state. The turn remains in `turn.list`; a new `turn.start` for that session returns `turn.active` (not `steer`) until the marker is deleted or the process restarts into recovery. Task 8 covers this.
- `queue.enqueue` is a public method that validates under the session lock, rejects declarations while no inventory exists, preserves core size/error codes, and publishes `queue.updated`; tests enqueue through `Gateway.handle`, not a test-only internals API. Task 5 covers this.
- Non-empty effective extensions must be rejected atomically before a session exists; `parseDeclaration` shape checks alone are not enough. Task 5 covers this, including defaults and explicit lists. The temporary-session commit-to-marker crash window is documented as uncovered rather than recovered: a process crash after the first `create` commits and before the marker write leaves committed nodes with no marker and no recovery, and no task may claim otherwise.
- `Gateway.handle` must never leak raw causes, headers, bodies, or credentials; `PiscesError` maps to code/message and any other exception maps to a fixed `internal.error`. Task 4 covers this.
- `turn.cancel` is the only cancellation path, takes no session lock, and is honest: a cancel request for a driver that ignores the abort returns `{cancelled:true}`, every repeated request while that turn stays registered in `running` also returns `{cancelled:true}` without a second abort, leaves the turn `running` and listed, and publishes no `turn.ended`; `turn.list` and `turn.start` remain the source of truth for whether the turn actually ended. A total handle never rethrows. Task 8 covers this, including a lock-held cancel test; the abort-ignored case must cancel only after the fake `execute` signals that it has started (an `execute`-entered promise), otherwise the cancel can land before the driver reaches the provider and the conclusion is false, and it must release its gate in a `finally` so the test cannot hang.
- The Gateway has one `EventBus` subscription per `createGateway` call; two gateways on one bus keep distinct handlers, and unsubscribing one does not silence the other. Task 4 covers handler identity and delivery with a recording bus wrapper (hand-published `turn.ended`, unknown/absent `sessionId` ignored, no throw); that test routes nowhere and has no runtime for those sessions, so it proves nothing about cleanup. The cleanup consequence — a real `turn.cancel` returning `{cancelled:false}` on the surviving gateway after the first `off()` — is Task 8.
- One `SessionEventClock` per session is shared by `Context`, driver, and Gateway, allocated only inside the session lock; runtimes are never evicted or rebuilt in-process, so `seq` never regresses within a process. After restart the clock starts at `0` because no persisted `seq` source exists; Task 6 pins the fresh-waterline behavior (`session.read` returns `seq: 0`, the first event after bootstrap carries `seq: 1`) on the Task 4 bootstrap recovery fixture, which is what makes this legal for reconnecting clients.
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
| `packages/daemon/test/support/gateway-harness.ts` | Shared real-store/concurrency/bus harness, bootstrap recovery fixture, fake provider and executor | 4 |
| `packages/daemon/test/session-store-accessors.test.ts` | Accessor behavior and error codes | 1 |
| `packages/daemon/test/active-turn.test.ts` | Marker file layout, validation, replacement, removal | 2 |
| `packages/daemon/test/recovery.test.ts` | Offset window, synthetic results, idempotency, committed-but-threw append, marker retention | 3 |
| `packages/daemon/test/gateway-provider.test.ts` | `provider.list` projection, safe dispatch errors | 4 |
| `packages/daemon/test/gateway-bootstrap.test.ts` | Initialize/recover-before-serve integration point and per-gateway `EventBus` handler identity | 4 |
| `packages/daemon/test/gateway-session-create.test.ts` | Defaults, workspace/model validation, extension rejection, queue materialization | 5 |
| `packages/daemon/test/gateway-queue.test.ts` | Public `queue.enqueue` validation, limits, events, lock behavior | 5 |
| `packages/daemon/test/gateway-session-read.test.ts` | Tree/branch reads, pagination, temp sessions, `seq`, restart waterline | 6 |
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

- There is no test-only production factory and no debug API on `Gateway`. Tests set up queue state through the public `queue.enqueue` method and observe events through the test harness's `publish` interceptor, which adds no `EventBus` subscriber.

- Defaults: ids use `crypto.randomUUID()`; `now` uses `new Date().toISOString()`; `createTools` uses `createTools()` from core; `entries` is `{ kind: () => undefined }`; `skills` is `{ selected: () => [] }`; `sources` is `{ get: () => undefined }`; `validateWorkspace` requires an absolute path, an existing directory, and `W_OK` access, returning `false` instead of throwing.
- The runtime factory creates `Sessions` with the injected `newNodeId`/`now`, one `Context` bound to the shared clock and `runExclusive` for that session, and one `AgentLoopDriver` whose `options.runExclusive` ignores its argument and uses `concurrency.runExclusive(sessionId, task)` so each session has exactly one single-turn driver.
- `createGateway` subscribes exactly once to `deps.events`, using a handler closure allocated inside that `createGateway` call (never a shared/module-level function): the daemon `EventBus` dedupes by reference, so reuse would silently drop one gateway's handler and let one `off()` detach the others. The handler synchronously moves the runtime for a `turn.ended` event to phase `"cleanup"` (idempotent, never throws, ignores unknown `sessionId`/`turnId`), and it runs while the driver still holds that session's lock, so it must not await or acquire any lock. It does not unregister; unregistration happens only after marker deletion in `launch`. Per-connection protocol event push is not implemented in this stage.
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
  bus?: EventBus;
  dataDir?: string;
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
export interface BootstrapRecoveryFixture {
  harness: GatewayHarness;
  sessionId: SessionId;
}
export function createBootstrapRecoveryFixture(
  options?: GatewayHarnessOptions,
): Promise<BootstrapRecoveryFixture>;
export function descriptor(overrides?: Partial<ProviderDescriptor>): ProviderDescriptor;
export function gatewayModel(id: string): ModelDescriptor;
export function draftUser(value: string): SessionNodeDraft;
export function draftDeclaration(toggle: EntryName[]): SessionNodeDraft;
export function draftQueueUser(value: string): QueueEntryInput;
```

- The harness uses the injected `dataDir` or a fresh temporary one, real `createSessionStore`/`createConcurrency`/`createEventBus`/`createSessionEventClock`/`createActiveTurnStore` (or the injected `bus` when provided), a real `createProviderManagement` pre-registered with descriptor `p` / model `m` under dialect `test` (unless `providers` is injected), and a fake `ProviderHost` (`ready` is true when the provider exists and has models; `execute` returns the injected iterable or yields the single string `"frame"`). The default adapter emits `{type:"content",delta:"ok"}` then `{type:"stop",reason:"stop"}` for every chunk. It constructs the gateway through `bootstrapGateway` so storage initialization and recovery happen before any request; it does not expose internals. `enqueue` calls `gateway.handle({method:"queue.enqueue",…})` and returns `ids`. `events()` returns cloned published events recorded by a `publish` interceptor that the harness wraps around the bus it gives the gateway; the harness never calls `events.subscribe` itself, so every subscription on an injected bus comes from `createGateway`. `waitForEvent` resolves from an already recorded event or the next matching one; `waitForTurnEnd` is the `turn.ended` specialization. `seed` writes a persisted session directly through `SessionStore` with deterministic ids. `descriptor`/`gatewayModel` build valid fixtures; `draftUser`/`draftDeclaration`/`draftQueueUser` build seed drafts and queue entries. `close` removes the directory it used.
- `createBootstrapRecoveryFixture` creates a temp directory, opens a real `SessionStore`, calls `initialize()`, commits one persisted session whose branch is a user node followed by an agent node with an unmatched `toolCall` (`call_1`) committed after the captured `commitOffset`, writes an `active-turn` marker `{turnId:"t-recovered", startedAt: NOW, startOffset: <that offset>, startNodeId: <user node id>}`, then returns `{ harness: await createGatewayHarness({ ...options, dataDir }), sessionId }`. Because the harness assembles through `bootstrapGateway`, the fixture does not resolve until initialization and recovery already ran, so the branch already ends with the synthetic `interrupted` result and the `daemon_restart` cancel. Tests read the recovered branch through `harness.store` and clean up with `harness.close()`.

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
- Produces: every type in `protocol.ts`, `GatewayDeps`, `Gateway`, `createGateway`, `BootstrapResult`, `bootstrapGateway`, and the harness contract above including `createBootstrapRecoveryFixture`. Only `provider.list` is routed in this task, so no Task 4 test may call `session.read`, `queue.enqueue`, or `turn.*`.

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

Add a bootstrap integration test built on `createBootstrapRecoveryFixture()` in `gateway-bootstrap.test.ts`. The fixture commits a persisted session plus an `active-turn` marker before the harness assembles through `bootstrapGateway`. Assert the recovered branch read straight from `harness.store` already ends with the synthetic `interrupted` result and the `daemon_restart` cancel, and that `harness.markers.read(sessionId)` is `undefined`: that pins initialize-then-recover-then-construct ordering without any later-task route. No daemon listen/start/stop is asserted or implemented. The fixture is the shared bootstrap recovery setup; Task 6 reuses it for the restart waterline.

Add a subscription-identity test in `gateway-bootstrap.test.ts` that needs no turn route: wrap a real `createEventBus()` in a recording `EventBus` that records every `subscribe` entry (handler reference plus its `off`) and every delivery made by `publish`, and pass it to two harnesses via `createGatewayHarness({ bus })`. Because the harness records events by intercepting `publish` and never subscribes itself, the wrapper sees exactly the two handlers created by the two `createGateway` calls; assert their references differ, then call the first recorded `off()`. Publish a hand-built `{type:"turn.ended", sessionId: <unknown id>, at: NOW, data:{turnId:"unknown", reason:"completed"}}` through the wrapper and assert exactly the surviving handler was invoked and nothing threw; repeat with `sessionId` omitted. Neither gateway has a runtime for those sessions, so the surviving handler is a no-op: this test observes handler identity and delivery only, and publishing `turn.ended` for an unknown runtime has no side effect, so it proves nothing about cleanup. The cleanup consequence — a real `turn.cancel` returning `{cancelled:false}` on the surviving gateway after the first `off()` — needs Task 8's routes and is asserted in Task 8.

Restart-waterline behavior is not asserted here: `session.read` and an event-publishing route only exist after Tasks 5–6, so the `seq: 0` then `seq: 1` assertion lives in Task 6 against this Task 4 fixture.

- [ ] **Step 2: Run the red tests.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-provider.test.ts packages/daemon/test/gateway-bootstrap.test.ts`

Expected: FAIL because the gateway, bootstrap, and harness do not exist.

- [ ] **Step 3: Implement the harness, protocol types, dispatch, provider.list, and bootstrap.**

Dispatch checks the params object, looks up the handler in a `Record<string, (params) => Promise<unknown>>`, converts the return value to `{id, result}`, maps `PiscesError` to `{id, error:{code,message}}`, and maps any non-`PiscesError` to `{id, error:{code:"internal.error", message:"Internal error"}}`. `createGateway` allocates its own handler closure and registers it with `deps.events.subscribe(...)` exactly once; the closure must be created inside `createGateway` (not hoisted to module scope) and must route by `event.sessionId`, ignoring unknown sessions. `bootstrapGateway` initializes the store, creates a recovery `Sessions`, runs `recoverActiveTurns`, then calls `createGateway`.

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
- Produces: internal `SessionRuntime` (`meta`, `persisted`, `context`, `sessions`, `driver`, `eventClock`, optional `pendingMarker`; Task 8 adds `phase` and runtime-local `cancelHandleError`), the routed `session.create`, and the routed `queue.enqueue`.

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

Also assert: an empty entry list returns `{ids: []}`; an unknown session returns `session.not_found`; malformed params return `protocol.invalid_request`; a declaration, compaction, or cancel control entry returns `queue.invalid_control` (no inventory/definition source exists); invalid agent role/content returns `queue.invalid_control`; a >256 KiB entry returns `queue.entry_too_large`; a queue over 1 MiB returns `queue.too_large`; two concurrent calls on the same session both complete, their `queue.updated` events are serialized, and their `seq` values are distinct and strictly increasing (the shared session clock is only advanced inside the session lock, never per-call outside it).

- [ ] **Step 2: Run the red tests.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-session-create.test.ts packages/daemon/test/gateway-queue.test.ts`

Expected: FAIL because `session.create` and `queue.enqueue` are not routed.

- [ ] **Step 3: Implement runtime creation, `session.create`, and `queue.enqueue`.**

Resolution order: explicit params, then frozen defaults. Validate workspace, provider/model, and effective extensions before creating anything. Resolve `extensions` as `params.extensions ?? defaults.extensions ?? []`; validate names and duplicates; if the effective list is non-empty, return `queue.invalid_control` without creating a runtime, queue, event, or marker. Build the temp `SessionMeta`, create the runtime with `persisted:false`, enqueue prompts under `runExclusive`, and delete the runtime entry if enqueue throws. The runtime's `Context` receives the shared clock, `runExclusive` bound to that session, the injected facades, and the marker-aware `Sessions`.

`queue.enqueue`: validate `{sessionId, entries}` shape, acquire `runExclusive(sessionId, …)`, load or create the runtime, call `context.initialize()`, reject every `kind="control"` entry with `queue.invalid_control` (no inventory), then delegate to `context.enqueue(entries)` and return `{ids}`. Core owns size/content/role validation and publishes `queue.updated` through `Context`; do not reimplement those limits in the Gateway. The one clock created with the runtime is the only `SessionEventClock` for that session: pass that instance to `Context` and the driver, never create a second one per method call or per turn.

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
- Consumes: Task 5 runtime and `queue.enqueue`; Task 4 `createBootstrapRecoveryFixture`; `Context.snapshot`, `Context.selectionFor`; `Sessions.readTree`/`readBranch`.
- Produces: routed `session.read` returning `SessionReadResult`, plus the restart-waterline assertion.

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

Add clock-sharing and no-eviction assertions: two consecutive `session.read` calls with no events return the same `seq`; a public `queue.enqueue` then a `session.read` returns exactly `previous seq + 1`; an event for a different session does not advance this session's `seq`. These fail if a runtime, its clock, or a per-call counter is re-created. A `turn.start` continuing the same waterline needs Task 8's route and is asserted in Task 8, not here.

Add the restart-waterline test that Task 4 deliberately left out, using the Task 4 `createBootstrapRecoveryFixture()` (`gateway-session-read.test.ts`, no new fixture code):

```ts
test("restarts the per-session waterline and makes the next event seq 1", async () => {
  const { harness, sessionId } = await createBootstrapRecoveryFixture();
  const first = await harness.gateway.handle({ id: "1", method: "session.read", params: { sessionId } });
  expect((first.result as SessionReadResult).seq).toBe(0);
  expect(harness.events()).toEqual([]);
  await harness.gateway.handle({
    id: "2",
    method: "queue.enqueue",
    params: { sessionId, entries: [draftQueueUser("after restart")] },
  });
  expect(harness.events().at(-1)).toMatchObject({ type: "queue.updated", seq: 1 });
  const second = await harness.gateway.handle({ id: "3", method: "session.read", params: { sessionId } });
  expect((second.result as SessionReadResult).seq).toBe(1);
});
```

No persisted `seq` source exists, so a restart legitimately restarts the per-session clock at `0`; the first event after bootstrap carries `seq: 1`, and a reconnecting client must `session.read` first and adopt the returned `seq`.

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
- Produces: routed turn methods, per-turn `AbortController` registration/unregistration, runtime `phase` lifecycle (`running`/`cleanup`/`cleanup_failed`), total lock-free `cancel` handle with a runtime-local `cancelHandleError` that is never rethrown or exported, persisted-session marker write, temp-session marker decorator, observable marker-cleanup failure handling, and the daemon export of gateway/bootstrap/marker/recovery/protocol types.

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

Also assert: at `execute` time the marker exists with `startOffset` equal to `commitOffset` before the turn and `startNodeId` equal to the last node (or the explicit `nodeId`); `turn.list` returns that `ActiveTurn`; after `turn.ended` and successful marker deletion `turn.list` is `[]`; during `cleanup`/`cleanup_failed` `turn.list` still contains it (covered by the cleanup test below); an explicit `nodeId` selects that branch; a temp session with `nodeId` returns `session.node_not_found`; an unknown session returns `session.not_found`; a model/provider removed from the catalogue returns `session.invalid_model` and starts nothing; the turn's events continue the same `seq` waterline returned by a preceding `session.read` (one shared clock, no reset per turn).

Add a lock-release probe test that fails if `driver.run` is started inside the `turn.start` lock callback: create the harness with an `execute` that first calls `harness.concurrency.runExclusive(sessionId, async () => undefined)`, records `"acquired"`, or on failure records `error instanceof TypeError ? "reentrant" : "error"` and rethrows, then yields a chunk. Assert the turn ends `completed` and the recorded outcome is exactly `["acquired"]`. Because the driver wraps every step in `options.runExclusive`, starting `run` inside the callback makes this probe reject with `TypeError("Session lock is not reentrant")`; asserting `acquired` pins the fire-and-forget-after-release rule from risk ① without relying on timing.

- [ ] **Step 2: Run the red persisted test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-turn.test.ts`

Expected: FAIL because turn methods are not routed.

- [ ] **Step 3: Implement the new-turn path.**

Under one `runExclusive`: check `activeTurn` and the runtime phase. If a turn is active and its phase is `"running"`, return the steer path (confirm newly enqueued entries, return the existing `turnId`, never register/write a second marker). If the phase is `"cleanup"` or `"cleanup_failed"`, throw `PiscesError("turn.active", "Previous turn is still finalizing")` before confirming/enqueuing anything. If no turn is active, validate `nodeId`; resolve provider/model/adapter/execute/contextWindow/maxOutput; compute `startNodeId` and `startOffset`; write the marker for persisted sessions; `context.confirm()`; create the total `cancel` handle below; `registerTurn(sessionId, turnId, startedAt, cancel)`, and set the runtime phase to `"running"`. If confirm or marker writing fails, remove the marker (persisted) or clear `pendingMarker` and rethrow. After the locked block returns, start `driver.run(input)` with `void launch(...)`.

Required code shape (the ordering is the contract, not an implementation detail):

```ts
const input = await concurrency.runExclusive(sessionId, async () => {
  // read activeTurn/phase, validate, write marker, confirm, registerTurn
  return runTurnInput;
});
void launch(input); // outside the callback; never the runExclusive task; never awaited
return { turnId, mode: "new" };
```

`launch` must not be passed as the `runExclusive` task, `driver.run` must not be awaited by `turn.start`, and the `turn.ended` handler must not acquire any lock. Detached work started after the lock resolves must be able to acquire it; do not rely on plan A's stale-ALS fix to make a driver started inside the callback work.

The registered cancel handle is total and lock-free:

```ts
const cancel = (): void => {
  try {
    controller.abort(new DOMException("Turn cancelled", "AbortError"));
  } catch (error) {
    runtime.cancelHandleError = error; // runtime-local only; never rethrown or exported
  }
};
```

It must not throw, must not await, must not take the session lock, and must not be replaced by a direct `driver.cancel` call. The driver forwards `input.signal` to its internal controller, so aborting this controller is sufficient.

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
  // This repeat runs only after `turn.ended` resolved, so the runtime is already in `cleanup`
  // (or the turn is unregistered once the marker is gone): both are `{cancelled:false}`.
  // A repeat issued while the turn is still `running` returns `{cancelled:true}`; the repeated-cancel test below pins that.
  expect(await h.gateway.handle({ id: "3", method: "turn.cancel", params: { turnId } })).toEqual({
    id: "3",
    result: { cancelled: false },
  });
});
```

```ts
test("cancels while the session lock is held elsewhere", async () => {
  const h = await createGatewayHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await h.gateway.handle({ id: "1", method: "turn.start", params: { sessionId: meta.id } });
  const turnId = (started.result as TurnStartResult).turnId;
  let acquired!: () => void;
  let releaseLock!: () => void;
  const gotLock = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = h.concurrency.runExclusive(meta.id, () => {
    acquired();
    return new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
  });
  await gotLock;
  const cancelled = await h.gateway.handle({ id: "2", method: "turn.cancel", params: { turnId } });
  expect(cancelled.result).toEqual({ cancelled: true });
  releaseLock();
  await held;
  expect((await h.waitForTurnEnd(turnId)).data.reason).toBe("cancelled");
});
```

```ts
test("reports a cancel request without claiming the turn ended", async () => {
  let release!: () => void;
  let enteredExecute!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredExecute = resolve;
  });
  const h = await createGatewayHarness({ execute: async function* () {
    enteredExecute(); // the provider has started and will ignore the abort signal
    await gate;
    yield "frame";
  } });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await h.gateway.handle({ id: "1", method: "turn.start", params: { sessionId: meta.id } });
  const turnId = (started.result as TurnStartResult).turnId;
  await entered;
  try {
    expect((await h.gateway.handle({ id: "2", method: "turn.cancel", params: { turnId } })).result).toEqual({
      cancelled: true,
    });
    expect(h.events().some((event) => event.type === "turn.ended")).toBe(false);
    const listed = await h.gateway.handle({ id: "3", method: "turn.list", params: {} });
    expect((listed.result as TurnListResult).turns).toEqual([
      { sessionId: meta.id, turnId, startedAt: expect.any(String) },
    ]);
    const steered = await h.gateway.handle({ id: "4", method: "turn.start", params: { sessionId: meta.id } });
    expect(steered.result).toEqual({ turnId, mode: "steer" });
  } finally {
    release();
  }
  await h.waitForTurnEnd(turnId);
});
```

The `await entered` is part of the contract, not setup noise: the cancel must be issued only after the provider's `execute` has started, otherwise the abort can land before the driver reaches the provider and the "ignored abort" conclusion would be false. The `finally` releases the gate even when an assertion throws, so the turn can never hang the test file (a failing assertion still fails the test with its original error).

```ts
test("returns true for a repeated cancel while the turn is still running", async () => {
  let release!: () => void;
  let enteredExecute!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredExecute = resolve;
  });
  const h = await createGatewayHarness({ execute: async function* () {
    enteredExecute(); // provider started; the abort is ignored until the gate opens
    await gate;
    yield "frame";
  } });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await h.gateway.handle({ id: "1", method: "turn.start", params: { sessionId: meta.id } });
  const turnId = (started.result as TurnStartResult).turnId;
  await entered;
  try {
    expect((await h.gateway.handle({ id: "2", method: "turn.cancel", params: { turnId } })).result).toEqual({
      cancelled: true,
    });
    expect((await h.gateway.handle({ id: "3", method: "turn.cancel", params: { turnId } })).result).toEqual({
      cancelled: true,
    });
    const listed = await h.gateway.handle({ id: "4", method: "turn.list", params: {} });
    expect((listed.result as TurnListResult).turns).toEqual([
      { sessionId: meta.id, turnId, startedAt: expect.any(String) },
    ]);
    expect(h.events().some((event) => event.type === "turn.ended")).toBe(false);
  } finally {
    release();
  }
  await h.waitForTurnEnd(turnId);
  expect(h.events().filter((event) => event.type === "turn.ended")).toHaveLength(1);
});
```

`await entered` plus the still-closed gate guarantee the second cancel is issued while the phase is `running` and the turn is still registered. Both calls route through `Concurrency.cancelTurn`, which returns `true` while the registration exists and invokes the abort handle only on the first call; that at-most-once handle behavior is pinned at the `Concurrency` level by plan A's `concurrency.test.ts` (two `cancelTurn` calls, one handle invocation) and is not re-observable through the Gateway, because a second `AbortController.abort()` on the same controller fires no additional `abort` event. What this Gateway test pins is the routing contract: a repeat in `running` returns `{cancelled:true}`, leaves the turn listed, publishes no `turn.ended`, and the turn still ends with exactly one `turn.ended` when it finally finishes. Contrast the earlier `cancels by turn id without taking the session lock` test's post-`turn.ended` cancel, which is `{cancelled:false}` because the phase is already `cleanup`.

Also assert steer confirms newly enqueued entries (`h.enqueue(meta.id, [draftQueueUser("steer")])` before the second `turn.start`, then inspect the `queue.updated` event or `session.read` and see `confirmedAt` set) and never writes a second marker, that `turn.start` with `nodeId` under a live turn does not confirm entries, that cancel leaves the marker deleted and the `cancel` control node with `reason:"cancelled"` at the last node, and that cancelling one session's turn leaves another session's turn running. The harness `enqueue` calls the public `queue.enqueue` method; `draftQueueUser(value: string): QueueEntryInput` stays in the harness exports for that setup.

- [ ] **Step 5: Run the red steer/cancel tests.**

Run: `node_modules/.bin/vitest run packages/daemon/test/gateway-turn.test.ts`

Expected: FAIL until steer and cancel are implemented.

- [ ] **Step 6: Implement steer, list, and cancel.**

`turn.cancel`/`turn.list` take no session lock. Validate `turnId` as a non-empty string. `turn.cancel` resolves the owning `sessionId` from the lock-free `concurrency.activeTurns()` snapshot by `turnId`, then reads the runtime for that `sessionId` from the runtime map synchronously; it never creates a runtime and never scans runtimes for a driver. If either lookup misses, return `{cancelled:false}`. It calls `concurrency.cancelTurn(turnId)` whenever the runtime phase is `"running"`, so a repeat call on a still-registered `running` turn returns `{cancelled:true}` again while `cancelTurn` invokes the abort handle only on the first call; for `"cleanup"`/`"cleanup_failed"` (including the window after `turn.ended` and before marker cleanup), unknown, or already-unregistered turns it returns `{cancelled:false}` without invoking the abort handle again. `cancelTurn` is the only entry: never call `runtime.driver.cancel`. `cancelled:true` is exactly `cancelTurn`'s registered-and-handed-off result; do not upgrade it to "ended", do not emit `turn.ended`, and do not delete the marker on cancel (deletion stays in `launch` after the driver returns). A turn whose driver ignores the abort stays `running` and listed, so the next `turn.cancel` still returns `{cancelled:true}` through `cancelTurn`'s at-most-once handle (never re-invoked) while `turn.list`/`turn.ended` remain the truth. `turn.list` returns `concurrency.activeTurns()` as the real lifecycle snapshot: a turn is listed while `running`, `cleanup`, or `cleanup_failed`, and disappears only after successful marker deletion/unregistration. Never remove a turn from `turn.list` merely because `turn.ended` was published.

The Gateway never calls `cancelAll` and never observes it. A turn left registered after a host-initiated `cancelAll` timeout stays phase `"running"`, so it remains listed and `turn.start` treats it as active (steering per §5.3.2); this plan does not promise such a turn is cancelled or that its marker is removed, and no start/stop/shutdown path is implemented or claimed. Natural driver end or restart recovery is the only resolution.

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

Use `markerStore: failingMarkerStore()` to wrap the real marker store and reject `write` once; define `failingMarkerStore`, `failingRemoveMarkerStore`, and `blockingRemoveMarkerStore` as local test wrappers around the real store. Also assert the successful temporary path: the marker is written with `startOffset: 0` and no `startNodeId` after the first `create`, is visible inside the fake `execute`, and is deleted when the turn ends.

For the write-failure path, assert explicitly that the first `create` commit is not rolled back: `store.list()` contains the session, the committed assistant/user nodes remain, the confirmed queue entries were consumed (the next `session.read` shows no stale queue), no marker exists, and `executed` is empty. The observable error is `turn.ended` with `reason:"failed"` and `error.code="storage.io"`. Document that a process crash in the window after the commit and before the marker write is not recoverable; this plan only guarantees the write failure is observable and does not trigger a provider request.

Add a second lifecycle-race test using a marker store whose `remove` blocks on a test-controlled gate. Start a persisted turn, wait for `turn.ended` (phase `"cleanup"`), and before releasing `remove`: assert `turn.list` still contains the turn, a new `turn.start` returns `turn.active` instead of `steer`/`new`, `turn.cancel` returns `{cancelled:false}` (this cancel runs after `turn.ended`, i.e. in `cleanup`; a cancel while still `running` returns `{cancelled:true}`), and the first marker is still the one on disk. Release the gate, wait for cleanup to finish, assert `turn.list` is `[]` and the marker is gone; only then may a new turn start. This proves the old cleanup cannot delete a new turn's marker.

Add the cross-gateway subscription integration test that Task 4 deferred because it needs real turn routes. Wrap a real `createEventBus()` in a recording `EventBus`, create two harnesses on it via `createGatewayHarness({ bus })` (each with its own temporary `dataDir`), and call the first recorded `off()`. On the second harness use `markerStore: blockingRemoveMarkerStore()` (a local wrapper over the real store whose `remove` waits on a test gate) and run a real turn. Wait for `turn.ended`, assert the recording forwarded that publish to the surviving handler without throwing and that the marker is still on disk, then assert `turn.cancel(turnId)` returns `{cancelled:false}`. Reference dedupe would have detached the survivor, leaving its runtime in `running`, so the same call would return `{cancelled:true}`; `{cancelled:false}` proves the surviving gateway's own handler still routed its `turn.ended` into `cleanup` after the first `off()`. Release the gate, wait for `turn.list` to become `[]`, and assert the marker is gone.

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
- Produces: DDS text matching the added `SessionStore` accessors, public `queue.enqueue`, extension rejection, bootstrap order, the temp-marker write path, recovery dedupe, marker-cleanup failure handling, the `cancelTurn`-only/total-handle cancellation contract, the per-gateway `EventBus` subscription identity, and the no-eviction/restart-`seq` clock contract.

- [ ] **Step 1: Add the documentation regression checks.**

Run:

```bash
rg -n "readTreeSince|commitOffset|getMeta" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
rg -n "Active turn marker could not be written" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
rg -n "queue.enqueue|cleanup_failed|Extension inventory" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
rg -n "cancelTurn|cancelAll|SessionEventClock|逐出|eviction|重新读取" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
```

Expected before the edit: the first two exit 1 with no matches; the third and fourth may match existing text, so use them only to locate the sections to update.

- [ ] **Step 2: Update DDS §5.4.**

Document `getMeta`, `commitOffset`, and `readTreeSince` as `SessionStore` service-internal read accessors (not part of `SessionRepository`), their byte-offset semantics, and that `active-turn.json` remains outside `SessionStore`.

- [ ] **Step 3: Update DDS §3.5, §5.3, and §6.5.**

Document the implemented `queue.enqueue` route: params/result, session lock, core size/error codes, `queue.updated`, and that declarations are rejected while no inventory/definition source exists. Document that non-empty explicit/default `extensions` are rejected atomically before `session.create` creates a runtime.

Document the implemented recovery order: synthetic `interrupted` results are appended in call order after the recovered endpoint, the `cancel` node is chained after them, and the marker is deleted only after the append commits. `cancel.at` is the real committed endpoint before recovery (`endpointId`), not a synthetic node id generated inside the batch. A same-`turnId` cancel outside the `startOffset` window or on a non-selected sibling branch is ignored and must not delete the marker. A committed append that throws `storage.io` keeps the marker; recovery dedupes by the same-`turnId` cancel on the walked path and does not append synthetic/cancel nodes again. Document the temporary-session marker rule: written from the first `Sessions.create` completion; a write failure fails the turn with `storage.io` before any provider request, leaves the committed nodes and consumed queue in place, and leaves no marker; the commit-to-marker crash window is not recoverable.

Document marker-removal failure and the turn lifecycle `running -> cleanup -> (unregistered | cleanup_failed)`: `turn.ended` only moves the runtime to `cleanup` and does not unregister; `turn.list` lists the turn until marker deletion/unregistration; `turn.start` returns `turn.active` during cleanup/cleanup_failed instead of steering; `turn.cancel` returns `{cancelled:true}` on every call while the turn is still registered in phase `running` (the abort handle runs only on the first call, so the repeat is idempotent) and `{cancelled:false}` once the runtime is in `cleanup`/`cleanup_failed` — including the window after `turn.ended` and before marker cleanup — or when the turn is unknown/already unregistered, matching §3.6.3's `{cancelled:false}`-only-when-no-active-turn rule and §5.3.2's delegation to `cancelTurn`. `turn.cleanup_failed` is published with safe data; a same-`turnId` `cancel` with `reason:"cleanup_failed"` is appended when absent; removal is retried once; a remaining marker plus registered `cleanup_failed` turn blocks new turns until restart/recovery, which deletes the marker by same-`turnId` dedupe rather than a spurious `daemon_restart` cancel. Document `bootstrapGateway` as the initialize-then-recover-then-construct integration point; do not claim daemon start/stop/listen implementation.

Document the cancellation and clock contracts in §5.2/§5.3: `Concurrency.cancelTurn(turnId)` is the only cancellation entry, the Gateway never calls `AgentLoopDriver.cancel` or `cancelAll` itself, the registered handle is total and lock-free, and `{cancelled:true}` means the request was handed to the registered turn, not that it ended (a driver that ignores the abort stays listed). Document that a host-initiated `cancelAll` timeout leaves turns registered and that this stage implements no start/stop/shutdown path or residual-turn recovery beyond restart recovery. Document the `EventBus` subscription contract: one handler closure per `Gateway` instance, routed by `sessionId`, because the bus dedupes by function reference and does not support multiple identities for one function. Document `SessionRuntime` lifetime: one `SessionEventClock` per session shared by Context/driver/Gateway and advanced only inside the session lock; runtimes are not evicted or rebuilt in-process, so `seq` never regresses while the process runs; after restart the clock starts at `0` because no `seq` is persisted in `SessionNode`, which is legal only because events are not replayed and a reconnecting client re-reads and adopts the returned `seq`.

Also reconcile the existing §5.3.2 `turn.start` summary sentence so its lock-callback enumeration names the persisted-session marker write (plan A final-review minor, deferred to this doc pass), without changing the stated ordering: driver start after lock release.

- [ ] **Step 4: Inspect the diff for scope and secrets.**

Run: `git diff --stat f156100 --` (use the actual `HEAD` recorded at the start of plan B if it differs) and `git diff f156100 -- packages/daemon/src packages/daemon/test`. Plan A is already committed at `f156100`; do not use a future merge commit or a pre-plan-A base.

Confirm there is no Transport, framing, `session.subscribe`, event push, Extensions loader, credential store, template/client method, CLI, network test, recorded key, or generated `dist` change.

- [ ] **Step 5: Run the full Verification Block and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. As an additional boundary check, run `rg -n 'from "@pisces/(daemon|core)"' packages/protocol/src` and require exit 1 with no matches. Then stage only the DDS and commit:

```bash
git add 'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
git commit -m "docs: align gateway runtime contracts"
```

## Plan Self-Review

- **Spec coverage:** `provider.list` projection and safe errors → Task 4; `bootstrapGateway` initialize/recover-before-serve and per-gateway `EventBus` subscription identity (no turn route) → Task 4; `session.create` defaults/validation/extension rejection/queue materialization → Task 5; public `queue.enqueue` validation, limits, errors, lock, events → Task 5; `session.read` tree/branch/pagination/`seq`/selection and the restart waterline (`seq:0`, first event `seq:1`, on the Task 4 bootstrap recovery fixture) → Task 6; `session.configure` meta/instruction/`turn.active` → Task 7; `turn.start/steer/list/cancel`, markers, lifecycle phases, temp-marker failure, cleanup failure/blocking → Task 8; marker file contract → Task 2; §6.5 offset-window scoped same-`turnId` dedupe, `cancel.at=endpointId`, synthetic interrupted results, committed-but-threw append, marker retention → Tasks 1–3; `SessionStore` accessors → Task 1; DDS consistency → Task 9.
- **Known-risk mapping:** ① driver start only after lock release → Global Constraints + Task 8 Step 1 probe test; ② `cancelTurn` as sole entry, total lock-free handle, honest `{cancelled:true}`, cleanup/failed and post-`cancelAll` residency, no start/stop claim → Global Constraints + Task 8 Steps 3/4/6; ③ `EventBus` reference dedupe and per-gateway closure → Global Constraints + Task 4 subscription-identity test + Task 8 cleanup-phase integration test; ④ one shared clock per session, lock-internal `next()`, no eviction, restart `seq=0` legality → Global Constraints + Tasks 5/6/8 tests (restart waterline in Task 6 on the Task 4 fixture); ⑤ extension atomic rejection and the uncovered commit-to-marker crash window → Global Constraints + Task 5 tests + Task 8 Step 7; ⑥ baseline `f156100` → Status/Dependency/Global Constraints/Task 9 Step 4.
- **Deliberate exclusions, stated once:** `Transport`/framing/`protocol.hello`, `session.subscribe`/`unsubscribe` and per-connection event push, `session.list`, `queue.edit/remove/clear`, `entries.snapshot`, templates, clients, `Extensions`/inventory/definitions, a concrete `CredentialStore`, CLI, daemon startup/stop wiring, host `cancelAll`/shutdown wiring, runtime eviction, a persisted `seq` source, and engine-level shutdown belong to later stages. Events are published to the injected `EventBus` only. The temporary-session commit-to-marker crash window remains uncovered and is not presented as recovered.
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
7. **Marker removal is not best effort and cleanup blocks new turns.** `turn.ended` only moves the runtime to `cleanup`; it does not unregister. Until marker deletion succeeds or a `cleanup_failed` turn is left for restart recovery, `turn.list` still lists the turn, `turn.start` returns `turn.active` (never `steer`/`new`), and `turn.cancel` returns `{cancelled:false}` in these `cleanup`/`cleanup_failed` phases (a repeat cancel issued while the turn is still registered in `running` returns `{cancelled:true}`). If deletion fails, publish a safe `turn.cleanup_failed` event, append a same-`turnId` `cleanup_failed` cancel when absent, retry removal once, and leave the marker plus registered `cleanup_failed` turn on final failure. Recovery dedupes by `turnId` so it does not append a spurious `daemon_restart` cancel. Approve this lifecycle and blocking behavior.
8. **Safe outward errors.** `Gateway.handle` maps `PiscesError` to `{code,message}` only and every other exception to `{code:"internal.error", message:"Internal error"}`; it never rethrows or includes `data`, `cause`, headers, body, or credentials. Approve dropping `data` from outward errors in this stage.
9. **Runtime type locations.** `ActiveTurn` stays in plan A's daemon runtime module; `ProviderInfo`/`ModelInfo`/`SessionDefaults`/`BootstrapResult` stay in `gateway/protocol.ts`/`gateway/bootstrap.ts`. Approve the later move into the protocol package.
10. **Cancellation entry and honest reporting.** `Concurrency.cancelTurn(turnId)` is the only cancel entry; the Gateway never calls `AgentLoopDriver.cancel` or `cancelAll`, and never scans runtimes for a driver. The registered handle is total and lock-free (no await, no lock, failure retained on the runtime and never rethrown or exposed). `{cancelled:true}` means "handed to the registered turn", not "ended": a driver that ignores the abort remains `running` and listed, blocks new turns, and is resolved only by natural end or restart recovery. A repeat cancel while the turn is still registered in `running` also returns `{cancelled:true}` without a second abort (idempotent), while cleanup/`cleanup_failed` turns reject cancel with `{cancelled:false}` — including the window after `turn.ended` before marker cleanup — and turns left registered after a host-initiated `cancelAll` timeout are explicitly out of scope for this stage (no start/stop/shutdown path is implemented or claimed). Approve this over inferring termination from the cancel response.
11. **One `EventBus` subscription per gateway.** `createGateway` allocates its own handler closure and routes by `sessionId`, ignoring unknown sessions. Because the bus dedupes by function reference, a shared handler or per-session subscriptions are forbidden. Approve this identity contract (plan A's `EventBus` API is unchanged).
12. **Clock lifetime and restart `seq`.** One `SessionEventClock` per `SessionRuntime`, shared by Context/driver/Gateway and advanced only inside the session lock; runtimes are never evicted or re-created in-process. `SessionNode` persists no `seq`, so a restarted daemon starts each clock at `0`. This is accepted as legal only because events are not replayed and reconnecting clients re-read and adopt the returned `seq`; no persisted sequence store is added. Approve, or require a persisted `seq` source (which this plan will not fake).

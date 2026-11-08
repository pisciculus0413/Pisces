# AgentLoopDriver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the core `AgentLoopDriver`: drive one turn across model steps, persist assistant/tool/cancel nodes with continuous parent pointers, stream text deltas, invoke tools concurrently, and finish correctly on completion, cancellation, provider failure, or storage failure.

**Architecture:** The driver owns only turn orchestration. It calls the existing `Context` for assembly/persistence boundaries, the existing `Sessions` for assistant/tool/cancel appends, the existing `Tools` for invocation, and injected `LlmAdapter`, `ExecuteProvider`, and `EventBus` ports for supplier I/O and events. Tests use the real memory repository, `Sessions`, `Context`, and `Tools`, while faking the three external boundaries.

**Tech Stack:** TypeScript, Node >=22.19.0, ESM, pnpm 12.8.1, Vitest; no new dependencies.

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §2, §3.1, §3.4, §4.1, §4.3–4.4, §5.1–5.3, §6.2–6.5, §7.1, §8.2–8.5; `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §2, §3.1, §3.6, §3.8–3.10, §4.2–4.5, §5.2, §6.3–6.5, §8; `docs/2 Detailed Design Specification/P0 Decision Table.md` P0-01, P0-11–13.

## Global Constraints

- The plan baseline is commit `b6dfb9d` on `dev-codex`; the worktree was clean except for this plan.
- Work on `dev-codex`; never commit to `main`, push, or merge.
- The milestone is core-only. Do not implement or modify `ProviderHost`, daemon turn registration/recovery, `Gateway`, protocol methods, extensions, credentials, HTTP, filesystem I/O, or real supplier code.
- Core must not import daemon, protocol, Node filesystem, or network modules.
- Use the current `Context`, `Sessions`, and `Tools` contracts; do not duplicate their queue, selection, budget, wrapper, or persistence logic.
- `LlmAdapter`, `ExecuteProvider`, and `EventBus` must be injectable. No test makes a real network request.
- `ToolCall.name` entering the driver is always `EntryName`; wire-name encoding and decoding belong to the adapter boundary.
- A turn has at most one active `run` per driver instance. A driver instance is session-local and may be reused for serial turns.
- Every session event gets a strictly increasing sequence from the shared `SessionEventClock` only while the session lock is held.
- `session.updated` event frames are at most `4194304 - 1` UTF-8 bytes for the core envelope, split only at whole-node boundaries. A single node is never split.
- Provider text/reasoning is text-safely clipped toward a 262144-byte whole-content target with the exact suffix `\n[truncated]`; `toolCall.arguments` is never truncated, so untruncatable fields may leave content above 262144 bytes until event preflight.
- An oversized indivisible node event fails with `provider.invalid_response` before appending anything.
- Assistant nodes use `kind="agent"`, `role="assistant"`, `source="assistant"`. Tool-result nodes use `kind="agent"`, `role="tool"`, `source="tool"`. Cancel nodes use `kind="control"`, `role="cancel"`, `source="driver"`.
- Normal cancellation never invents tool results. Synthetic `"interrupted"` results are a pure core helper for later daemon recovery; automatic recovery itself remains out of scope.
- Store, provider, context, and tool failures use existing `PiscesError` codes; Task 1 documents the new `event.publish_failed` event-category code for synchronous EventBus handler failures. Tool failures returned as `ToolResult` remain results and do not end the turn.
- Do not add protocol event mapping, a concrete EventBus implementation, Gateway routing, `Concurrency`, or service-level tool concurrency limits in this milestone. The public `EventBus` contract still includes `subscribe`.
- Before each commit run `git status --short`; stage only files created or modified by that task.

## Review Focus

- Cancellation after partial text or after tool calls were parsed must persist only observed content, clear all unassembled confirmations, and never issue another supplier request. Task 5 covers both stream and tool cancellation.
- Two tool calls that settle in reverse order must append two results, each mapped to the original `ToolCall.id`, in original call order, with a continuous parent chain. Task 3 covers this.
- A provider delta may exceed one event but a persisted assistant node may not exceed its content/event limits; truncation and preflight must happen before append, with no partial storage. Task 4 covers both boundaries.
- A confirmed steer arriving after a no-tool step must be assembled at the next step; an unconfirmed queue entry must not trigger another model request. Task 5 covers both cases.
- Failure while appending assistant/tool/cancel nodes or while synchronously publishing a driver event must stop the turn, retain already committed state and the advanced head, and never continue to another model step. Task 6 covers each boundary.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/messages.ts` | Add shared `WireToolCall`, `Usage`, and `StopReason` contracts | 1 |
| `packages/core/src/events.ts` | Engine event payloads, `EventBus`, session-update framing/preflight, turn/delta publisher | 1 |
| `packages/core/src/context/events.ts` | Reuse shared session-update framing without changing existing event behavior | 1 |
| `packages/core/src/loop/types.ts` | Adapter, executor, driver input/result, and factory contracts | 1–2 |
| `packages/core/src/loop/interrupted.ts` | Exact synthetic interrupted result helper for later recovery | 1 |
| `packages/core/src/loop/content.ts` | Provider/tool output text clipping while preserving untruncatable fields | 4 |
| `packages/core/src/loop/driver.ts` | State machine, turn loop, parsing, persistence, cancellation, failure handling | 2–6 |
| `packages/core/src/index.ts` | Export only the public loop/event contracts and factory | 1–2 |
| `packages/core/test/loop-events.test.ts` | Event envelopes, budgets, delta splitting, synthetic result | 1 |
| `packages/core/test/support/loop-harness.ts` | Real Context/Sessions/Tools harness with fake adapter/executor/bus | 2 |
| `packages/core/test/loop-text.test.ts` | One-step text/usage/lifecycle behavior | 2 |
| `packages/core/test/loop-tools.test.ts` | Multi-step tool loop, concurrent settlement, parent/head order | 3 |
| `packages/core/test/loop-budgets.test.ts` | Content truncation, delta framing, event preflight | 4 |
| `packages/core/test/loop-control.test.ts` | Cancel, steer, duplicate-run, state/idempotence | 5 |
| `packages/core/test/loop-failures.test.ts` | Context/provider/adapter/storage failure semantics | 6 |

## Fixed Interface Decisions

```ts
// packages/core/src/messages.ts
export interface WireToolCall {
  id: string;
  name: string;
  arguments: JsonValue;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export type StopReason =
  | "stop"
  | "toolCall"
  | "length"
  | "contentFilter"
  | "cancelled"
  | "error";
```

```ts
// packages/core/src/events.ts
export interface EngineEvent {
  type: string;
  sessionId?: SessionId;
  seq?: number;
  at: string;
  data: JsonValue;
}

export interface EventBus {
  publish(event: EngineEvent): void;
  subscribe(handler: (event: EngineEvent) => void): () => void;
}

export type TypedEngineEvent<
  TType extends string,
  TData extends JsonValue,
> = Omit<EngineEvent, "type" | "sessionId" | "seq" | "data"> & {
  type: TType;
  sessionId: SessionId;
  seq: number;
  data: TData;
};

export type SessionUpdatedEvent = TypedEngineEvent<
  "session.updated",
  { nodes: SessionNode[]; meta?: SessionMeta }
>;

export type TurnStartedEvent = TypedEngineEvent<
  "turn.started",
  { turnId: TurnId; startedAt: string }
>;

export type TurnDeltaEvent = TypedEngineEvent<
  "turn.delta",
  {
    turnId: TurnId;
    step: number;
    kind: "text" | "reasoning";
    delta: string;
  }
>;

export type TurnStepEvent = TypedEngineEvent<
  "turn.step",
  {
    turnId: TurnId;
    step: number;
    stopReason: StopReason;
    usage?: Usage;
  }
>;

export type TurnEndedEvent = TypedEngineEvent<
  "turn.ended",
  {
    turnId: TurnId;
    reason: "completed" | "cancelled" | "failed";
    endedAt: string;
    error?: { code: string; message: string };
  }
>;

export type TurnEvent =
  | TurnStartedEvent
  | TurnDeltaEvent
  | TurnStepEvent
  | TurnEndedEvent;
```

`ContextEvent` remains the existing public Context event type. Both `ContextEvent` and every concrete turn event are assignable to the broad DDS `EngineEvent`; the driver publishes through `EventBus.publish(EngineEvent)`, while `TurnEvent` supplies compile-time payload typing. `sessionId` and `seq` are optional only on the public envelope because connection-level events use that shape; every turn/session event requires both.

EventBus publication is synchronous. `publish` invokes subscribers in publication order before returning; handlers only enqueue delivery work and must not return promises that the driver awaits. If a handler throws, `publish` may propagate that throw. `createEventPublisher` catches it and throws `PiscesError("event.publish_failed", ..., {cause})`. This matches Context’s existing behavior: committed state is not rolled back and publication is not retried.

Context uses its publish-only `ContextEvents` port. Task 1 normalizes any synchronous handler exception at that adapter to `event.publish_failed` after Context completes its committed-state transition. The driver’s own `EventPublisher` uses the same normalization, so Context and driver callers observe the same code. Task 1 records this mapping in DDS §5.3.

The driver applies one consistent terminal rule:

- A pre-append publication failure stops the turn before provider/tool work or before the corresponding append.
- A post-append publication failure retains the appended nodes and the advanced local `headId`, skips all further model/tool steps, and returns `failed` with `event.publish_failed`.
- The driver attempts `turn.ended` once. If that publication also fails, it returns the same failed result without throwing or attempting recursive termination.
- A publication failure overrides an otherwise completed/cancelled result; no event is replayed on reconnect.

```ts
// packages/core/src/loop/types.ts
export interface WireRequest {
  path: string;
  body: string;
  headers?: Record<string, string>;
}

export type LlmEvent =
  | { type: "content"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: StopReason }
  | { type: "error"; code: string; message: string; retryable?: boolean };

export interface LlmAdapter {
  readonly dialect: string;
  buildRequest(request: LlmRequest): WireRequest;
  parseChunk(chunk: string): LlmEvent[];
}

export type ExecuteProvider = (
  request: WireRequest,
  signal?: AbortSignal,
) => AsyncIterable<string>;

export interface RunTurnInput {
  sessionId: SessionId;
  turnId: TurnId;
  meta: SessionMeta;
  context: Context;
  sessions: Sessions;
  tools: Tools;
  adapter: LlmAdapter;
  execute: ExecuteProvider;
  events: EventBus;
  eventClock: SessionEventClock;
  contextWindow: number;
  maxOutput: number;
  nodeId?: NodeId;
  signal: AbortSignal;
}

export type TurnReason = "completed" | "cancelled" | "failed";

export interface TurnResult {
  sessionId: SessionId;
  turnId: TurnId;
  reason: TurnReason;
  error?: { code: string; message: string };
}

export interface AgentLoopDriver {
  run(input: RunTurnInput): Promise<TurnResult>;
  cancel(turnId: TurnId): Promise<boolean>;
}

export interface AgentLoopDriverOptions {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  /** RFC3339 UTC timestamp with milliseconds, exactly 24 ASCII bytes. */
  now(): string;
}

export type AgentLoopDriverFactory = (
  options: AgentLoopDriverOptions,
) => AgentLoopDriver;
```

DDS §4.4.1 omits `runExclusive` and `now` even though §4.4.4/§5.2 require lock-protected sequence allocation and §8.5 requires an injected clock. They are factory dependencies because they belong to the session-local runtime, not each turn input.

The shared event publisher has this exact internal/public surface:

```ts
export interface EventPublisher {
  publishTurn<K extends TurnEvent["type"]>(
    type: K,
    data: Extract<TurnEvent, { type: K }>["data"],
  ): void;
  publishDelta(
    turnId: TurnId,
    step: number,
    kind: "text" | "reasoning",
    delta: string,
  ): void;
  publishSession(nodes: SessionNode[], meta?: SessionMeta): void;
  validateSessionNodes(nodes: readonly SessionNode[], meta?: SessionMeta): void;
}

export function createEventPublisher(deps: {
  sessionId: SessionId;
  events: EventBus;
  eventClock: SessionEventClock;
  now(): string;
}): EventPublisher;
```

`publishTurn`, `publishDelta`, `publishSession`, and `validateSessionNodes` must be called from the session lock. `publishDelta` splits at Unicode code-point boundaries and allocates a new sequence for every frame. The driver opens a session-lock critical section for each parser delta publication. A final `LlmEvent.usage` observed in a step replaces earlier usage for that step; `turn.step.usage` is omitted when no usage event was observed. A step requires at least one completed `stop` event; the last stop replaces an earlier one, and no stop after the stream ends is `provider.invalid_response`.

Provider-output consistency rules are also fixed in this milestone:

- Duplicate non-empty `ToolCall.id` values within one parsed assistant response are `provider.invalid_response`; no assistant/tool node is appended and no tool executes.
- `stop.reason="toolCall"` with zero parsed calls is `provider.invalid_response`.
- `stop.reason="error"` without a preceding parser error event, or `stop.reason="cancelled"` without driver cancellation, is `provider.invalid_response`.
- Parsed calls with `stop.reason="stop"`, `"length"`, or `"contentFilter"` are accepted and executed because §4.4.3 makes parsed-call presence authoritative; `turn.step` preserves the supplied stop reason.

---

### Task 1: Event, adapter, and synthetic-result contracts

**Files:**
- Create: `packages/core/src/events.ts`
- Create: `packages/core/src/loop/types.ts`
- Create: `packages/core/src/loop/interrupted.ts`
- Modify: `packages/core/src/messages.ts`
- Modify: `packages/core/src/context/events.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/context-commit.test.ts`
- Modify: `packages/core/test/context.test.ts`
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`
- Test: `packages/core/test/loop-events.test.ts`

**Interfaces:**
- Consumes: `ContextEvent`, `SessionEventClock`, `SessionNode`, `SessionMeta`, `SessionId`, `TurnId`, `StopReason`, `Usage`, `ContentBlock`, `PiscesError`.
- Produces: `WireToolCall`, `Usage`, `StopReason`; the engine event types; `EventBus`; `EventPublisher`; `createEventPublisher`; all loop contracts in “Fixed Interface Decisions”; `INTERRUPTED_TOOL_RESULT_TEXT`; `createInterruptedToolResult(toolCallId: string)`.
- Documents: DDS §3.9 event-category error `event.publish_failed`; DDS §5.3 consistent Context/driver notification mapping; HLD §8.4 event-category error semantics.
- `createInterruptedToolResult` returns exactly:

```ts
{
  type: "toolResult",
  toolCallId,
  content: [{ type: "text", text: "结果未知，可能已部分生效，请核验" }],
  synthetic: "interrupted",
}
```

- [ ] **Step 1: Write failing event and synthetic-result tests.**

Create `loop-events.test.ts` using a fake `EventBus` and deterministic clock:

```ts
const handlers = new Set<(event: EngineEvent) => void>();
const publish = vi.fn((event: EngineEvent) => {
  for (const handler of handlers) handler(event);
});
const bus: EventBus = {
  publish,
  subscribe(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};
let seq = 0;
const publisher = createEventPublisher({
  sessionId: "s1" as SessionId,
  events: bus,
  eventClock: { current: () => seq, next: () => ++seq },
  now: () => "2026-11-08T00:00:00.000Z",
});

publisher.publishTurn("turn.started", {
  turnId: "t1" as TurnId,
  startedAt: "2026-11-08T00:00:00.000Z",
});

expect(publish).toHaveBeenCalledWith({
  type: "turn.started",
  sessionId: "s1",
  seq: 1,
  at: "2026-11-08T00:00:00.000Z",
  data: {
    turnId: "t1",
    startedAt: "2026-11-08T00:00:00.000Z",
  },
});
```

Add tests that:

- `subscribe` receives a synchronously published event before `publish` returns; the returned unsubscribe function removes that handler, and the public `EngineEvent` still accepts a connection-level event with omitted `sessionId`/`seq`.
- A bus handler that throws causes `EventPublisher` to throw `PiscesError("event.publish_failed", ...)` with the original error as `cause`.
- `publishDelta` splits a delta containing `🐟` and CJK text, preserves the exact concatenation, increments `seq` once per frame, and every serialized core event is <= 4194303 bytes.
- `publishSession` keeps two nodes in one frame when they fit, splits only between nodes when they do not, and never mutates input.
- `validateSessionNodes` rejects a single indivisible node whose complete core event exceeds 4194303 bytes with `context.source_failed`.
- `createInterruptedToolResult("call-1")` equals the exact object above and carries `synthetic="interrupted"`.
- `LlmEvent`/`RunTurnInput` type assertions are covered by `pnpm typecheck`; do not add tests that only restate TypeScript types.

Update the existing subscriber-failure tests in `context.test.ts` and `context-commit.test.ts`: plain `Error` and `PiscesError` thrown by `ContextEvents.publish` must both surface as `PiscesError("event.publish_failed")` with the original exception as `cause`. Keep asserting that committed nodes, queue consumption, selection, event sequence gaps, and subsequent initialization remain valid.

- [ ] **Step 2: Verify the red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-events.test.ts`

Expected: FAIL because `createEventPublisher` and the loop modules do not exist.

- [ ] **Step 3: Implement the shared contracts and event publisher.**

Add `WireToolCall`, `Usage`, and `StopReason` to `messages.ts`.

Implement `events.ts` with one byte-counting source of truth:

- Core engine-event limit is `4194304 - 1`.
- Use `new TextEncoder().encode(JSON.stringify(value)).length`.
- Preflight sequence uses `Number.MAX_SAFE_INTEGER`; timestamp uses a fixed 24-byte UTC value.
- `publishSession` emits whole-node frames and preserves event order.
- `publishDelta` accumulates only complete Unicode code points and emits one frame at a time.
- `createEventPublisher` allocates `seq` and `at` only through injected dependencies.
- Every `EventBus.publish` call is synchronous; wrap a thrown subscriber error as `event.publish_failed` with `cause` and never retry it inside the publisher.

Refactor `context/events.ts` to call the shared session-frame/preflight functions. Do not change Context’s queue/selection event names, payloads, other domain error codes, or notification ordering.

Wrap any exception from `deps.events.publish` as `PiscesError("event.publish_failed", ..., {cause})`. Update the existing Context subscriber-failure tests to expect this code/cause while retaining their assertions that committed nodes, queue consumption, selection, event sequence gaps, and later initialization remain correct.

Keep `events.ts -> context/types.ts` as `import type` so the shared event module and Context event adapter do not introduce a runtime cycle.

Implement `loop/types.ts` exactly as fixed above. Implement `createInterruptedToolResult` in `loop/interrupted.ts`. Export the public contracts and helper from `src/index.ts`; do not export the fake harness.

Update the design documents with these exact semantics:

- DDS §3.9 adds an `事件` category row for `event.publish_failed`: synchronous EventBus handler failure; already committed nodes, queue transitions, advanced heads, and allocated `seq` values remain, including allowed sequence gaps; no retry or rollback. When raised by `AgentLoopDriver`, it is emitted as `turn.ended.reason="failed"` and `TurnResult.error`.
- DDS §5.3 states that synchronous EventBus handler failures are normalized to `event.publish_failed` by both the Context notification adapter and the driver event publisher. Context commit and driver persistence state remain complete; the original exception is retained as `cause`; no callback is retried and no committed state is rolled back.
- HLD §8.4 adds the same `事件` category to its error table, explicitly stating that events are notifications rather than rollback boundaries and that a driver-time occurrence is a terminal turn error.

- [ ] **Step 4: Verify the green state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-events.test.ts packages/core/test/context-commit.test.ts packages/core/test/context.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/messages.ts packages/core/src/events.ts packages/core/src/context/events.ts packages/core/src/loop packages/core/src/index.ts packages/core/test/loop-events.test.ts`

Run: `rg -n 'event\.publish_failed|Context.*driver|同步 EventBus' 'docs/1 High-Level Design/1 High-Level Design.md' 'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'`

Expected: all commands exit 0; `rg` finds the event-category rows and consistent Context/driver mapping notes in both documents where required.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/core/src/messages.ts packages/core/src/events.ts packages/core/src/context/events.ts packages/core/src/loop/types.ts packages/core/src/loop/interrupted.ts packages/core/src/index.ts packages/core/test/loop-events.test.ts packages/core/test/context-commit.test.ts packages/core/test/context.test.ts 'docs/1 High-Level Design/1 High-Level Design.md' 'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
git commit -m "feat(core): define agent loop contracts and events"
```

### Task 2: One-step text turn and lifecycle

**Files:**
- Create: `packages/core/src/loop/driver.ts`
- Create: `packages/core/test/support/loop-harness.ts`
- Create: `packages/core/test/loop-text.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 loop/event contracts and helper.
- Produces: `createAgentLoopDriver(options: AgentLoopDriverOptions): AgentLoopDriver` in `loop/driver.ts`, conforming to `AgentLoopDriverFactory`.
- Harness exports `createLoopHarness(overrides?)` with a real `MemorySessionRepository`, `Sessions`, `Context`, deterministic node/queue IDs and clock, a shared synchronous fake `EventBus` implementing `publish` and `subscribe`, `enqueueAndConfirm`, and helpers for a fake adapter/executor. It defaults to real `createTools()`; tests may inject a fake `Tools`.
- Harness exports `holdAfterStep(step): { reached: Promise<void>; release(): void }`. Its fake bus subscriber only records that the matching `turn.step` was published. This sets a one-shot `blockNextDriverLock` flag. The harness-wrapped driver `runExclusive` sees that flag on the driver’s next acquisition, resolves `reached`, and waits outside the underlying non-reentrant lock before delegating. The driver’s fresh no-tool queue-check acquisition must be that next acquisition. The test performs queue business operations through the unwrapped base lock, then calls `release()`.
- The factory is stateful but reusable. A run transitions `idle -> running -> ended`, with `running -> cancelling -> ended` for cancellation; terminal publication happens before the active record is cleared. A second concurrent `run` throws `PiscesError("turn.active", ...)`.

- [ ] **Step 1: Write the failing one-step test.**

Build the harness with a fake adapter that records `buildRequest` inputs and parses JSON-encoded `LlmEvent[]` chunks. Configure the provider to yield:

```ts
[
  {
    type: "content",
    delta: "hel",
  },
  {
    type: "content",
    delta: "lo",
  },
  {
    type: "usage",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  },
  {
    type: "stop",
    reason: "stop",
  },
]
```

After enqueueing/confirming one user message, run turn `t1` and assert:

- `turn.started` is the first turn event and precedes the first `turn.delta`.
- Two `turn.delta` events have `kind="text"`, `step=1`, and deltas `["hel", "lo"]`.
- `adapter.buildRequest` received the `LlmRequest` returned by the first `Context.assemble`.
- `execute` received that adapter’s `WireRequest` and the driver signal.
- The persisted assistant node is `(kind=agent, role=assistant, source=assistant, content=[{type:"text",text:"hello"}])`; its parent is the Context-created user node.
- The shared event stream contains one driver `session.updated` with only that assistant node.
- `turn.step.data` is `{turnId:"t1", step:1, stopReason:"stop", usage:{inputTokens:10,outputTokens:2,totalTokens:12}}`.
- `turn.ended` is `reason:"completed"` and `TurnResult` equals `{sessionId, turnId:"t1", reason:"completed"}`.
- All turn event `seq` values are strictly increasing.

Add a second assertion that an unconfirmed queue message present during the turn does not appear in the assembled request and does not trigger a second provider call.

- [ ] **Step 2: Verify the red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-text.test.ts`

Expected: FAIL because `createAgentLoopDriver` is not implemented.

- [ ] **Step 3: Implement the lifecycle and text path.**

Implement `createAgentLoopDriver(options)` with:

- Atomic transition `idle -> running` under `options.runExclusive`; reject a concurrent run with `turn.active`.
- Publish `turn.started` under the lock before the first `assemble`.
- Use `step=1` and call `context.assemble({nodeId, contextWindow, maxOutput, signal})`; use the returned `headId` as the next explicit parent.
- Build one parser per step. Publish each parsed delta from its own lock-protected event call. Aggregate consecutive text deltas into a single text block and consecutive reasoning deltas into a single reasoning block.
- Require a `stop` event, record the last usage event, and finish a no-tool step by appending assistant content with `sessions.append(sessionId, [draft], headId)`.
- Put `sessions.append`, advancement of the local `headId`, and `session.updated` publication in one session-lock critical section. Publish `turn.step` afterward.
- Transition to `ended`, publish `turn.ended`, return the result, and clear the active turn in `finally`.

Do not duplicate Context’s session.updated for assembly nodes; Context already publishes those.

- [ ] **Step 4: Verify the green state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-events.test.ts packages/core/test/loop-text.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/loop packages/core/src/index.ts packages/core/test/support/loop-harness.ts packages/core/test/loop-text.test.ts`

Expected: all commands exit 0.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/core/src/loop/driver.ts packages/core/src/index.ts packages/core/test/support/loop-harness.ts packages/core/test/loop-text.test.ts
git commit -m "feat(core): drive single-step agent turns"
```

### Task 3: Multi-step tool loop and concurrent ordered results

**Files:**
- Modify: `packages/core/src/loop/driver.ts`
- Test: `packages/core/test/loop-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 driver loop, assembled `selection`, `Tools.invoke(call, selection, {sessionId, workspace, signal})`.
- Produces: one assistant node containing ordered text/reasoning/toolCall blocks, one ordered tool-result batch, and continuation to the next model step.
- Results are associated by the original `ToolCall.id`, not settlement order. No synthetic result is written during a normal tool call.

- [ ] **Step 1: Write the failing multi-call test.**

Have step 1 parse reasoning `"check"`, text `"calling"`, calls `call-slow` and `call-fast`, usage `u1`, and stop `"toolCall"`. Fake `Tools.invoke` gates both tools so both start before either finishes; release fast first, then slow. Have step 2 return text `"done"`, usage `u2`, and stop `"stop"`.

Assert:

- Both invocations started before either gate was released.
- Step 1 publishes a `turn.delta` event with `kind="reasoning"` and `delta="check"` before the text delta.
- Assistant step 1 content is exactly `[reasoning("check"), text("calling"), toolCall(call-slow), toolCall(call-fast)]`.
- The tool batch contains exactly two `kind=agent, role=tool, source=tool` nodes in `call-slow`, `call-fast` order regardless of settlement order.
- Each tool-result block maps to its original call id and preserves `content`, `isError`, and `code`.
- Parent chain is: initial user node → assistant step 1 → tool result 1 → tool result 2 → assistant step 2.
- The next assembled model request contains the assistant tool calls and both tool results in the same order.
- `turn.step` events are steps 1 and 2 with reasons `"toolCall"` and `"stop"` and usages `u1` and `u2`.
- The second supplier execute occurs without waiting for another user confirmation.

Add a regression where step 1 has tool calls but no text; the assistant node still contains the ordered toolCall blocks. Add a regression where a tool returns `{isError:true, code:"tool.failed"}`; the driver appends it and continues rather than ending the turn.

- [ ] **Step 2: Verify the red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-tools.test.ts`

Expected: FAIL because the driver currently ends after the first assistant reply.

- [ ] **Step 3: Implement tool steps.**

When parsed calls exist:

- Append and publish the assistant node before executing tools.
- Call `tools.invoke` once per parsed call concurrently with `Promise.all`; create a fresh invocation context with `meta.workspace` and the driver signal.
- Materialize results in original call order into `{type:"toolResult", toolCallId, content, isError?, code?}` blocks.
- Build one tool node per result block and append the ordered node batch inside one session-lock critical section; advance `headId` to the returned last node and publish `session.updated` in that same section.
- Publish `turn.step` with the supplier stop reason and usage, then continue the loop even when no queue entry exists.

Do not impose a driver-level concurrency limit. The excluded service `Concurrency` integration may later bound the launch rate; this milestone's contract is concurrent launch and deterministic ordered materialization.

- [ ] **Step 4: Verify the green state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-text.test.ts packages/core/test/loop-tools.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/loop/driver.ts packages/core/test/loop-tools.test.ts`

Expected: all commands exit 0.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/core/src/loop/driver.ts packages/core/test/loop-tools.test.ts
git commit -m "feat(core): execute agent tool steps in call order"
```

### Task 4: Delta framing, output truncation, and append preflight

**Files:**
- Modify: `packages/core/src/loop/driver.ts`
- Create: `packages/core/src/loop/content.ts`
- Test: `packages/core/test/loop-budgets.test.ts`

**Interfaces:**
- Consumes: Task 1 `EventPublisher.publishDelta/validateSessionNodes`; existing `validateJson`/`validateContent` and the text-clipping rule used by Context.
- Produces: `limitDriverContent(content: ContentBlock[]): ContentBlock[]`. It returns detached content, truncates text/reasoning blocks with the exact suffix until the whole content is <=262144 bytes when possible, preserves untruncatable fields, and does not reject content solely because those fields keep it above 262144 bytes. Event preflight owns the 4MiB indivisible-node limit.
- Produces: exact pre-append content and event-budget enforcement for assistant/tool/cancel batches.

- [ ] **Step 1: Write failing delta/content-budget tests.**

Configure a parser `content` delta of `"🐟".repeat(1_200_000)`. Assert:

- Every emitted `turn.delta` event is <= 4194303 serialized bytes.
- Concatenating all delta payloads equals the provider delta exactly.
- No emitted delta ends with half of a surrogate pair.
- The persisted assistant text is at most 262144 content bytes and ends with `"\n[truncated]"`.

Add a second test where a toolCall argument object is larger than 4MiB and cannot be truncated. Assert:

- `Sessions.append` is not called for the oversized assistant node.
- The turn returns `failed` with code `provider.invalid_response`.
- The only persisted node remains the Context-created user node.

Add a third test with two tool-result nodes whose individual core `session.updated` frames fit but whose combined frame does not. Use a large nested toolCall argument in each result so the driver preserves the untruncatable field. Assert two `session.updated` frames, each containing only whole ordered nodes, with no content mutation or node splitting.

- [ ] **Step 2: Verify the red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-budgets.test.ts`

Expected: FAIL because the driver currently emits unbudgeted deltas or appends unvalidated output.

- [ ] **Step 3: Implement output safety.**

Before every assistant/tool/cancel append:

- Pass driver-derived content through `limitDriverContent`. Map invalid JSON/content to `provider.invalid_response`; do not reuse Context's stricter whole-content rejection when untruncatable provider fields remain.
- Pass a `validate` callback to `Sessions.append`; the callback runs `eventPublisher.validateSessionNodes`.
- Wrap only the validation error from an oversized node as `provider.invalid_response`; do not swallow repository errors.
- On validation failure, stop the loop before the repository write and before any `session.updated`.

Use `publishDelta` for each text/reasoning event. Do not publish a partially accumulated tool argument.

- [ ] **Step 4: Verify the green state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-events.test.ts packages/core/test/loop-budgets.test.ts packages/core/test/loop-text.test.ts packages/core/test/loop-tools.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/loop/content.ts packages/core/src/loop/driver.ts packages/core/test/loop-budgets.test.ts`

Expected: all commands exit 0.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/core/src/loop/content.ts packages/core/src/loop/driver.ts packages/core/test/loop-budgets.test.ts
git commit -m "fix(core): bound streamed agent output"
```

### Task 5: Cancellation, steer, and active-turn state

**Files:**
- Modify: `packages/core/src/loop/driver.ts`
- Test: `packages/core/test/loop-control.test.ts`

**Interfaces:**
- Consumes: Task 2–4 driver loop.
- Produces: `cancel(turnId): Promise<boolean>`; `cancelling` state; partial-response persistence; cancel control node; next-step steer checks.
- Cancel control payload is exactly `{turnId, reason:"cancelled", at: headId}` encoded as one text block.

- [ ] **Step 1: Write failing steer tests.**

Use the harness `holdAfterStep(1)` barrier. Start `driver.run`, await `barrier.reached`, and only then enqueue/confirm `"steer"` through the harness’s base `runExclusive`. Do not call `Context.enqueue/confirm` from a bus subscriber: the driver holds the non-reentrant session lock while publishing `turn.step`. Release the barrier after the queue operation. Assert:

- The first step completes and is persisted.
- The driver assembles a second step using the first assistant node as `nodeId`.
- The second adapter request includes the steer user message.
- `execute` runs twice and the turn ends `completed`.

Repeat with an unconfirmed `"pending"` message added through the same outside-lock barrier. Assert the driver does not run a second step and the pending message remains unconfirmed.

- [ ] **Step 2: Verify the steer red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-control.test.ts`

Expected: FAIL because the driver does not yet decide whether another no-tool step is needed.

- [ ] **Step 3: Implement the confirmed-steer check.**

After a no-tool step, release the append/event critical section, then acquire a fresh session lock and read `context.snapshot().queue`. Continue only when the queue has a continuous confirmed prefix. This fresh acquisition is the harness step barrier and ensures tests can update queue state outside the non-reentrant lock before the decision. After a tool step, continue regardless because the tool results require a supplier follow-up.

- [ ] **Step 4: Add failing cancellation tests.**

Cover five cases:

1. Cancel during the supplier stream after one text chunk. The fake executor observes abort and throws the abort reason. Assert partial text is appended, no second execute happens, a cancel node is appended with `at` equal to the last assistant node, `turn.step.stopReason="cancelled"`, and `turn.ended.reason="cancelled"`.
2. Cancel during the supplier stream after text and two toolCall events but before `stop`. Assert the assistant node preserves the observed text and calls, neither `Tools.invoke` is called, and the cancel node follows the assistant node.
3. Cancel while two tools are running. Both tool signals observe abort, both results are still appended in original order after they settle, no next model step starts, the cancel node follows the tool batch, and `turn.ended.reason="cancelled"`.
4. Enqueue and confirm an unassembled steer before cancellation. After the run, that queue entry has no `confirmedAt`.
5. Pass an already-aborted `RunTurnInput.signal` before `run`. Assert `turn.started` is still emitted, `Context.assemble` is not called, no adapter build/execute or tool invocation occurs, all queue confirmations are cleared, no cancel node is appended for the still-temporary session, `turn.ended.reason="cancelled"`, and `TurnResult.reason="cancelled"`.

Also assert unknown turn ids return `false`, a second cancel for the still-active matching turn is idempotently `true`, cancelling after finish is `false`, and a concurrent second `run` rejects with `turn.active`.

- [ ] **Step 5: Verify the cancellation red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-control.test.ts`

Expected: FAIL on abort propagation, cancel-node persistence, confirmation clearing, or active state.

- [ ] **Step 6: Implement cancellation and state cleanup.**

Create an internal `AbortController` per run and forward the input signal into it. On matching `cancel(turnId)`:

- Transition `running -> cancelling` before aborting.
- Abort synchronously; clear all queue confirmations inside `options.runExclusive`.
- Keep the current turn active until its launched tools settle.
- Never start a new step after cancellation is observed.
- Persist any observed assistant content before the cancel node.
- Skip the cancel node when no session head exists yet (for cancellation before first persistence), but still end `cancelled`.
- Remove input-signal listeners and clear the active turn in `finally`.

If `input.signal.aborted` is already true after `turn.started`, take the same `cancelling -> ended` path before calling `Context.assemble`; do not special-case it as a provider failure.

Do not synthesize missing tool results in this path.

- [ ] **Step 7: Verify the green state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-control.test.ts packages/core/test/loop-text.test.ts packages/core/test/loop-tools.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/loop/driver.ts packages/core/test/loop-control.test.ts`

Expected: all commands exit 0.

- [ ] **Step 8: Commit.**

```bash
git status --short
git add packages/core/src/loop/driver.ts packages/core/test/loop-control.test.ts
git commit -m "fix(core): handle agent turn cancellation and steer"
```

### Task 6: Context, provider, adapter, event, and storage failures

**Files:**
- Modify: `packages/core/src/loop/driver.ts`
- Test: `packages/core/test/loop-failures.test.ts`

**Interfaces:**
- Consumes: all prior driver behavior.
- Produces: stable failure classification and `turn.ended.error` behavior; no new retry mechanism.

- [ ] **Step 1: Write failing context/provider tests.**

Assert these cases:

- Empty temporary context rejects with `turn.empty`; no adapter build/execute call occurs; turn ends `failed` with code `turn.empty`.
- `Context.assemble` rejecting with `PiscesError("storage.io", ...)` preserves the code/message, does not call the adapter or executor, and ends `failed`.
- `adapter.buildRequest` throwing a generic error ends `failed` with `provider.invalid_response`.
- `parseChunk` throwing, returning a non-array, returning an unknown event type, or producing no `stop` ends `failed` with `provider.invalid_response`.
- Two parsed calls with the same non-empty call id end `failed` with `provider.invalid_response`; neither the assistant node nor any tool result is appended, and no tool executes.
- `stop.reason="toolCall"` with zero parsed calls ends `failed` with `provider.invalid_response`.
- `stop.reason="error"` without an error event and `stop.reason="cancelled"` without driver cancellation each end `failed` with `provider.invalid_response`.
- Parsed calls with `stop.reason="stop"` are accepted: tools execute, recovery continues to the tool follow-up step, and `turn.step.data.stopReason` remains `"stop"`.
- A parsed `{type:"error", code:"provider.refusal", message:"blocked"}` ends `failed` preserving code/message.
- `execute` throwing `new PiscesError("provider.timeout", ...)` preserves that code; a generic throw maps to `provider.transport`.
- No second provider call starts after any of these failures.

Add exact `createInterruptedToolResult` coverage here again with two different call ids to pin that it does not mutate or reuse content arrays.

- [ ] **Step 2: Verify the red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-failures.test.ts`

Expected: FAIL on at least one unclassified failure path.

- [ ] **Step 3: Implement failure mapping.**

Classify:

- Existing `PiscesError`: preserve code/message.
- `AbortSignal` cancellation while the driver is not cancelling: run the same cancellation finalization as `cancel(turnId)`, including unconfirm, observed-content persistence, optional cancel node, and `reason="cancelled"`.
- Context errors: preserve the `PiscesError`.
- Adapter construction/parser/invalid event errors: `provider.invalid_response`.
- Duplicate call ids within one assistant response: `provider.invalid_response`.
- `stop.reason="toolCall"` with no parsed calls: `provider.invalid_response`.
- `stop.reason="error"` without an error event or `stop.reason="cancelled"` without driver cancellation: `provider.invalid_response`.
- Parsed calls with `stop.reason` equal to `"stop"`, `"length"`, or `"contentFilter"`: accept and execute; call presence is authoritative.
- Parsed supplier error event: preserve its code/message. Discard its optional `retryable` from `TurnResult.error` and `turn.ended` because those public shapes contain only code/message.
- Generic executor throw: `provider.transport`.

Always publish `turn.ended` under the session lock when possible, even after failure. Treat `event.publish_failed` as terminal and do not classify it as a provider/storage failure.

- [ ] **Step 4: Add failing EventBus publication tests.**

Use a synchronous fake bus whose subscriber throws on selected event types:

- Throw on `turn.started`: no adapter build/execute occurs, no Context row is written, the run returns `failed` with `event.publish_failed`, and it does not throw.
- Throw on the Context-produced initial `session.updated`: Context’s committed batch and queue consumption remain intact, no provider executes, and the driver returns `failed` with `event.publish_failed`.
- Throw on `turn.delta`: streaming stops, no assistant node is appended, no next step occurs, and the result is failed with `event.publish_failed`.
- Throw on the driver’s post-append `session.updated`: the assistant node remains persisted and `headId` has advanced internally, no `turn.step`/next provider call occurs, and the result is failed with `event.publish_failed`.
- Throw on post-append `turn.step`: the assistant node remains persisted, no next provider/tool step occurs, and the result is failed with `event.publish_failed`.
- Throw on `turn.ended`: committed nodes remain, the run still resolves `failed` with `event.publish_failed`, and there is exactly one attempted termination publication.

Add a control assertion that `EventBus.publish` observers are called synchronously in subscription order, while the function returned by `EventBus.subscribe` removes that handler after one invocation.

- [ ] **Step 5: Verify the publication red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-failures.test.ts`

Expected: FAIL because at least one publisher exception escapes `run`, causes a retry, or is misclassified.

- [ ] **Step 6: Implement publication failure propagation.**

Let synchronous bus errors propagate only to the driver boundary. Never await handlers, retry publication, roll back committed nodes, or issue another provider/tool step. Preserve the first `event.publish_failed`, attempt terminal publication once, and return a failed `TurnResult` without throwing.

- [ ] **Step 7: Add failing storage-boundary tests.**

Inject `storage.io` at each `Sessions.append` boundary:

- assistant reply;
- one tool-result batch;
- cancel control node.

For each, assert:

- The returned reason is `failed` with the original `storage.io` code.
- `turn.ended.error` carries the same code/message.
- No provider call occurs after the failed append.
- Nodes written before the failure remain; the failed batch does not appear.
- Tool-result failure occurs after the assistant node and before the next step.
- Cancel-node failure retains any partial assistant/tool content but still ends failed, not cancelled.

- [ ] **Step 8: Verify the storage red state.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-failures.test.ts`

Expected: FAIL where a storage exception is currently misclassified or the loop continues.

- [ ] **Step 9: Implement storage stop behavior.**

Only `Context.assemble` owns Context commit uncertainty. Driver append failures are ordinary terminal failures: stop immediately, preserve the current `headId`, never retry or re-append the batch, and never classify them as provider errors.

- [ ] **Step 10: Verify the full milestone.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-events.test.ts packages/core/test/loop-text.test.ts packages/core/test/loop-tools.test.ts packages/core/test/loop-budgets.test.ts packages/core/test/loop-control.test.ts packages/core/test/loop-failures.test.ts`

Run: `node_modules/.bin/vitest run`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/tsc -b tsconfig.build.json`

Run: `node_modules/.bin/biome check packages/core/src packages/core/test`

Run: `rg -n 'node:|@pisces/(daemon|protocol)' packages/core/src/loop packages/core/src/events.ts`

Expected: all tests/build/typecheck/Biome commands exit 0; `rg` prints no imports.

- [ ] **Step 11: Commit.**

```bash
git status --short
git add packages/core/src/loop/driver.ts packages/core/test/loop-failures.test.ts
git commit -m "fix(core): preserve agent turn failures"
```

## Completion Criteria

- A single streamed step persists one assistant node and emits `turn.started`, `turn.delta` frames, `session.updated`, `turn.step`, and `turn.ended` in order.
- Tool calls execute concurrently, settle in any order, and persist results in original call order with `ToolCall.id` association.
- Duplicate tool-call ids and `stop.reason="toolCall"` without calls fail as `provider.invalid_response`; parsed calls remain authoritative when the supplied stop reason differs.
- Every context-created, assistant, tool-result, and cancel node participates in one continuous parent chain and advances the explicit `headId`.
- Provider text is safely clipped before persistence while untruncatable fields remain intact; event preflight enforces the 4MiB core budget without splitting a node.
- Cancel, including an already-aborted input signal, aborts the stream/tool signal, waits for launched tools, preserves observed content, clears unassembled confirmations, appends one cancel record when a head exists, and never starts another step.
- Confirmed steer messages start the next step; unconfirmed messages do not.
- Context/provider/adapter/storage failures produce terminal `TurnResult`/`turn.ended` failures with stable codes and no blind retries.
- Synchronous EventBus publisher failures produce `event.publish_failed`, preserve already committed nodes and the advanced head, skip further work, and attempt terminal publication once without throwing.
- DDS §3.9/§5.3 and HLD §8.4 document `event.publish_failed` as a terminal turn error and document the same handler-error normalization in Context and the driver.
- The synthetic interrupted result helper is available for later daemon recovery, but this milestone does not scan sessions or perform crash recovery.

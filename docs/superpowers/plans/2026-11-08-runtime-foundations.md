# Daemon Runtime Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the daemon-side runtime primitives the Gateway needs — a non-reentrant per-session lock with an active-turn registry, a synchronous `EventBus`, and a shared per-session `SessionEventClock`.

**Architecture:** One `Concurrency` instance owns a FIFO promise-chain mutex per `SessionId` (guarded by `AsyncLocalStorage` so nested acquisition throws instead of deadlocking), plus a turn registry that stores each turn's abort handle and completion promise so `cancelAll` can abort and wait. Event delivery is a synchronous, subscription-ordered fan-out that attempts every handler and then rethrows the first failure. Clocks are plain monotonic counters; the Gateway creates one per session and passes the same object to `Context` and the driver.

**Tech Stack:** TypeScript, Node >=22.19.0, ESM, pnpm 12.8.1, `node:async_hooks` (`AsyncLocalStorage`), Vitest; no new dependencies.

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §3.1–3.4, §4.2–4.3, §5.6, §8.1–8.4; `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §3.8–3.10, §4.2.1, §4.4.4, §5.2, §5.3, §6.4, §6.5; `docs/2 Detailed Design Specification/P0 Decision Table.md` P0-11.

**Dependency:** This is plan A of two. Plan B (`2026-11-08-gateway-turn-runtime.md`) consumes every interface defined here. Implement A first on a `dev-*` branch; do not merge it. Plan B starts from the actual `HEAD` produced by A and records that commit as its diff base.

## Global Constraints

- Work on the existing `dev-pi` branch (a `dev-*` branch) at baseline `d728ac2` (verify with `git status --short` and `git log --oneline -1`); never commit to `main`, push, or merge, and do not merge plan A into another branch.
- This plan adds daemon code only. Do not modify `packages/core`, `packages/protocol`, the design documents outside Task 5, or any existing source file except `packages/daemon/src/index.ts`.
- Core must never import protocol, daemon, Node `fs`, or Node networking modules. The final boundary scan must exit 1 with no matches.
- `runExclusive` is a non-reentrant per-session logical lock: a callback that acquires the same session lock again must throw `TypeError("Session lock is not reentrant")` rather than deadlock. Different sessions must run concurrently.
- `Context.assemble` acquires its own A/C session locks; a caller must never hold the session lock while awaiting `assemble` or `AgentLoopDriver.run`. Plan B relies on this.
- `Concurrency` holds no persistent state. Active turns are process memory only; `active-turn.json` and its recovery belong to plan B. `cancelAll` never deletes markers.
- `EventBus.publish` is synchronous and subscription-ordered. Every handler is attempted; the first thrown error is rethrown after the last handler. Handlers enqueue sends only and never await. Subscription changes affect only later publishes.
- The daemon `EventBus` forwards events and rethrows the first handler failure unchanged. It does not wrap, sanitize, or reinterpret failures. Core's `createEventPublisher`/`deliverEvent` and `createContextEvents` already map failures to `event.publish_failed`; no daemon layer re-wraps that error or exposes its raw cause.
- `SessionEventClock.next()` is called only while the owning session lock is held, returns a non-negative monotonic safe integer, and has exactly one instance per session shared by `Context`, the driver, and the Gateway.
- No `Gateway`, protocol methods, `Extensions`, `CredentialStore`, `Transport`, CLI, or `active-turn.json` code is added by this plan.
- Use TDD: every production behavior starts with a test that is run and observed to fail for the expected missing behavior.
- Before every commit in every task, run the full verification block and require all six results:
  1. `node_modules/.bin/vitest run` — exit 0.
  2. `node_modules/.bin/tsc -p tsconfig.json` — exit 0.
  3. `node_modules/.bin/tsc -b tsconfig.build.json` — exit 0.
  4. `node_modules/.bin/biome check .` — exit 0.
  5. `rg -n 'from "@pisces/(daemon|protocol)"|node:(fs|net|http|https|tls|dgram|dns)' packages/core/src` — exit 1 with no output.
  6. `git status --short` — inspect; stage only the exact files named by the task.
  Never use `git add -A` or `git add .`. Focused red/green commands are allowed while developing, but the commit step must run this block.

## Review Focus

- A callback that re-enters the same session lock must fail fast with `TypeError` instead of hanging the session forever, while two different sessions still overlap in time. Task 1 covers both.
- A task that rejects must release its session lock, keep FIFO order for later tasks, and not poison the lock map; a duplicate turn registration for a session must not silently replace the existing turn. Task 1 covers this.
- `cancelAll` must abort each active turn exactly once, wait for completion, and leave the registry intact when the timeout expires so plan B's recovery can still see the marker. Task 1 covers this.
- A throwing `EventBus` handler must not prevent later subscribers from receiving the event, must not corrupt the subscription set, and the first failure must reach the publisher unchanged. The bus must not wrap or sanitize that failure; core's `createEventPublisher`/`deliverEvent` and `createContextEvents` own `event.publish_failed` mapping. Task 2 covers this.
- Clock allocations must never repeat or regress after many `next()` calls, snapshot reads must not allocate, and overflow must fail instead of returning an unsafe integer. Task 3 covers this.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/daemon/src/runtime/concurrency.ts` | Per-session mutex, active-turn registry, cancellation, `cancelAll` | 1 |
| `packages/daemon/src/runtime/event-bus.ts` | Synchronous subscription-ordered `EventBus` | 2 |
| `packages/daemon/src/runtime/event-clock.ts` | Shared monotonic `SessionEventClock` | 3 |
| `packages/daemon/src/index.ts` | Export the three factories and daemon-local `ActiveTurn` | 3–4 |
| `packages/daemon/test/concurrency.test.ts` | Lock, registry, and cancellation behavior | 1 |
| `packages/daemon/test/event-bus.test.ts` | Fan-out order, failure isolation, unsubscribe semantics | 2 |
| `packages/daemon/test/event-clock.test.ts` | Monotonic allocation, snapshot, overflow | 3 |
| `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` | §5.2/§5.3 interface synchronization | 5 |

## Fixed Interface Decisions

```ts
// packages/daemon/src/runtime/concurrency.ts
import type { SessionId, TurnId } from "@pisces/core";

export interface ActiveTurn {
  sessionId: SessionId;
  turnId: TurnId;
  startedAt: string;
}

export interface ConcurrencyOptions {
  cancelAllTimeoutMs?: number; // default 5_000
}

export interface Concurrency {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  registerTurn(
    sessionId: SessionId,
    turnId: TurnId,
    startedAt: string,
    cancel: () => void,
  ): void;
  unregisterTurn(sessionId: SessionId, turnId: TurnId): void;
  activeTurn(sessionId: SessionId): TurnId | undefined;
  activeTurns(): ActiveTurn[];
  cancelTurn(turnId: TurnId): boolean;
  cancelAll(maxWaitMs?: number): Promise<void>;
}

export function createConcurrency(options?: ConcurrencyOptions): Concurrency;
```

- `ActiveTurn` is daemon-local in this stage. DDS §2.5 places it in the protocol public types; the protocol phase moves it. Do not add it to `@pisces/core`.
- `runExclusive` queues behind the previous task for the same session. The first task for a session starts immediately. The lock entry is removed when the tail settles and no later task replaced it.
- A nested acquisition of the same session throws `TypeError("Session lock is not reentrant")` synchronously from inside the callback; the outer task keeps its lock. Cross-session nesting is allowed and simply queues.
- `registerTurn` throws `PiscesError("turn.active", "A turn is already active")` when the session already has a turn or the `turnId` is already registered; it never replaces a live registration.
- `cancelTurn` returns `false` for an unknown or already unregistered turn, otherwise invokes the stored cancel handle at most once and returns `true`. Repeated calls while the turn is still registered return `true` without invoking the handle again.
- `activeTurns` returns a detached snapshot sorted by `sessionId`, then `turnId`.
- `unregisterTurn` is idempotent: it only removes the entry whose `turnId` matches, resolves that entry's completion promise, and does nothing otherwise.
- `cancelAll(maxWaitMs = options.cancelAllTimeoutMs ?? 5_000)` cancels every registered turn once, then waits for all their completion promises or the timeout, whichever comes first. It never throws for a timeout and never unregisters turns itself.

```ts
// packages/daemon/src/runtime/event-bus.ts
import type { EventBus } from "@pisces/core";
export function createEventBus(): EventBus;
```

- `subscribe` returns an idempotent unsubscribe function. Iteration uses a snapshot of the handler set taken at `publish` time; subscribing or unsubscribing during a publish affects only later publishes.
- `publish` calls handlers in subscription order with the same event object, records the first thrown value, keeps calling the remaining handlers, then rethrows that first value. An event with no subscribers is a no-op. The bus never wraps the thrown value.

```ts
// packages/daemon/src/runtime/event-clock.ts
import type { SessionEventClock } from "@pisces/core";
export function createSessionEventClock(initial?: number): SessionEventClock;
```

- `initial` defaults to `0` and must be a non-negative safe integer, otherwise `TypeError`.
- `current()` reads without allocating. `next()` increments then returns. Allocating past `Number.MAX_SAFE_INTEGER` throws `RangeError("Session event sequence overflow")` and leaves the counter unchanged.

---

### Task 1: Per-session lock and active-turn registry

**Files:**
- Create: `packages/daemon/src/runtime/concurrency.ts`
- Test: `packages/daemon/test/concurrency.test.ts`

**Interfaces:**
- Consumes: `PiscesError`, `SessionId`, `TurnId` from `@pisces/core`.
- Produces: `ActiveTurn`, `ConcurrencyOptions`, `Concurrency`, `createConcurrency` exactly as declared above.

- [ ] **Step 1: Write the failing lock tests.**

```ts
test("serializes one session, rejects reentrancy, and releases after failure", async () => {
  const concurrency = createConcurrency();
  const sid = "s1" as SessionId;
  const order: string[] = [];
  let nested: unknown;
  const first = concurrency.runExclusive(sid, async () => {
    order.push("first");
    nested = await concurrency
      .runExclusive(sid, async () => order.push("nested"))
      .catch((error: unknown) => error);
    order.push("after");
  });
  const second = concurrency.runExclusive(sid, async () => {
    order.push("second");
  });
  await Promise.all([first, second]);
  expect(nested).toBeInstanceOf(TypeError);
  expect((nested as Error).message).toBe("Session lock is not reentrant");
  expect(order).toEqual(["first", "after", "second"]);
  await expect(
    concurrency.runExclusive(sid, async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  await expect(concurrency.runExclusive(sid, async () => "next")).resolves.toBe("next");
});
```

Also assert FIFO order across three queued tasks, that two sessions overlap while the first is blocked on a gate, and that a later task for a different session completes while the first session is still held.

- [ ] **Step 2: Run the red lock test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/concurrency.test.ts`

Expected: FAIL because `../src/runtime/concurrency.js` does not exist.

- [ ] **Step 3: Implement the mutex and reentrancy guard.**

Keep `Map<SessionId, Promise<void>>` for tails and one `AsyncLocalStorage<ReadonlySet<SessionId>>` for held sessions. Queue by awaiting the previous tail, run the callback with a new held set copied from the inherited set plus this `sessionId`, and delete the map entry in a `finally` only when the stored tail is still this task's tail.

- [ ] **Step 4: Write the failing registry tests.**

```ts
test("registers at most one turn per session and cancels it once", async () => {
  const concurrency = createConcurrency();
  const sid = "s1" as SessionId;
  const turnId = "t1" as TurnId;
  let cancelled = 0;
  concurrency.registerTurn(sid, turnId, NOW, () => {
    cancelled++;
  });
  expect(concurrency.activeTurn(sid)).toBe(turnId);
  expect(concurrency.activeTurns()).toEqual([{ sessionId: sid, turnId, startedAt: NOW }]);
  expect(() => concurrency.registerTurn(sid, "t2" as TurnId, NOW, () => {})).toThrowError(
    expect.objectContaining({ code: "turn.active" }),
  );
  expect(concurrency.cancelTurn(turnId)).toBe(true);
  expect(concurrency.cancelTurn(turnId)).toBe(true);
  expect(cancelled).toBe(1);
  concurrency.unregisterTurn(sid, turnId);
  concurrency.unregisterTurn(sid, turnId);
  expect(concurrency.activeTurns()).toEqual([]);
  expect(concurrency.cancelTurn(turnId)).toBe(false);
});
```

Also assert that registering a second turn for a different session is allowed, that `activeTurns` is a detached sorted snapshot, and that `unregisterTurn` with a mismatched `turnId` leaves the live turn registered.

- [ ] **Step 5: Run the red registry test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/concurrency.test.ts`

Expected: FAIL because registration/cancellation is not implemented.

- [ ] **Step 6: Implement the registry and cancellation.**

Store `Map<TurnId, { activeTurn, cancel, cancelled, done, finish }>`, resolve `done` in `unregisterTurn`, and return the completion promise from a private helper used by `cancelAll`.

- [ ] **Step 7: Write the failing `cancelAll` tests.**

```ts
test("cancels every turn, waits for completion, and keeps entries on timeout", async () => {
  const concurrency = createConcurrency();
  const sid = "s1" as SessionId;
  const turnId = "t1" as TurnId;
  let cancelled = 0;
  concurrency.registerTurn(sid, turnId, NOW, () => {
    cancelled++;
    concurrency.unregisterTurn(sid, turnId);
  });
  await concurrency.cancelAll(50);
  expect(cancelled).toBe(1);
  expect(concurrency.activeTurns()).toEqual([]);

  const stuck = "t2" as TurnId;
  concurrency.registerTurn(sid, stuck, NOW, () => {});
  vi.useFakeTimers();
  try {
    const waiting = concurrency.cancelAll(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;
  } finally {
    vi.useRealTimers();
  }
  expect(concurrency.activeTurns()).toEqual([{ sessionId: sid, turnId: stuck, startedAt: NOW }]);
});
```

Also assert `cancelAll()` on an empty registry resolves immediately, cancels each turn exactly once, and that the injected `cancelAllTimeoutMs` is the default when no argument is given.

- [ ] **Step 8: Run the red `cancelAll` test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/concurrency.test.ts`

Expected: FAIL because `cancelAll` is missing or does not wait.

- [ ] **Step 9: Implement `cancelAll` with a cleared timeout race.**

- [ ] **Step 10: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/runtime/concurrency.ts packages/daemon/test/concurrency.test.ts
git commit -m "feat(daemon): add session concurrency runtime"
```

### Task 2: Synchronous event bus

**Files:**
- Create: `packages/daemon/src/runtime/event-bus.ts`
- Test: `packages/daemon/test/event-bus.test.ts`

**Interfaces:**
- Consumes: `EngineEvent`, `EventBus` from `@pisces/core`.
- Produces: `createEventBus(): EventBus`.

- [ ] **Step 1: Write the failing ordering and isolation tests.**

```ts
test("delivers in subscription order, attempts every handler, and rethrows the first failure", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  const failure = new Error("first");
  const off = bus.subscribe((event) => {
    seen.push(`a:${event.type}`);
    throw failure;
  });
  bus.subscribe((event) => seen.push(`b:${event.type}`));
  expect(() => bus.publish(event("turn.started"))).toThrow(failure);
  expect(seen).toEqual(["a:turn.started", "b:turn.started"]);
  off();
  off();
  bus.publish(event("turn.step"));
  expect(seen).toEqual(["a:turn.started", "b:turn.started", "b:turn.step"]);
});
```

Also assert a publish with no subscribers is a no-op, and that an unsubscribe called during a publish does not remove the handler from the in-flight snapshot.

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/event-bus.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the bus.**

Keep `Set<(event: EngineEvent) => void>`; snapshot with `[...handlers]` in `publish`; track the first error in a sentinel and rethrow after the loop. Rethrow the original thrown value unchanged; do not wrap or sanitize it here.

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/runtime/event-bus.ts packages/daemon/test/event-bus.test.ts
git commit -m "feat(daemon): add synchronous event bus"
```

### Task 3: Shared session event clock

**Files:**
- Create: `packages/daemon/src/runtime/event-clock.ts`
- Test: `packages/daemon/test/event-clock.test.ts`

**Interfaces:**
- Consumes: `SessionEventClock` from `@pisces/core`.
- Produces: `createSessionEventClock(initial?: number): SessionEventClock`.

- [ ] **Step 1: Write the failing clock tests.**

```ts
test("allocates monotonically without allocating on snapshot", () => {
  const clock = createSessionEventClock();
  expect(clock.current()).toBe(0);
  expect(clock.next()).toBe(1);
  expect(clock.next()).toBe(2);
  expect(clock.current()).toBe(2);
  expect(clock.current()).toBe(2);
  expect(createSessionEventClock(5).next()).toBe(6);
  expect(() => createSessionEventClock(-1)).toThrow(TypeError);
});
```

Also assert that two sessions' clocks are independent, that many `next()` calls stay strictly increasing, and that the overflow guard throws `RangeError` without changing `current()`.

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/event-clock.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the clock.**

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/runtime/event-clock.ts packages/daemon/test/event-clock.test.ts
git commit -m "feat(daemon): add session event clock"
```

### Task 4: Export runtime primitives and run the daemon suite

**Files:**
- Modify: `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/concurrency.test.ts`, `packages/daemon/test/event-bus.test.ts`, `packages/daemon/test/event-clock.test.ts` (existing)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `@pisces/daemon` exports `createConcurrency`, `createEventBus`, `createSessionEventClock`, and the types `Concurrency`, `ConcurrencyOptions`, `ActiveTurn`.

- [ ] **Step 1: Add the failing export test.**

```ts
test("exports the runtime foundations from the daemon package", async () => {
  const daemon = await import("../src/index.js");
  expect(daemon.createConcurrency).toBeTypeOf("function");
  expect(daemon.createEventBus).toBeTypeOf("function");
  expect(daemon.createSessionEventClock).toBeTypeOf("function");
});
```

Place it in `packages/daemon/test/event-clock.test.ts` (the latest runtime test file).

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/event-clock.test.ts`

Expected: FAIL because the exports are missing.

- [ ] **Step 3: Export the factories and types from `packages/daemon/src/index.ts`.**

- [ ] **Step 4: Verify green and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only these files and commit:

```bash
git add packages/daemon/src/index.ts packages/daemon/test/event-clock.test.ts
git commit -m "feat(daemon): export runtime foundations"
```

### Task 5: Synchronize DDS §5.2/§5.3 and run the stage verification

**Files:**
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`
- Test: whole repository suite, typecheck, build, lint, core-boundary scan

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: DDS text that matches the implemented `Concurrency`, its cancellation hook, and the `EventBus` failure rule.

- [ ] **Step 1: Add the documentation regression check.**

Run:

```bash
rg -n "registerTurn\(sessionId: SessionId, turnId: TurnId, startedAt: string, cancel" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
```

Expected before the edit: exit 1, no match.

- [ ] **Step 2: Update DDS §5.2.**

Replace the `Concurrency` block with the implemented signatures (`registerTurn` with the `cancel` handle, `activeTurns`, `cancelTurn`, `cancelAll(maxWaitMs?)` defaulting to 5000ms). State that the lock is non-reentrant, that nested same-session acquisition throws `TypeError`, that tasks release the lock on rejection, that `cancelTurn` invokes the handle once, that `activeTurns` is a detached snapshot sorted by session then turn, and that `cancelAll` leaves registrations intact on timeout so plan B's `active-turn.json` recovery still applies.

- [ ] **Step 3: Update DDS §5.3.**

State that `EventBus.publish` is synchronous, subscription-ordered, attempts every handler, and rethrows the first failure unchanged; subscription changes affect only later publishes. State that the daemon bus never wraps a handler failure, while core's `createEventPublisher`/`deliverEvent` and `createContextEvents` own the `event.publish_failed` mapping and its original `cause`. Keep the existing `event.publish_failed` mapping text unchanged; only clarify ownership.

- [ ] **Step 4: Inspect the diff for scope.**

Run: `git diff --stat d728ac2 --` and `git diff d728ac2 -- packages/daemon/src packages/daemon/test`

Confirm no Gateway, protocol, Extensions, credential store, active-turn, or generated `dist` changes.

- [ ] **Step 5: Run the full Verification Block and commit.**

Run the full Verification Block from Global Constraints; all six checks must pass. Then stage only the DDS and commit:

```bash
git add 'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
git commit -m "docs: align concurrency contracts"
```

## Plan Self-Review

- **Spec coverage:** DDS §5.2 per-session lock, non-reentrancy, cross-session parallelism, active-turn registration, cancellation, and `cancelAll` map to Task 1; synchronous fan-out and `event.publish_failed` prerequisites map to Task 2; the shared monotonic `SessionEventClock` maps to Task 3; public availability maps to Task 4; DDS consistency maps to Task 5.
- **Deliberate exclusions:** Gateway routing, `active-turn.json`, recovery, protocol constants beyond `PROTOCOL_VERSION`, Extensions, `CredentialStore`, `Transport`, and CLI stay out of this plan and are owned by plan B or later stages.
- **Step scan:** every step names one file set, one command with an expected result, or one interface; no step says "handle edge cases".
- **Type consistency:** `ActiveTurn`, `Concurrency`, `ConcurrencyOptions`, `createConcurrency`, `createEventBus`, and `createSessionEventClock` keep one spelling across tasks and are the names plan B imports.
- **Review Focus mapping:** reentrancy/parallelism and duplicate registration → Task 1; lock release and FIFO → Task 1; `cancelAll` timeout → Task 1; EventBus failure isolation → Task 2; clock monotonicity/overflow → Task 3.

## Approvals Needed

1. **`Concurrency` signature extension.** DDS §5.2 lists `registerTurn(sessionId, turnId, startedAt)` without a cancel handle and omits `activeTurns`/`cancelTurn`. This plan adds the cancel handle and the two read/cancel methods so `turn.cancel` and `cancelAll` have one source of truth; Task 5 writes them back into the DDS. Approve, or choose a side registry in the Gateway.
2. **`ActiveTurn` location.** This stage defines `ActiveTurn` in `packages/daemon/src/runtime/concurrency.ts` instead of adding it to `@pisces/core` or `@pisces/protocol`. Approve the daemon-local type until the protocol phase.
3. **`cancelAll` default timeout.** 5000 ms is not specified anywhere; confirm the value and that a timeout is silent (markers stay for recovery).
4. **EventBus failure rule.** Handlers run to completion in subscription order and `publish` rethrows the first failure unchanged; confirm that later subscribers must still receive the event when an earlier handler throws, and that the daemon bus leaves `event.publish_failed` mapping to the existing core adapters instead of re-wrapping raw messages.

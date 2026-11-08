import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessions,
  type EngineEvent,
  type EventBus,
  type ExecuteProvider,
  type JsonValue,
  type NodeId,
  PiscesError,
  type SessionId,
  type SessionMeta,
  type SessionNode,
  type TurnId,
} from "@pisces/core";
import { afterEach, expect, test, vi } from "vitest";
import { type ActiveTurnStore, createActiveTurnStore } from "../src/gateway/active-turn.js";
import type {
  SessionReadResult,
  TurnListResult,
  TurnStartResult,
} from "../src/gateway/protocol.js";
import { recoverActiveTurns } from "../src/gateway/recovery.js";
import { createEventBus } from "../src/runtime/event-bus.js";
import {
  createGatewayHarness,
  draftQueueUser,
  draftUser,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./support/gateway-harness.js";

const open: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function openHarness(options: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
  const harness = await createGatewayHarness(options);
  open.push(harness);
  return harness;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pisces-gateway-turn-"));
}

function turnStart(
  harness: GatewayHarness,
  sessionId: SessionId,
  extra: Record<string, unknown> = {},
  id = "start",
) {
  return harness.gateway.handle({
    id,
    method: "turn.start",
    params: { sessionId, ...extra } as unknown as JsonValue,
  });
}

function turnCancel(harness: GatewayHarness, turnId: TurnId, id = "cancel") {
  return harness.gateway.handle({
    id,
    method: "turn.cancel",
    params: { turnId } as unknown as JsonValue,
  });
}

async function turnList(harness: GatewayHarness): Promise<TurnListResult> {
  const response = await harness.gateway.handle({
    id: "list",
    method: "turn.list",
    params: {} as unknown as JsonValue,
  });
  return response.result as unknown as TurnListResult;
}

async function readSession(
  harness: GatewayHarness,
  sessionId: SessionId,
): Promise<SessionReadResult> {
  const response = await harness.gateway.handle({
    id: "read",
    method: "session.read",
    params: { sessionId } as unknown as JsonValue,
  });
  if (response.error) throw new PiscesError(response.error.code, response.error.message);
  return response.result as unknown as SessionReadResult;
}

async function collect(source: AsyncIterable<SessionNode>): Promise<SessionNode[]> {
  const nodes: SessionNode[] = [];
  for await (const node of source) nodes.push(node);
  return nodes;
}

async function waitForEmpty(harness: GatewayHarness): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await turnList(harness)).turns).toEqual([]);
    },
    { timeout: 2000, interval: 10 },
  );
}

async function waitForTurns(
  harness: GatewayHarness,
  turns: TurnListResult["turns"],
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await turnList(harness)).turns).toEqual(turns);
    },
    { timeout: 2000, interval: 10 },
  );
}

function turnIdOf(response: Awaited<ReturnType<typeof turnStart>>): TurnId {
  return (response.result as unknown as TurnStartResult).turnId;
}

function at(nodes: readonly SessionNode[], index: number): SessionNode {
  const node = nodes[index];
  if (!node) throw new Error(`Missing seeded node ${index}`);
  return node;
}

function cancelPayload(node: SessionNode): Record<string, unknown> {
  const block = node.content[0];
  if (block?.type !== "text") throw new Error("Missing cancel payload");
  return JSON.parse(block.text) as Record<string, unknown>;
}

const blockedExecute = (): ExecuteProvider =>
  async function* (_request, signal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

interface CountingMarkerStore {
  store: ActiveTurnStore;
  writes(): number;
}

function countingMarkerStore(store: ActiveTurnStore): CountingMarkerStore {
  let writes = 0;
  return {
    writes: () => writes,
    store: {
      read: (sessionId) => store.read(sessionId),
      async write(sessionId, marker) {
        writes += 1;
        await store.write(sessionId, marker);
      },
      remove: (sessionId, turnId) => store.remove(sessionId, turnId),
      list: () => store.list(),
      scan: () => store.scan(),
    },
  };
}

function failingMarkerStore(store: ActiveTurnStore): ActiveTurnStore {
  let failed = false;
  return {
    read: (sessionId) => store.read(sessionId),
    async write(sessionId, marker) {
      if (!failed) {
        failed = true;
        throw new PiscesError("storage.io", "Active turn storage I/O failed");
      }
      await store.write(sessionId, marker);
    },
    remove: (sessionId, turnId) => store.remove(sessionId, turnId),
    list: () => store.list(),
    scan: () => store.scan(),
  };
}

function failingRemoveMarkerStore(
  store: ActiveTurnStore,
  failures = 2,
): { store: ActiveTurnStore; attempts(): number } {
  let remaining = failures;
  let attempts = 0;
  return {
    attempts: () => attempts,
    store: {
      read: (sessionId) => store.read(sessionId),
      write: (sessionId, marker) => store.write(sessionId, marker),
      async remove(sessionId, turnId) {
        attempts += 1;
        if (remaining > 0) {
          remaining -= 1;
          throw new PiscesError("storage.io", "Active turn storage I/O failed");
        }
        await store.remove(sessionId, turnId);
      },
      list: () => store.list(),
      scan: () => store.scan(),
    },
  };
}

interface BlockingRemoveMarkerStore {
  store: ActiveTurnStore;
  entered: Promise<void>;
  release(): void;
}

function blockingRemoveMarkerStore(store: ActiveTurnStore): BlockingRemoveMarkerStore {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    entered: enteredPromise,
    release,
    store: {
      read: (sessionId) => store.read(sessionId),
      write: (sessionId, marker) => store.write(sessionId, marker),
      async remove(sessionId, turnId) {
        entered();
        await gate;
        await store.remove(sessionId, turnId);
      },
      list: () => store.list(),
      scan: () => store.scan(),
    },
  };
}

test("writes the marker before the driver, appends the turn, and cleans up", async () => {
  let h!: GatewayHarness;
  let meta!: SessionMeta;
  let seen: Awaited<ReturnType<GatewayHarness["markers"]["read"]>>;
  let listed: TurnListResult | undefined;
  h = await createGatewayHarness({
    execute: async function* () {
      seen = await h.markers.read(meta.id);
      listed = await turnList(h);
      yield "frame";
    },
  });
  open.push(h);
  const seeded = await h.seed([draftUser("hello")]);
  meta = seeded.meta;
  const beforeOffset = await h.store.commitOffset(meta.id);

  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  const ended = await h.waitForTurnEnd(turnId);

  expect((started.result as unknown as TurnStartResult).mode).toBe("new");
  expect(ended.data.reason).toBe("completed");
  expect(seen).toEqual({
    turnId,
    startedAt: expect.any(String),
    startOffset: beforeOffset,
    startNodeId: at(seeded.nodes, 0).id,
  });
  expect(listed?.turns).toEqual([{ sessionId: meta.id, turnId, startedAt: expect.any(String) }]);

  await waitForEmpty(h);
  expect(await h.markers.read(meta.id)).toBeUndefined();
  const records = await collect(h.store.readBranch(meta.id));
  expect(records.map((node) => node.role)).toEqual(["user", "assistant"]);
  expect(records.at(1)?.parentId).toBe(at(seeded.nodes, 0).id);
});

test("continues the event sequence waterline from session.read", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  const before = await readSession(h, meta.id);

  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await h.waitForTurnEnd(turnId);
  await waitForEmpty(h);

  const events = h.events().filter((event) => event.seq !== undefined);
  const first = events.find((event) => event.type === "turn.started");
  expect(first?.seq).toBe(before.seq + 1);
  const sequences = events.map((event) => event.seq as number);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
});

test("starts from an explicit nodeId branch", async () => {
  let h!: GatewayHarness;
  let meta!: SessionMeta;
  let seen: Awaited<ReturnType<GatewayHarness["markers"]["read"]>>;
  h = await createGatewayHarness({
    execute: async function* () {
      seen = await h.markers.read(meta.id);
      yield "frame";
    },
  });
  open.push(h);
  const seeded = await h.seed([draftUser("one"), draftUser("two")]);
  meta = seeded.meta;
  const target = at(seeded.nodes, 0).id;

  const started = await turnStart(h, meta.id, { nodeId: target });
  const turnId = turnIdOf(started);
  await h.waitForTurnEnd(turnId);
  await waitForEmpty(h);

  expect(seen?.startNodeId).toBe(target);
  const records = await collect(h.store.readBranch(meta.id));
  expect(records.at(-1)?.parentId).toBe(target);
});

test("rejects an unknown session, a temporary nodeId, and a removed model", async () => {
  const h = await openHarness({ validateWorkspace: async () => true });

  const unknown = await turnStart(h, "missing" as SessionId);
  expect(unknown.error?.code).toBe("session.not_found");

  const created = await h.gateway.handle({
    id: "create",
    method: "session.create",
    params: { workspace: "/workspace", provider: "p", model: "m" } as unknown as JsonValue,
  });
  const temporary = created.result as unknown as SessionMeta;
  const nodeId = await turnStart(h, temporary.id, { nodeId: "n1" as NodeId });
  expect(nodeId.error?.code).toBe("session.node_not_found");

  const { meta: removed } = await h.seed([draftUser("hello")], {
    provider: "gone",
    model: "m",
  } as unknown as SessionMeta);
  const invalid = await turnStart(h, removed.id);
  expect(invalid.error?.code).toBe("session.invalid_model");

  const { meta: persisted } = await h.seed([draftUser("hello")]);
  const missing = await turnStart(h, persisted.id, { nodeId: "missing" as NodeId }, "missing");
  expect(missing.error?.code).toBe("session.node_not_found");

  expect(h.executed).toEqual([]);
  expect(await h.markers.read(removed.id)).toBeUndefined();
  expect(await h.markers.read(persisted.id)).toBeUndefined();
  expect((await turnList(h)).turns).toEqual([]);
});

test("starts the driver only after releasing the session lock", async () => {
  let h!: GatewayHarness;
  let meta!: SessionMeta;
  const outcomes: string[] = [];
  h = await createGatewayHarness({
    execute: async function* () {
      try {
        await h.concurrency.runExclusive(meta.id, async () => undefined);
        outcomes.push("acquired");
      } catch (error) {
        outcomes.push(error instanceof TypeError ? "reentrant" : "error");
        throw error;
      }
      yield "frame";
    },
  });
  open.push(h);
  meta = (await h.seed([draftUser("hello")])).meta;

  const started = await turnStart(h, meta.id);
  const ended = await h.waitForTurnEnd(turnIdOf(started));
  await waitForEmpty(h);

  expect(ended.data.reason).toBe("completed");
  expect(outcomes).toEqual(["acquired"]);
});

test("steers into the active turn, confirms new entries, and rejects nodeId", async () => {
  const dataDir = await tempDir();
  const counting = countingMarkerStore(createActiveTurnStore({ dataDir }));
  const h = await createGatewayHarness({
    dataDir,
    markerStore: counting.store,
    execute: blockedExecute(),
  });
  open.push(h);
  const { meta, nodes } = await h.seed([draftUser("hello")]);

  const first = await turnStart(h, meta.id);
  const turnId = turnIdOf(first);
  await h.enqueue(meta.id, [draftQueueUser("steer")]);
  const steer = await turnStart(h, meta.id, {}, "steer");
  expect(steer.result).toEqual({ turnId, mode: "steer" });

  const confirmed = await readSession(h, meta.id);
  expect(confirmed.queue).toHaveLength(1);
  expect(confirmed.queue.at(0)?.confirmedAt).toEqual(expect.any(String));

  await h.enqueue(meta.id, [draftQueueUser("blocked")]);
  const updates = h.events().filter((event) => event.type === "queue.updated").length;
  const forbidden = await turnStart(h, meta.id, { nodeId: at(nodes, 0).id }, "forbidden");
  expect(forbidden.error?.code).toBe("turn.node_id_forbidden");
  expect(h.events().filter((event) => event.type === "queue.updated")).toHaveLength(updates);
  const untouched = await readSession(h, meta.id);
  expect(untouched.queue.at(-1)?.confirmedAt).toBeUndefined();
  expect((await h.markers.read(meta.id))?.turnId).toBe(turnId);
  expect(counting.writes()).toBe(1);

  await turnCancel(h, turnId);
  await h.waitForTurnEnd(turnId);
  await waitForEmpty(h);
});

test("cancels by turn id without taking the session lock", async () => {
  const h = await openHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);

  const cancelled = await turnCancel(h, turnId);
  expect(cancelled.result).toEqual({ cancelled: true });
  expect((await h.waitForTurnEnd(turnId)).data.reason).toBe("cancelled");

  expect(await turnCancel(h, turnId, "repeat")).toEqual({
    id: "repeat",
    result: { cancelled: false },
  });
  await waitForEmpty(h);
});

test("cancels while the session lock is held elsewhere", async () => {
  const h = await openHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);

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
  const cancelled = await turnCancel(h, turnId);
  expect(cancelled.result).toEqual({ cancelled: true });
  releaseLock();
  await held;

  expect((await h.waitForTurnEnd(turnId)).data.reason).toBe("cancelled");
  await waitForEmpty(h);
});

test("reports a cancel request without claiming the turn ended", async () => {
  let release!: () => void;
  let enteredExecute!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredExecute = resolve;
  });
  const h = await openHarness({
    execute: async function* () {
      enteredExecute();
      await gate;
      yield "frame";
    },
  });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await entered;

  try {
    expect((await turnCancel(h, turnId)).result).toEqual({ cancelled: true });
    expect(h.events().some((event) => event.type === "turn.ended")).toBe(false);
    const listed = await turnList(h);
    expect(listed.turns).toEqual([{ sessionId: meta.id, turnId, startedAt: expect.any(String) }]);
    const steered = await turnStart(h, meta.id, {}, "steer");
    expect(steered.result).toEqual({ turnId, mode: "steer" });
  } finally {
    release();
  }

  await h.waitForTurnEnd(turnId);
  await waitForEmpty(h);
});

test("returns true for a repeated cancel while the turn is still running", async () => {
  let release!: () => void;
  let enteredExecute!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredExecute = resolve;
  });
  const h = await openHarness({
    execute: async function* () {
      enteredExecute();
      await gate;
      yield "frame";
    },
  });
  const { meta } = await h.seed([draftUser("hello")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await entered;

  try {
    expect((await turnCancel(h, turnId, "first")).result).toEqual({ cancelled: true });
    expect((await turnCancel(h, turnId, "second")).result).toEqual({ cancelled: true });
    const listed = await turnList(h);
    expect(listed.turns).toEqual([{ sessionId: meta.id, turnId, startedAt: expect.any(String) }]);
    expect(h.events().some((event) => event.type === "turn.ended")).toBe(false);
  } finally {
    release();
  }

  await h.waitForTurnEnd(turnId);
  await waitForEmpty(h);
  expect(h.events().filter((event) => event.type === "turn.ended")).toHaveLength(1);
});

test("cancel deletes the marker and appends a cancelled control node", async () => {
  const h = await openHarness({ execute: blockedExecute() });
  const { meta, nodes } = await h.seed([draftUser("hello")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);

  await turnCancel(h, turnId);
  await h.waitForTurnEnd(turnId);
  await waitForEmpty(h);

  expect(await h.markers.read(meta.id)).toBeUndefined();
  const records = await collect(h.store.readBranch(meta.id));
  const cancel = records.at(-1);
  expect(cancel).toMatchObject({ kind: "control", role: "cancel" });
  expect(cancelPayload(cancel as SessionNode)).toMatchObject({
    turnId,
    reason: "cancelled",
    at: at(nodes, 0).id,
  });
});

test("cancelling one session's turn leaves another session's turn running", async () => {
  const h = await openHarness({ execute: blockedExecute() });
  const first = await h.seed([draftUser("one")]);
  const second = await h.seed([draftUser("two")]);
  const firstTurn = turnIdOf(await turnStart(h, first.meta.id, {}, "first"));
  const secondTurn = turnIdOf(await turnStart(h, second.meta.id, {}, "second"));

  await turnCancel(h, firstTurn);
  await h.waitForTurnEnd(firstTurn);

  await waitForTurns(h, [
    { sessionId: second.meta.id, turnId: secondTurn, startedAt: expect.any(String) },
  ]);
  const listed = await turnList(h);
  expect(listed.turns).toEqual([
    { sessionId: second.meta.id, turnId: secondTurn, startedAt: expect.any(String) },
  ]);
  expect((await turnCancel(h, secondTurn)).result).toEqual({ cancelled: true });
  await h.waitForTurnEnd(secondTurn);
  await waitForEmpty(h);
});

test("writes a temporary-session marker after the first create", async () => {
  let h!: GatewayHarness;
  let meta!: SessionMeta;
  let seen: Awaited<ReturnType<GatewayHarness["markers"]["read"]>>;
  h = await createGatewayHarness({
    validateWorkspace: async () => true,
    execute: async function* () {
      seen = await h.markers.read(meta.id);
      yield "frame";
    },
  });
  open.push(h);
  const created = await h.gateway.handle({
    id: "create",
    method: "session.create",
    params: { workspace: "/workspace", provider: "p", model: "m" } as unknown as JsonValue,
  });
  meta = created.result as unknown as SessionMeta;
  await h.enqueue(meta.id, [draftQueueUser("hello")]);

  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await h.waitForTurnEnd(turnId);
  await waitForEmpty(h);

  expect(seen).toMatchObject({ turnId, startOffset: 0 });
  expect(seen?.startNodeId).toBeUndefined();
  expect(await h.markers.read(meta.id)).toBeUndefined();
});

// A process crash between the first create commit and the marker write is not recoverable;
// the write failure itself must be observable and must not reach the provider.
test("fails the turn before any request when the temporary marker cannot be written", async () => {
  const dataDir = await tempDir();
  const h = await createGatewayHarness({
    dataDir,
    markerStore: failingMarkerStore(createActiveTurnStore({ dataDir })),
    validateWorkspace: async () => true,
  });
  open.push(h);
  const created = await h.gateway.handle({
    id: "create",
    method: "session.create",
    params: { workspace: "/workspace", provider: "p", model: "m" } as unknown as JsonValue,
  });
  const meta = created.result as unknown as SessionMeta;
  await h.enqueue(meta.id, [draftQueueUser("hello")]);

  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  const ended = await h.waitForTurnEnd(turnId);

  expect(ended.data).toMatchObject({ reason: "failed", error: { code: "storage.io" } });
  expect(h.executed).toEqual([]);
  expect(await h.markers.read(meta.id)).toBeUndefined();
  expect((await h.store.list()).map((session) => session.id)).toContain(meta.id);
  const records = await collect(h.store.readBranch(meta.id));
  expect(records.map((node) => node.role)).toEqual(["user"]);
  expect((await readSession(h, meta.id)).queue).toEqual([]);

  await waitForEmpty(h);
});

test("keeps the turn listed and blocks new starts while marker cleanup is pending", async () => {
  const dataDir = await tempDir();
  const blocker = blockingRemoveMarkerStore(createActiveTurnStore({ dataDir }));
  const h = await createGatewayHarness({ dataDir, markerStore: blocker.store });
  open.push(h);
  const { meta, nodes } = await h.seed([draftUser("hello")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);

  const ended = await h.waitForTurnEnd(turnId);
  await blocker.entered;
  expect(ended.data.reason).toBe("completed");
  expect((await turnList(h)).turns).toEqual([
    { sessionId: meta.id, turnId, startedAt: expect.any(String) },
  ]);
  const pending = await h.markers.read(meta.id);
  expect(pending).toMatchObject({ turnId, startNodeId: at(nodes, 0).id });

  const blocked = await turnStart(h, meta.id, {}, "blocked");
  expect(blocked.error?.code).toBe("turn.active");
  expect((await turnCancel(h, turnId)).result).toEqual({ cancelled: false });
  expect(await h.markers.read(meta.id)).toEqual(pending);

  blocker.release();
  await waitForEmpty(h);
  expect(await h.markers.read(meta.id)).toBeUndefined();

  const fresh = await turnStart(h, meta.id, {}, "fresh");
  expect(fresh.result).toMatchObject({ mode: "new" });
  await h.waitForTurnEnd(turnIdOf(fresh));
  await waitForEmpty(h);
});

test("keeps the surviving gateway's handler after another gateway unsubscribes", async () => {
  const real = createEventBus();
  const offs: (() => void)[] = [];
  const recording: EventBus = {
    publish: (event) => real.publish(event),
    subscribe(handler) {
      const off = real.subscribe(handler);
      offs.push(off);
      return off;
    },
  };
  const first = await createGatewayHarness({ bus: recording });
  open.push(first);
  const dataDir = await tempDir();
  const blocker = blockingRemoveMarkerStore(createActiveTurnStore({ dataDir }));
  const second = await createGatewayHarness({
    bus: recording,
    dataDir,
    markerStore: blocker.store,
  });
  open.push(second);
  expect(offs).toHaveLength(2);
  offs[0]?.();

  const { meta, nodes } = await second.seed([draftUser("hello")]);
  const started = await turnStart(second, meta.id);
  const turnId = turnIdOf(started);
  const ended = await second.waitForTurnEnd(turnId);
  await blocker.entered;

  expect(ended.data.reason).toBe("completed");
  expect(await second.markers.read(meta.id)).toMatchObject({
    turnId,
    startNodeId: at(nodes, 0).id,
  });
  expect((await turnCancel(second, turnId)).result).toEqual({ cancelled: false });

  blocker.release();
  await waitForEmpty(second);
  expect(await second.markers.read(meta.id)).toBeUndefined();
});

test("surfaces marker cleanup failure and blocks the session until recovery", async () => {
  const dataDir = await tempDir();
  const failing = failingRemoveMarkerStore(createActiveTurnStore({ dataDir }));
  const h = await createGatewayHarness({ dataDir, markerStore: failing.store });
  open.push(h);
  const { meta, nodes } = await h.seed([draftUser("hello")]);
  await h.enqueue(meta.id, [draftQueueUser("queued")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);

  const ended = await h.waitForTurnEnd(turnId);
  const failure = await h.waitForEvent("turn.cleanup_failed");
  await vi.waitFor(() => expect(failing.attempts()).toBe(2), { timeout: 2000, interval: 10 });

  expect(ended.data.reason).toBe("completed");
  expect(failure).toMatchObject({
    type: "turn.cleanup_failed",
    sessionId: meta.id,
    data: { turnId, code: "storage.io" },
  });
  expect(failure.seq).toEqual(expect.any(Number));
  expect(failure.at).toEqual(expect.any(String));
  for (const forbidden of ["cause", "headers", "body", "credential"]) {
    expect(JSON.stringify(failure)).not.toContain(forbidden);
  }

  await vi.waitFor(
    async () => {
      const branch = await collect(h.store.readBranch(meta.id));
      expect(branch.at(-1)).toMatchObject({ kind: "control", role: "cancel" });
    },
    { timeout: 2000, interval: 10 },
  );
  const beforeRecovery = await collect(h.store.readBranch(meta.id));
  const cancel = beforeRecovery.at(-1);
  expect(cancel).toMatchObject({ kind: "control", role: "cancel" });
  expect(cancelPayload(cancel as SessionNode)).toMatchObject({
    turnId,
    reason: "cleanup_failed",
    at: beforeRecovery.at(-2)?.id,
  });
  expect(await h.markers.read(meta.id)).toMatchObject({
    turnId,
    startNodeId: at(nodes, 0).id,
  });
  expect((await turnList(h)).turns).toEqual([
    { sessionId: meta.id, turnId, startedAt: expect.any(String) },
  ]);

  await h.enqueue(meta.id, [draftQueueUser("later")]);
  const blocked = await turnStart(h, meta.id, {}, "blocked");
  expect(blocked.error?.code).toBe("turn.active");
  const read = await readSession(h, meta.id);
  expect(read.queue.every((entry) => entry.confirmedAt === undefined)).toBe(true);
  expect(await h.markers.read(meta.id)).toMatchObject({ turnId });
  expect((await turnCancel(h, turnId)).result).toEqual({ cancelled: false });

  const sessions = createSessions({
    repository: h.store,
    newId: () => randomUUID() as NodeId,
    now: () => new Date().toISOString(),
  });
  const issues = await recoverActiveTurns({
    store: h.store,
    markers: h.markers,
    sessions,
  });
  expect(issues).toEqual([]);
  expect(await collect(h.store.readBranch(meta.id))).toEqual(beforeRecovery);
  expect(await h.markers.read(meta.id)).toBeUndefined();
});

test("ignores unrelated events without a session runtime", async () => {
  const h = await openHarness();
  const event: EngineEvent = {
    type: "turn.ended",
    sessionId: "other" as SessionId,
    seq: 1,
    at: new Date().toISOString(),
    data: { turnId: "t" as TurnId, reason: "completed", endedAt: new Date().toISOString() },
  };
  expect(() => h.bus.publish(event)).not.toThrow();
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContentBlock,
  EngineEvent,
  JsonValue,
  QueueEntry,
  QueueEntryId,
  QueueEntryInput,
  SessionId,
  TurnId,
} from "@pisces/core";
import { afterEach, expect, test, vi } from "vitest";
import { type ActiveTurnStore, createActiveTurnStore } from "../src/gateway/active-turn.js";
import type {
  QueueEnqueueResult,
  SessionReadResult,
  TurnListResult,
  TurnStartResult,
} from "../src/gateway/protocol.js";
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

function enqueue(
  harness: GatewayHarness,
  sessionId: SessionId,
  entries: QueueEntryInput[],
  id = "1",
) {
  return harness.gateway.handle({
    id,
    method: "queue.enqueue",
    params: { sessionId, entries } as unknown as JsonValue,
  });
}

function queueUpdates(harness: GatewayHarness): EngineEvent[] {
  return harness.events().filter((event) => event.type === "queue.updated");
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
  return response.result as unknown as SessionReadResult;
}

function editQueue(
  harness: GatewayHarness,
  sessionId: SessionId,
  id: QueueEntryId,
  content: ContentBlock[],
  requestId = "edit",
) {
  return harness.gateway.handle({
    id: requestId,
    method: "queue.edit",
    params: { sessionId, id, content } as unknown as JsonValue,
  });
}

function removeQueue(
  harness: GatewayHarness,
  sessionId: SessionId,
  id: QueueEntryId,
  requestId = "remove",
) {
  return harness.gateway.handle({
    id: requestId,
    method: "queue.remove",
    params: { sessionId, id } as unknown as JsonValue,
  });
}

function clearQueue(harness: GatewayHarness, sessionId: SessionId, requestId = "clear") {
  return harness.gateway.handle({
    id: requestId,
    method: "queue.clear",
    params: { sessionId } as unknown as JsonValue,
  });
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

function turnCancel(harness: GatewayHarness, turnId: TurnId) {
  return harness.gateway.handle({
    id: "cancel",
    method: "turn.cancel",
    params: { turnId } as unknown as JsonValue,
  });
}

function turnIdOf(response: Awaited<ReturnType<typeof turnStart>>): TurnId {
  return (response.result as unknown as TurnStartResult).turnId;
}

async function turnList(harness: GatewayHarness): Promise<TurnListResult> {
  const response = await harness.gateway.handle({
    id: "list",
    method: "turn.list",
    params: {} as unknown as JsonValue,
  });
  return response.result as unknown as TurnListResult;
}

const blockedExecute = () =>
  async function* (_request: unknown, signal?: AbortSignal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pisces-gateway-queue-"));
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

function failingRemoveMarkerStore(store: ActiveTurnStore, failures = 2): ActiveTurnStore {
  let remaining = failures;
  return {
    read: (sessionId) => store.read(sessionId),
    write: (sessionId, marker) => store.write(sessionId, marker),
    async remove(sessionId, turnId) {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("Active turn storage I/O failed");
      }
      await store.remove(sessionId, turnId);
    },
    list: () => store.list(),
    scan: () => store.scan(),
  };
}

test("enqueues through the public method and publishes queue.updated", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);

  const response = await enqueue(h, meta.id, [draftQueueUser("hello")]);

  const result = response.result as unknown as QueueEnqueueResult;
  expect(result.ids).toHaveLength(1);
  expect(queueUpdates(h).at(-1)?.data).toMatchObject({
    queue: [{ kind: "agent", role: "user", content: [{ type: "text", text: "hello" }] }],
  });
});

test("returns an empty id list for no entries", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);

  const response = await enqueue(h, meta.id, []);

  expect(response).toEqual({ id: "1", result: { ids: [] } });
  expect(queueUpdates(h)).toEqual([]);
});

test("rejects an unknown session", async () => {
  const h = await openHarness();
  await h.seed([draftUser("seed")]);

  const response = await enqueue(h, "missing" as SessionId, [draftQueueUser("x")]);

  expect(response.error?.code).toBe("session.not_found");
});

test("rejects malformed params with protocol.invalid_request", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);

  const malformed: Record<string, unknown>[] = [
    { entries: [draftQueueUser("x")] },
    { sessionId: 5, entries: [] },
    { sessionId: meta.id },
    { sessionId: meta.id, entries: "nope" },
  ];
  for (const params of malformed) {
    const response = await h.gateway.handle({
      id: "bad",
      method: "queue.enqueue",
      params: params as never,
    });
    expect(response.error?.code).toBe("protocol.invalid_request");
  }
});

test("rejects client control entries", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const controls = [
    {
      kind: "control",
      role: "declaration",
      source: "test",
      content: [{ type: "text", text: JSON.stringify({ toggle: [] }) }],
    },
    {
      kind: "control",
      role: "compaction",
      source: "test",
      content: [{ type: "text", text: "{}" }],
    },
    {
      kind: "control",
      role: "cancel",
      source: "test",
      content: [{ type: "text", text: "{}" }],
    },
  ] as unknown as QueueEntryInput[];

  for (const entry of controls) {
    const response = await enqueue(h, meta.id, [entry]);
    expect(response.error?.code).toBe("queue.invalid_control");
  }
  expect(queueUpdates(h)).toEqual([]);
});

test("keeps rejecting client declarations without an extensions service", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const entry = {
    kind: "control",
    role: "declaration",
    source: "test",
    content: [{ type: "text", text: JSON.stringify({ toggle: ["pkg#tool"] }) }],
  } as unknown as QueueEntryInput;

  const response = await enqueue(h, meta.id, [entry]);

  expect(response.error?.code).toBe("queue.invalid_control");
  expect(queueUpdates(h)).toEqual([]);
});

test("rejects an invalid agent role or content", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const invalid = [
    { ...draftQueueUser("x"), role: "bogus" },
    {
      kind: "agent",
      role: "user",
      source: "test",
      content: [{ type: "text", text: 5 }],
    },
  ] as unknown as QueueEntryInput[];

  for (const entry of invalid) {
    const response = await enqueue(h, meta.id, [entry]);
    expect(response.error?.code).toBe("queue.invalid_control");
  }
  expect(queueUpdates(h)).toEqual([]);
});

test("rejects an entry over 256 KiB", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);

  const response = await enqueue(h, meta.id, [draftQueueUser("a".repeat(300_000))]);

  expect(response.error?.code).toBe("queue.entry_too_large");
  expect(queueUpdates(h)).toEqual([]);
});

test("rejects a queue over 1 MiB", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const entries = Array.from({ length: 5 }, () => draftQueueUser("b".repeat(250_000)));

  const response = await enqueue(h, meta.id, entries);

  expect(response.error?.code).toBe("queue.too_large");
  expect(queueUpdates(h)).toEqual([]);
});

test("serializes concurrent enqueues on one session clock", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);

  const [first, second] = await Promise.all([
    enqueue(h, meta.id, [draftQueueUser("one")], "1"),
    enqueue(h, meta.id, [draftQueueUser("two")], "2"),
  ]);

  expect((first.result as unknown as QueueEnqueueResult).ids).toHaveLength(1);
  expect((second.result as unknown as QueueEnqueueResult).ids).toHaveLength(1);
  const updates = queueUpdates(h);
  expect(updates).toHaveLength(2);
  const seqs = updates
    .map((event) => event.seq)
    .filter((seq): seq is number => typeof seq === "number");
  expect(seqs).toHaveLength(2);
  expect(new Set(seqs).size).toBe(2);
  expect(seqs[1]).toBeGreaterThan(seqs[0] as number);
  const last = updates.at(-1) as EngineEvent;
  const queue = (last.data as unknown as { queue: unknown[] }).queue;
  expect(queue).toHaveLength(2);
});

test("edits an unconfirmed agent entry and publishes exactly one queue.updated", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const ids = await h.enqueue(meta.id, [draftQueueUser("before")]);
  expect(queueUpdates(h)).toHaveLength(1);

  const response = await editQueue(h, meta.id, ids[0] as QueueEntryId, [
    { type: "text", text: "after" },
  ]);

  expect(response).toEqual({ id: "edit", result: { id: ids[0] } });
  expect((await readSession(h, meta.id)).queue).toEqual([
    expect.objectContaining({ id: ids[0], content: [{ type: "text", text: "after" }] }),
  ]);
  const updates = queueUpdates(h);
  expect(updates).toHaveLength(2);
  expect(updates[1]?.seq).toBeGreaterThan(updates[0]?.seq as number);
});

test("locks a confirmed entry but still removes any queued entry", async () => {
  const h = await openHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("seed")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  const ids = await h.enqueue(meta.id, [draftQueueUser("steer")]);
  expect((await turnStart(h, meta.id, {}, "steer")).result).toEqual({ turnId, mode: "steer" });
  const confirmed = (await readSession(h, meta.id)).queue.find(
    (entry) => entry.id === ids[0],
  ) as QueueEntry;
  expect(confirmed.confirmedAt).toEqual(expect.any(String));
  const updates = queueUpdates(h).length;

  const locked = await editQueue(h, meta.id, ids[0] as QueueEntryId, [{ type: "text", text: "x" }]);
  expect(locked.error?.code).toBe("queue.entry_locked");
  expect(queueUpdates(h)).toHaveLength(updates);
  expect((await readSession(h, meta.id)).queue).toEqual([confirmed]);

  const removed = await removeQueue(h, meta.id, ids[0] as QueueEntryId);
  expect(removed).toEqual({ id: "remove", result: { id: ids[0] } });
  expect((await readSession(h, meta.id)).queue).toEqual([]);
  expect(queueUpdates(h)).toHaveLength(updates + 1);

  await turnCancel(h, turnId);
  await h.waitForTurnEnd(turnId);
});

test("rejects unknown ids and malformed edit, remove and clear parameters", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);

  for (const response of [
    await editQueue(h, meta.id, "missing" as QueueEntryId, [{ type: "text", text: "x" }]),
    await removeQueue(h, meta.id, "missing" as QueueEntryId),
  ]) {
    expect(response.error?.code).toBe("queue.entry_not_found");
  }

  const malformed: [string, Record<string, unknown>][] = [
    ["queue.edit", { id: "x", content: [] }],
    ["queue.edit", { sessionId: "not a session", id: "x", content: [] }],
    ["queue.edit", { sessionId: meta.id, id: 5, content: [] }],
    ["queue.edit", { sessionId: meta.id, id: "x", content: "nope" }],
    ["queue.remove", { sessionId: meta.id }],
    ["queue.remove", { sessionId: meta.id, id: 5 }],
    ["queue.clear", {}],
    ["queue.clear", { sessionId: 5 }],
  ];
  for (const [method, params] of malformed) {
    const response = await h.gateway.handle({
      id: "bad",
      method,
      params: params as unknown as JsonValue,
    });
    expect(response.error?.code).toBe("protocol.invalid_request");
  }
});

test("clears every queued entry only while no turn is registered", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const ids = await h.enqueue(meta.id, [draftQueueUser("one"), draftQueueUser("two")]);
  const before = queueUpdates(h).length;

  const response = await clearQueue(h, meta.id);

  expect(response).toEqual({ id: "clear", result: { ids } });
  expect((await readSession(h, meta.id)).queue).toEqual([]);
  expect(queueUpdates(h)).toHaveLength(before + 1);

  expect(await clearQueue(h, meta.id, "empty")).toEqual({ id: "empty", result: { ids: [] } });
  expect(queueUpdates(h)).toHaveLength(before + 1);
});

test("rejects queue.clear with zero partial changes while a turn is running", async () => {
  const h = await openHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("seed")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await h.enqueue(meta.id, [draftQueueUser("keep")]);
  const queue = (await readSession(h, meta.id)).queue;
  const updates = queueUpdates(h).length;

  const response = await clearQueue(h, meta.id);

  expect(response.error).toEqual({
    code: "turn.active",
    message: "A turn is active for this session",
  });
  expect((await readSession(h, meta.id)).queue).toEqual(queue);
  expect(queueUpdates(h)).toHaveLength(updates);
  expect((await turnList(h)).turns).toHaveLength(1);

  await turnCancel(h, turnId);
  await h.waitForTurnEnd(turnId);
});

test("rejects queue.clear with zero partial changes during cleanup", async () => {
  const dataDir = await tempDir();
  const blocker = blockingRemoveMarkerStore(createActiveTurnStore({ dataDir }));
  const h = await openHarness({ dataDir, markerStore: blocker.store });
  const { meta } = await h.seed([draftUser("seed")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await h.waitForTurnEnd(turnId);
  await blocker.entered;
  await h.enqueue(meta.id, [draftQueueUser("keep")]);
  const queue = (await readSession(h, meta.id)).queue;
  const updates = queueUpdates(h).length;

  const response = await clearQueue(h, meta.id);

  expect(response.error?.code).toBe("turn.active");
  expect((await readSession(h, meta.id)).queue).toEqual(queue);
  expect(queueUpdates(h)).toHaveLength(updates);
  expect((await turnList(h)).turns).toHaveLength(1);

  blocker.release();
  await vi.waitFor(async () => expect((await turnList(h)).turns).toEqual([]), {
    timeout: 2000,
    interval: 10,
  });
});

test("rejects queue.clear with zero partial changes after a failed cleanup", async () => {
  const dataDir = await tempDir();
  const h = await openHarness({
    dataDir,
    markerStore: failingRemoveMarkerStore(createActiveTurnStore({ dataDir })),
  });
  const { meta } = await h.seed([draftUser("seed")]);
  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await h.waitForTurnEnd(turnId);
  await h.waitForEvent("turn.cleanup_failed");
  await h.enqueue(meta.id, [draftQueueUser("keep")]);
  const queue = (await readSession(h, meta.id)).queue;
  const updates = queueUpdates(h).length;

  const response = await clearQueue(h, meta.id);

  expect(response.error?.code).toBe("turn.active");
  expect((await readSession(h, meta.id)).queue).toEqual(queue);
  expect(queueUpdates(h)).toHaveLength(updates);
  expect((await turnList(h)).turns).toHaveLength(1);
});

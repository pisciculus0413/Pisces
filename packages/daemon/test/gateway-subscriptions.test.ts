import type { EngineEvent, JsonValue, SessionId, SessionMeta, TurnId } from "@pisces/core";
import { MAX_EVENT_BYTES, type ProtocolEvent } from "@pisces/protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { GatewayResponse, TurnListResult, TurnStartResult } from "../src/gateway/protocol.js";
import {
  createGatewayHarness,
  draftQueueUser,
  draftUser,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./support/gateway-harness.js";

const FIXED_AT = "2026-11-08T05:00:00.000Z";
const open: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function openHarness(options: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
  const harness = await createGatewayHarness(options);
  open.push(harness);
  return harness;
}

function attach(harness: GatewayHarness, connectionId: string): ProtocolEvent[] {
  const events: ProtocolEvent[] = [];
  harness.gateway.attach(connectionId, (event) => {
    events.push(event);
  });
  return events;
}

function subscription(
  harness: GatewayHarness,
  connectionId: string | undefined,
  method: "session.subscribe" | "session.unsubscribe",
  sessionId: SessionId,
  extra: Record<string, unknown> = {},
): Promise<GatewayResponse> {
  return harness.gateway.handle(
    {
      id: "subscription",
      method,
      params: { sessionId, ...extra } as unknown as JsonValue,
    },
    connectionId,
  );
}

function subscribe(
  harness: GatewayHarness,
  connectionId: string | undefined,
  sessionId: SessionId,
  extra: Record<string, unknown> = {},
): Promise<GatewayResponse> {
  return subscription(harness, connectionId, "session.subscribe", sessionId, extra);
}

function unsubscribe(
  harness: GatewayHarness,
  connectionId: string | undefined,
  sessionId: SessionId,
): Promise<GatewayResponse> {
  return subscription(harness, connectionId, "session.unsubscribe", sessionId);
}

function turnStart(harness: GatewayHarness, sessionId: SessionId) {
  return harness.gateway.handle({
    id: "start",
    method: "turn.start",
    params: { sessionId } as unknown as JsonValue,
  });
}

function turnCancel(harness: GatewayHarness, turnId: TurnId) {
  return harness.gateway.handle({
    id: "cancel",
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

function turnIdOf(response: GatewayResponse): TurnId {
  return (response.result as unknown as TurnStartResult).turnId;
}

const blockedExecute = () =>
  async function* (_request: unknown, signal?: AbortSignal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

function deltaEvent(sessionId: SessionId, seq: number, delta: string): EngineEvent {
  return {
    type: "turn.delta",
    sessionId,
    seq,
    at: FIXED_AT,
    data: { turnId: "near-budget" as TurnId, step: 1, kind: "text", delta },
  };
}

test("routes events only to connections subscribed to the event's session", async () => {
  const h = await openHarness();
  const first = await h.seed([draftUser("one")]);
  const second = await h.seed([draftUser("two")]);
  const one = attach(h, "connection-one");
  const two = attach(h, "connection-two");

  expect(
    (await subscribe(h, "connection-one", first.meta.id, { connectionId: "connection-two" }))
      .result,
  ).toEqual({ sessionId: first.meta.id });
  expect((await subscribe(h, "connection-one", second.meta.id)).result).toEqual({
    sessionId: second.meta.id,
  });
  expect((await subscribe(h, "connection-two", second.meta.id)).result).toEqual({
    sessionId: second.meta.id,
  });

  await h.enqueue(first.meta.id, [draftQueueUser("first")]);
  expect(one).toHaveLength(1);
  expect(one[0]).toMatchObject({
    event: "queue.updated",
    data: {
      sessionId: first.meta.id,
      seq: expect.any(Number),
      at: expect.any(String),
      queue: [expect.objectContaining({ role: "user" })],
    },
  });
  expect(two).toHaveLength(0);
  expect(JSON.stringify(one[0])).not.toContain("connection-one");
  expect(JSON.stringify(one[0])).not.toContain("connection-two");

  await h.enqueue(second.meta.id, [draftQueueUser("second")]);
  expect(one).toHaveLength(2);
  expect(two).toHaveLength(1);
  expect(two[0]).toMatchObject({
    event: "queue.updated",
    data: { sessionId: second.meta.id },
  });
});

test("makes duplicate subscribe and unsubscribe idempotent", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  const events = attach(h, "c");

  expect((await subscribe(h, "c", meta.id)).result).toEqual({ sessionId: meta.id });
  expect((await subscribe(h, "c", meta.id)).result).toEqual({ sessionId: meta.id });
  await h.enqueue(meta.id, [draftQueueUser("one")]);
  expect(events).toHaveLength(1);

  expect((await unsubscribe(h, "c", meta.id)).result).toEqual({ sessionId: meta.id });
  expect((await unsubscribe(h, "c", meta.id)).result).toEqual({ sessionId: meta.id });
  await h.enqueue(meta.id, [draftQueueUser("two")]);
  expect(events).toHaveLength(1);
});

test("unsubscribing one session leaves the connection's other subscriptions", async () => {
  const h = await openHarness();
  const first = await h.seed([draftUser("one")]);
  const second = await h.seed([draftUser("two")]);
  const events = attach(h, "c");
  await subscribe(h, "c", first.meta.id);
  await subscribe(h, "c", second.meta.id);

  await unsubscribe(h, "c", first.meta.id);
  await h.enqueue(first.meta.id, [draftQueueUser("first")]);
  expect(events).toHaveLength(0);
  await h.enqueue(second.meta.id, [draftQueueUser("second")]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ data: { sessionId: second.meta.id } });
});

test("rejects unknown sessions and validates temporary sessions", async () => {
  const h = await openHarness({ validateWorkspace: async () => true });
  const events = attach(h, "c");

  expect((await subscribe(h, "c", "missing" as SessionId)).error?.code).toBe("session.not_found");
  expect((await subscribe(h, "c", "not a session" as SessionId)).error?.code).toBe(
    "protocol.invalid_request",
  );

  const created = await h.gateway.handle({
    id: "create",
    method: "session.create",
    params: { workspace: "/workspace", provider: "p", model: "m" } as unknown as JsonValue,
  });
  const meta = created.result as unknown as SessionMeta;
  expect((await subscribe(h, "c", meta.id)).result).toEqual({ sessionId: meta.id });

  await h.enqueue(meta.id, [draftQueueUser("temporary")]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "queue.updated",
    data: { sessionId: meta.id },
  });
});

test("keeps subscription methods unknown without a live connection", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);

  expect(await subscribe(h, undefined, meta.id)).toEqual({
    id: "subscription",
    error: { code: "protocol.unknown_method", message: "Unknown protocol method" },
  });
  expect((await unsubscribe(h, undefined, meta.id)).error?.code).toBe("protocol.unknown_method");
  expect((await subscribe(h, "not-attached", meta.id)).error?.code).toBe("protocol.unknown_method");

  const listed = await h.gateway.handle({
    id: "list",
    method: "turn.list",
    params: {} as unknown as JsonValue,
  });
  expect(listed.result).toEqual({ turns: [] });
  const providers = await h.gateway.handle({
    id: "providers",
    method: "provider.list",
    params: {} as unknown as JsonValue,
  });
  expect(providers.error).toBeUndefined();
});

test("detaching during an active turn removes subscriptions without cancelling", async () => {
  const h = await openHarness({ execute: blockedExecute() });
  const { meta } = await h.seed([draftUser("hello")]);
  const events = attach(h, "c");
  await subscribe(h, "c", meta.id);

  const started = await turnStart(h, meta.id);
  const turnId = turnIdOf(started);
  await h.waitForEvent("turn.started");
  const seen = events.length;

  h.gateway.detach("c");
  expect((await turnList(h)).turns).toEqual([
    { sessionId: meta.id, turnId, startedAt: expect.any(String) },
  ]);
  expect(await h.markers.read(meta.id)).toMatchObject({ turnId });
  expect(h.events().some((event) => event.type === "turn.ended")).toBe(false);

  await h.enqueue(meta.id, [draftQueueUser("queued")]);
  expect(events).toHaveLength(seen);
  expect((await turnCancel(h, turnId)).result).toEqual({ cancelled: true });
  await h.waitForTurnEnd(turnId);
  await vi.waitFor(
    async () => {
      expect((await turnList(h)).turns).toEqual([]);
    },
    { timeout: 2000, interval: 10 },
  );
});

test("delivers a projected event of exactly the 4 MiB wire budget", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  const events = attach(h, "c");
  await subscribe(h, "c", meta.id);

  const base = deltaEvent(meta.id, 7, "");
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  const filler = "a".repeat(MAX_EVENT_BYTES - 1 - baseBytes);
  const atLimit = deltaEvent(meta.id, 7, filler);
  expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(MAX_EVENT_BYTES - 1);

  expect(() => h.bus.publish(atLimit)).not.toThrow();
  expect(events).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(events[0]), "utf8")).toBe(MAX_EVENT_BYTES);

  expect(() => h.bus.publish(deltaEvent(meta.id, 9, "small"))).not.toThrow();
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    event: "turn.delta",
    data: { sessionId: meta.id, delta: "small" },
  });
});

test("a throwing subscriber neither fails publication nor affects another client", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  let attempts = 0;
  h.gateway.attach("broken", () => {
    attempts += 1;
    throw new Error("broken client");
  });
  const healthy = attach(h, "healthy");
  await subscribe(h, "broken", meta.id);
  await subscribe(h, "healthy", meta.id);

  expect(() => h.bus.publish(deltaEvent(meta.id, 1, "one"))).not.toThrow();
  expect(attempts).toBe(1);
  expect(healthy).toHaveLength(1);

  expect(() => h.bus.publish(deltaEvent(meta.id, 2, "two"))).not.toThrow();
  expect(attempts).toBe(1);
  expect(healthy).toHaveLength(2);

  await expect(h.enqueue(meta.id, [draftQueueUser("committed")])).resolves.toHaveLength(1);
  expect(healthy).toHaveLength(3);
  expect(healthy[2]).toMatchObject({
    event: "queue.updated",
    data: { sessionId: meta.id },
  });
});

test("forwards only known safe session event types", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  const events = attach(h, "c");
  await subscribe(h, "c", meta.id);

  expect(() =>
    h.bus.publish({
      type: "internal.debug",
      sessionId: meta.id,
      seq: 1,
      at: FIXED_AT,
      data: { secret: "hidden" },
    }),
  ).not.toThrow();
  expect(events).toHaveLength(0);

  expect(() =>
    h.bus.publish({
      type: "turn.cleanup_failed",
      sessionId: meta.id,
      seq: 2,
      at: FIXED_AT,
      data: {
        turnId: "cleanup-turn" as TurnId,
        code: "storage.io",
        message: "Active turn marker could not be removed",
      },
    }),
  ).not.toThrow();
  expect(events).toEqual([
    {
      event: "turn.cleanup_failed",
      data: {
        sessionId: meta.id,
        seq: 2,
        at: FIXED_AT,
        turnId: "cleanup-turn",
        code: "storage.io",
        message: "Active turn marker could not be removed",
      },
    },
  ]);
});

test("dispose detaches the gateway handler", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  const events = attach(h, "c");
  await subscribe(h, "c", meta.id);

  h.gateway.dispose();
  h.gateway.dispose();
  expect(() => h.bus.publish(deltaEvent(meta.id, 1, "after"))).not.toThrow();
  expect(events).toHaveLength(0);
});

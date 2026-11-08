import type {
  EngineEvent,
  JsonValue,
  QueueEntryInput,
  SessionId,
  SessionMeta,
  SessionNodeDraft,
  TurnId,
} from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import type { SessionReadResult } from "../src/gateway/protocol.js";
import {
  createGatewayHarness,
  descriptor,
  draftUser,
  type GatewayHarness,
  type GatewayHarnessOptions,
  gatewayModel,
} from "./support/gateway-harness.js";

const NOW = "2026-11-08T05:00:00.000Z";

const open: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function openHarness(options: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
  const harness = await createGatewayHarness(options);
  open.push(harness);
  return harness;
}

function configure(harness: GatewayHarness, params: Record<string, unknown>, id = "1") {
  return harness.gateway.handle({
    id,
    method: "session.configure",
    params: params as unknown as JsonValue,
  });
}

function read(harness: GatewayHarness, sessionId: SessionId, id = "read") {
  return harness.gateway.handle({
    id,
    method: "session.read",
    params: { sessionId } as unknown as JsonValue,
  });
}

function queueUpdates(harness: GatewayHarness): EngineEvent[] {
  return harness.events().filter((event) => event.type === "queue.updated");
}

function instruction(value: string): QueueEntryInput {
  return {
    kind: "agent",
    role: "system",
    source: "instruction",
    content: [{ type: "text", text: value }],
  };
}

function registerP2(harness: GatewayHarness): void {
  harness.providers.registerProvider(descriptor({ id: "p2", models: [gatewayModel("m2")] }));
}

test("updates persisted model/provider atomically and rejects while a turn is active", async () => {
  const h = await openHarness();
  registerP2(h);
  const { meta } = await h.seed([draftUser("hello")]);
  await h.enqueue(meta.id, [instruction("keep me")]);
  const updatesBefore = queueUpdates(h).length;

  const updated = await configure(h, { sessionId: meta.id, model: "m2", provider: "p2" });

  expect((updated.result as unknown as SessionMeta).model).toBe("m2");
  expect((updated.result as unknown as SessionMeta).provider).toBe("p2");
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m2", provider: "p2" });

  h.concurrency.registerTurn(meta.id, "t1" as TurnId, NOW, () => {});
  const rejected = await configure(
    h,
    { sessionId: meta.id, model: "m", provider: "p", systemPrompt: "ignored" },
    "2",
  );

  expect(rejected.error).toEqual({ code: "turn.active", message: expect.any(String) });
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m2", provider: "p2" });
  const page = (await read(h, meta.id)).result as unknown as SessionReadResult;
  expect(page.meta).toMatchObject({ model: "m2", provider: "p2" });
  expect(page.queue).toMatchObject([
    { source: "instruction", content: [{ type: "text", text: "keep me" }] },
  ]);
  expect(queueUpdates(h)).toHaveLength(updatesBefore);
});

test("updates a temporary session only in memory", async () => {
  const h = await openHarness({
    newSessionId: () => "temp-1" as SessionId,
    defaults: { workspace: "/workspace", provider: "p", model: "m" },
    validateWorkspace: async () => true,
  });
  registerP2(h);
  const created = await h.gateway.handle({
    id: "create",
    method: "session.create",
    params: {} as unknown as JsonValue,
  });
  const meta = created.result as unknown as SessionMeta;

  const updated = await configure(h, { sessionId: meta.id, model: "m2", provider: "p2" });

  expect(updated.result).toMatchObject({ id: meta.id, model: "m2", provider: "p2" });
  expect(await h.store.list()).toEqual([]);
  expect((await read(h, meta.id)).result).toMatchObject({
    meta: { id: meta.id, model: "m2", provider: "p2" },
  });
});

test("requires model and provider together", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);

  for (const params of [
    { sessionId: meta.id, model: "m" },
    { sessionId: meta.id, provider: "p" },
  ]) {
    const response = await configure(h, params);
    expect(response.error?.code).toBe("session.model_required");
  }
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m", provider: "p" });
  expect((await read(h, meta.id)).result).toMatchObject({ meta: { model: "m", provider: "p" } });
  expect(queueUpdates(h)).toEqual([]);
});

test("rejects an unknown model pair and leaves runtime and stored metadata unchanged", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  // Prime the runtime so a stale-runtime update would be visible.
  expect((await read(h, meta.id)).result).toMatchObject({ meta: { model: "m", provider: "p" } });

  for (const params of [
    { sessionId: meta.id, model: "missing", provider: "p" },
    { sessionId: meta.id, model: "m", provider: "missing" },
    { sessionId: meta.id, model: "m2", provider: "p" },
  ]) {
    const response = await configure(h, params);
    expect(response.error?.code).toBe("session.invalid_model");
  }

  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m", provider: "p" });
  expect((await read(h, meta.id)).result).toMatchObject({ meta: { model: "m", provider: "p" } });
});

test("updates an existing unconfirmed instruction entry and publishes one queue event", async () => {
  const h = await openHarness();
  const { meta, nodes } = await h.seed([draftUser("hello")]);
  await h.enqueue(meta.id, [instruction("old")]);
  const updatesBefore = queueUpdates(h).length;

  const response = await configure(h, { sessionId: meta.id, systemPrompt: "new" });

  expect(response.error).toBeUndefined();
  expect(response.result).toEqual(meta);
  const page = (await read(h, meta.id)).result as unknown as SessionReadResult;
  expect(page.queue).toMatchObject([
    {
      kind: "agent",
      role: "system",
      source: "instruction",
      content: [{ type: "text", text: "new" }],
    },
  ]);
  expect(page.queue[0]?.confirmedAt).toBeUndefined();
  expect(page.queue).toHaveLength(1);
  expect(page.records).toEqual(nodes);
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m", provider: "p" });
  expect(queueUpdates(h)).toHaveLength(updatesBefore + 1);
});

test("adds an instruction entry when absent without writing meta or records", async () => {
  const h = await openHarness();
  const persisted = (value: string): SessionNodeDraft => ({
    kind: "agent",
    role: "system",
    source: "instruction",
    content: [{ type: "text", text: value }],
  });
  const { meta, nodes } = await h.seed([
    draftUser("hello"),
    persisted("first"),
    persisted("second"),
  ]);
  expect(queueUpdates(h)).toEqual([]);

  const response = await configure(h, { sessionId: meta.id, systemPrompt: "fresh" });

  expect(response.error).toBeUndefined();
  const page = (await read(h, meta.id)).result as unknown as SessionReadResult;
  expect(page.queue).toMatchObject([
    {
      kind: "agent",
      role: "system",
      source: "instruction",
      content: [{ type: "text", text: "fresh" }],
    },
  ]);
  expect(page.queue).toHaveLength(1);
  expect(page.records).toEqual(nodes);
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m", provider: "p" });
  expect(queueUpdates(h)).toHaveLength(1);
});

test("edits only the most recent unconfirmed instruction entry", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);
  await h.enqueue(meta.id, [instruction("one"), instruction("two")]);
  const updatesBefore = queueUpdates(h).length;

  const response = await configure(h, { sessionId: meta.id, systemPrompt: "three" });

  expect(response.error).toBeUndefined();
  const page = (await read(h, meta.id)).result as unknown as SessionReadResult;
  expect(page.queue.map((entry) => entry.content)).toEqual([
    [{ type: "text", text: "one" }],
    [{ type: "text", text: "three" }],
  ]);
  expect(page.queue).toHaveLength(2);
  expect(queueUpdates(h)).toHaveLength(updatesBefore + 1);
});

test("rejects an unknown session", async () => {
  const h = await openHarness();

  const response = await configure(h, { sessionId: "missing", systemPrompt: "x" });

  expect(response.error?.code).toBe("session.not_found");
});

test("rejects malformed params with protocol.invalid_request before mutating anything", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("hello")]);

  for (const params of [
    { systemPrompt: "x" },
    { sessionId: 5, systemPrompt: "x" },
    { sessionId: "bad id", systemPrompt: "x" },
    { sessionId: meta.id, model: 5, provider: "p" },
    { sessionId: meta.id, model: "m", provider: 5 },
    { sessionId: meta.id, systemPrompt: 5 },
  ]) {
    const response = await configure(h, params);
    expect(response.error?.code).toBe("protocol.invalid_request");
  }
  expect(await h.store.getMeta(meta.id)).toMatchObject({ model: "m", provider: "p" });
  expect(queueUpdates(h)).toEqual([]);
});

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineEvent, JsonValue, QueueEntryInput, SessionId } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import type { QueueEnqueueResult } from "../src/gateway/protocol.js";
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
  await mkdir(join(h.dataDir, ".pisces"), { recursive: true });
  await writeFile(
    join(h.dataDir, ".pisces", "config.json"),
    JSON.stringify({ extensions: ["pkg#tool"], defaultProvider: "p", defaultModel: "m" }),
    "utf8",
  );
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

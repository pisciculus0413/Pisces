import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntryName,
  JsonValue,
  NodeId,
  SessionId,
  SessionMeta,
  SessionNode,
} from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import type { SessionReadResult } from "../src/gateway/protocol.js";
import {
  createBootstrapRecoveryFixture,
  createGatewayHarness,
  draftDeclaration,
  draftQueueUser,
  draftUser,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./support/gateway-harness.js";

const NOW = "2026-11-08T05:00:00.000Z";
const ID = "s-fixed" as SessionId;
const OTHER = "s-other" as SessionId;
const open: GatewayHarness[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openHarness(options: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
  const harness = await createGatewayHarness({ newSessionId: () => ID, ...options });
  open.push(harness);
  return harness;
}

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pisces-workspace-"));
  workspaces.push(dir);
  return dir;
}

function read(harness: GatewayHarness, params: Record<string, unknown>) {
  return harness.gateway.handle({
    id: "read",
    method: "session.read",
    params: params as unknown as JsonValue,
  });
}

async function readPage(
  harness: GatewayHarness,
  params: Record<string, unknown>,
): Promise<SessionReadResult> {
  const response = await read(harness, params);
  if (response.error) throw new Error(`session.read failed: ${response.error.code}`);
  return response.result as unknown as SessionReadResult;
}

function createSession(harness: GatewayHarness, params: Record<string, unknown>) {
  return harness.gateway.handle({
    id: "create",
    method: "session.create",
    params: params as unknown as JsonValue,
  });
}

function at(nodes: readonly SessionNode[], index: number): SessionNode {
  const node = nodes[index];
  if (!node) throw new Error(`Missing seeded node ${index}`);
  return node;
}

const byteLength = (node: SessionNode) => new TextEncoder().encode(JSON.stringify(node)).length;

test("reads persisted records and returns queue and selection on the first page only", async () => {
  const h = await openHarness();
  const { meta, nodes } = await h.seed([draftUser("one"), draftUser("two"), draftUser("three")]);
  const first = await readPage(h, {
    sessionId: meta.id,
    limit: byteLength(at(nodes, 0)) + 8,
  });
  expect(first.meta).toEqual(meta);
  expect(first.records).toEqual([nodes[0]]);
  expect(first.queue).toEqual([]);
  expect(first.selection).toEqual([]);
  expect(first.nextCursor).toBe(at(nodes, 0).id);
  const second = await readPage(h, {
    sessionId: meta.id,
    limit: byteLength(at(nodes, 1)) + 8,
    cursor: first.nextCursor,
  });
  expect(second.records).toEqual([nodes[1]]);
  expect(second.queue).toEqual([]);
  expect(second.nextCursor).toBe(at(nodes, 1).id);
});

test("returns every node and no nextCursor when limit is omitted", async () => {
  const h = await openHarness();
  const { meta, nodes } = await h.seed([draftUser("one"), draftUser("two")]);

  const page = await readPage(h, { sessionId: meta.id });

  expect(page.records).toEqual(nodes);
  expect(page.nextCursor).toBeUndefined();
});

test("returns one node even when the limit is smaller than that node", async () => {
  const h = await openHarness();
  const { meta, nodes } = await h.seed([draftUser("one"), draftUser("two")]);

  const page = await readPage(h, { sessionId: meta.id, limit: 1 });

  expect(page.records).toEqual([nodes[0]]);
  expect(page.nextCursor).toBe(at(nodes, 0).id);
});

test("returns the root-to-node branch for nodeId", async () => {
  const h = await openHarness();
  const { meta, nodes } = await h.seed([draftUser("one"), draftUser("two"), draftUser("three")]);

  const page = await readPage(h, { sessionId: meta.id, nodeId: at(nodes, 1).id });

  expect(page.records).toEqual([nodes[0], nodes[1]]);
  expect(page.nextCursor).toBeUndefined();
});

test("reports an unknown nodeId or cursor as session.node_not_found", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("one")]);

  expect((await read(h, { sessionId: meta.id, nodeId: "nope" })).error?.code).toBe(
    "session.node_not_found",
  );
  expect((await read(h, { sessionId: meta.id, cursor: "nope" })).error?.code).toBe(
    "session.node_not_found",
  );
});

test("reports an unknown session as session.not_found", async () => {
  const h = await openHarness();

  expect((await read(h, { sessionId: "missing" })).error?.code).toBe("session.not_found");
});

test("reads a temporary session as an empty session with its queue", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness({ defaults: { workspace, provider: "p", model: "m" } });
  await h.gateway.handle({
    id: "create",
    method: "session.create",
    params: { systemPrompt: ["be brief"] } as unknown as JsonValue,
  });

  const page = await readPage(h, { sessionId: ID });

  expect(page.records).toEqual([]);
  expect(page.selection).toEqual([]);
  expect(page.queue).toMatchObject([
    {
      kind: "agent",
      role: "system",
      source: "create",
      content: [{ type: "text", text: "be brief" }],
    },
  ]);
  expect((await read(h, { sessionId: ID, nodeId: "missing" })).error?.code).toBe(
    "session.node_not_found",
  );
});

test("keeps runtime metadata intact when a read result is mutated", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("one")]);

  const page = await readPage(h, { sessionId: meta.id });
  page.meta.model = "mutated";
  expect(page.meta.model).toBe("mutated");

  const again = await readPage(h, { sessionId: meta.id });
  expect(again.meta).toEqual(meta);
  expect(await h.store.getMeta(meta.id)).toEqual(meta);
});

test("keeps runtime metadata intact when a create result is mutated", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness({ defaults: { workspace, provider: "p", model: "m" } });

  const created = await createSession(h, { systemPrompt: ["be brief"] });
  const meta = created.result as unknown as SessionMeta;
  const original = structuredClone(meta);
  meta.model = "mutated";
  meta.workspace = "/elsewhere";
  expect(meta.model).toBe("mutated");

  const page = await readPage(h, { sessionId: ID });
  expect(page.meta).toEqual(original);
  expect(await h.store.list()).toEqual([]);
});

test("shares one seq waterline across pages and repeated reads", async () => {
  const h = await openHarness();
  const { meta, nodes } = await h.seed([draftUser("one"), draftUser("two")]);

  const first = await readPage(h, { sessionId: meta.id, limit: 1 });
  expect(first.seq).toBe(0);
  const second = await readPage(h, { sessionId: meta.id, cursor: first.nextCursor });
  expect(second.seq).toBe(0);
  const again = await readPage(h, { sessionId: meta.id });
  expect(again.seq).toBe(0);
  expect(again.records).toEqual(nodes);
});

test("advances seq by exactly one per event of the same session", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const before = await readPage(h, { sessionId: meta.id });

  await h.gateway.handle({
    id: "enqueue",
    method: "queue.enqueue",
    params: { sessionId: meta.id, entries: [draftQueueUser("hello")] } as unknown as JsonValue,
  });
  const after = await readPage(h, { sessionId: meta.id });

  expect(after.seq).toBe(before.seq + 1);
  expect(after.queue).toMatchObject([
    { kind: "agent", role: "user", source: "test", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("does not advance this session's seq for another session's event", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("seed")]);
  const other: SessionMeta = {
    id: OTHER,
    model: "m",
    provider: "p",
    workspace: h.dataDir,
    createdAt: NOW,
    schemaVersion: 1,
  };
  await h.seed([draftUser("other")], other);
  const before = await readPage(h, { sessionId: meta.id });
  expect(before.seq).toBe(0);

  await h.gateway.handle({
    id: "enqueue",
    method: "queue.enqueue",
    params: { sessionId: OTHER, entries: [draftQueueUser("later")] } as unknown as JsonValue,
  });
  const after = await readPage(h, { sessionId: meta.id });

  expect(after.seq).toBe(0);
});

test("selects only declarations on the requested branch", async () => {
  const h = await openHarness();
  const { meta, nodes } = await h.seed([
    draftUser("one"),
    draftDeclaration(["pkg#tool" as EntryName]),
  ]);
  const fork: SessionNode = {
    ...draftUser("fork"),
    id: "fork-node" as NodeId,
    parentId: at(nodes, 0).id,
    createdAt: NOW,
    schemaVersion: 1,
  };
  await h.store.append(meta.id, [fork]);

  expect((await readPage(h, { sessionId: meta.id, nodeId: at(nodes, 1).id })).selection).toEqual([
    "pkg#tool",
  ]);
  expect((await readPage(h, { sessionId: meta.id, nodeId: fork.id })).selection).toEqual([]);
  expect((await readPage(h, { sessionId: meta.id })).selection).toEqual([]);
});

test("rejects a non-positive or fractional limit with protocol.invalid_request", async () => {
  const h = await openHarness();
  const { meta } = await h.seed([draftUser("one")]);

  for (const limit of [0, 1.5]) {
    const response = await read(h, { sessionId: meta.id, limit });
    expect(response.error?.code).toBe("protocol.invalid_request");
  }
});

test("restarts the per-session waterline and makes the next event seq 1", async () => {
  const { harness, sessionId } = await createBootstrapRecoveryFixture();
  open.push(harness);
  const first = await readPage(harness, { sessionId });
  expect(first.seq).toBe(0);
  expect(harness.events()).toEqual([]);
  await harness.gateway.handle({
    id: "2",
    method: "queue.enqueue",
    params: { sessionId, entries: [draftQueueUser("after restart")] } as unknown as JsonValue,
  });
  expect(harness.events().at(-1)).toMatchObject({ type: "queue.updated", seq: 1 });
  const second = await readPage(harness, { sessionId });
  expect(second.seq).toBe(1);
});

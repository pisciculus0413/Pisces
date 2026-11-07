import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContentBlock,
  createSessions,
  type EntryName,
  type JsonValue,
  type NodeId,
  type SessionId,
  type SessionMeta,
  type SessionNode,
} from "@pisces/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessionStore } from "../src/index.js";
import { sessionStoreIo as io } from "../src/session-store/session-store-io.js";

const time = "2026-11-06T13:00:00.000Z";
const sid = "s1" as SessionId;
const nid = (id: string) => id as NodeId;
const meta: SessionMeta = {
  id: sid,
  model: "m",
  provider: "p",
  workspace: "/workspace",
  createdAt: time,
  schemaVersion: 1,
};
const node = (id: string, parentId = id): SessionNode => ({
  id: nid(id),
  parentId: nid(parentId),
  kind: "agent",
  role: "user",
  content: [{ type: "text", text: "中文🐟" }],
  source: "create",
  createdAt: time,
  schemaVersion: 1,
});
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result = [];
  for await (const value of values) result.push(value);
  return result;
}
let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pisces-store-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

test("persists UTF-8 batches, branches and mutable metadata across restart", async () => {
  const store = createSessionStore({ dataDir });
  expect(await store.initialize()).toEqual([]);
  expect(await store.list()).toEqual([]);
  await expect(stat(join(dataDir, "sessions", sid))).rejects.toMatchObject({ code: "ENOENT" });
  await store.create(meta, [node("n1"), node("n2", "n1")]);
  await store.append(sid, [node("n3", "n2")]);
  await store.append(sid, [node("n4", "n1")]);
  const ids = async (values: AsyncIterable<SessionNode>) =>
    (await collect(values)).map((n) => n.id);
  expect(await ids(store.readTree(sid))).toEqual(["n1", "n2", "n3", "n4"]);
  expect(await ids(store.readBranch(sid))).toEqual(["n1", "n4"]);
  expect(await ids(store.readBranch(sid, nid("n3")))).toEqual(["n1", "n2", "n3"]);
  expect(await ids(store.readBranch(sid))).toEqual(["n1", "n4"]);
  const bytes = await readFile(join(dataDir, "sessions", sid, "events.jsonl"));
  expect(Number(await readFile(join(dataDir, "sessions", sid, "events.commit"), "utf8"))).toBe(
    bytes.byteLength,
  );
  expect(bytes.byteLength).toBeGreaterThan(bytes.toString().length);
  await store.updateMeta(sid, {
    ...meta,
    id: "ignored" as SessionId,
    workspace: "ignored",
    createdAt: "ignored",
    schemaVersion: 2,
    model: "m2",
    provider: "p2",
  });
  expect(await store.list()).toEqual([{ ...meta, model: "m2", provider: "p2" }]);
  const restarted = createSessionStore({ dataDir });
  expect(await restarted.initialize()).toEqual([]);
  expect(await collect(restarted.readTree(sid))).toEqual(await collect(store.readTree(sid)));
  expect(await ids(restarted.readBranch(sid))).toEqual(["n1", "n4"]);
  expect(await restarted.list()).toEqual(await store.list());
});

test("core Sessions persists generated nodes, default append and an explicit old branch", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  let number = 0;
  const sessions = createSessions({
    repository: store,
    newId: () => nid(`generated${++number}`),
    now: () => time,
  });
  const draft = {
    kind: "agent" as const,
    role: "user" as const,
    content: [{ type: "text" as const, text: "中文🐟" }],
    source: "create",
  };
  const initial = await sessions.create(meta, [draft, draft]);
  const appended = await sessions.append(sid, [draft]);
  const branch = await sessions.append(sid, [draft], initial[0]?.id);
  expect(await collect(sessions.readTree(sid))).toEqual([...initial, ...appended, ...branch]);
  expect(await collect(sessions.readBranch(sid))).toEqual([initial[0], ...branch]);
  expect(await collect(sessions.readBranch(sid, appended[0]?.id))).toEqual([
    ...initial,
    ...appended,
  ]);
  const restarted = createSessionStore({ dataDir });
  expect(await restarted.initialize()).toEqual([]);
  expect(await collect(restarted.readTree(sid))).toEqual(await collect(sessions.readTree(sid)));
  expect(await collect(restarted.readBranch(sid))).toEqual(await collect(sessions.readBranch(sid)));
  vi.spyOn(io, "rename").mockRejectedValueOnce(
    Object.assign(new Error("commit failed"), { code: "EIO" }),
  );
  await expect(sessions.append(sid, [draft, draft])).rejects.toMatchObject({ code: "storage.io" });
  expect(await collect(sessions.readTree(sid))).toEqual([...initial, ...appended, ...branch]);
});

test("an already started tree iterator keeps its committed snapshot across append", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  await store.create(meta, [node("n1"), node("n2", "n1")]);
  const iterator = store.readTree(sid)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(node("n1"));
  await store.append(sid, [node("n3", "n2")]);
  expect((await iterator.next()).value).toEqual(node("n2", "n1"));
  expect((await iterator.next()).done).toBe(true);
  expect(await collect(store.readTree(sid))).toEqual([
    node("n1"),
    node("n2", "n1"),
    node("n3", "n2"),
  ]);
});

test("indexed branch reads only its own UTF-8 lines and append does not rewrite old events", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  const nodes = [node("n1"), node("n2", "n1"), node("n3", "n2")];
  await store.create(meta, nodes);
  await store.append(sid, [node("n4", "n1")]);
  const readSpies: ReturnType<typeof vi.spyOn>[] = [];
  const originalOpen = io.open;
  vi.spyOn(io, "open").mockImplementation(async (...args) => {
    const file = await originalOpen(...args);
    if (args[0] === join(dataDir, "sessions", sid, "events.jsonl"))
      readSpies.push(vi.spyOn(file, "read"));
    return file;
  });
  const readFileSpy = vi.spyOn(io, "readFile");
  expect(await collect(store.readBranch(sid))).toEqual([node("n1"), node("n4", "n1")]);
  const ranges = readSpies.flatMap((spy) =>
    spy.mock.calls.map((call: unknown[]) => [call[3], call[2]]),
  );
  const lengths = [...nodes, node("n4", "n1")].map((value) =>
    Buffer.byteLength(`${JSON.stringify(value)}\n`),
  );
  expect(ranges).toEqual([
    [0, lengths[0]],
    [lengths.slice(0, 3).reduce((sum, length) => sum + length, 0), lengths[3]],
  ]);
  expect(readFileSpy).not.toHaveBeenCalled();
  const append = vi.spyOn(io, "appendSynced");
  const writes = vi.spyOn(io, "writeSynced");
  const before = await readFile(join(dataDir, "sessions", sid, "events.jsonl"));
  await store.append(sid, [node("n5", "n4")]);
  expect(append).toHaveBeenCalledExactlyOnceWith(
    join(dataDir, "sessions", sid, "events.jsonl"),
    Buffer.from(`${JSON.stringify(node("n5", "n4"))}\n`),
  );
  expect(writes.mock.calls.every(([target]) => target.endsWith("events.commit.tmp"))).toBe(true);
  expect(
    (await readFile(join(dataDir, "sessions", sid, "events.jsonl"))).subarray(0, before.length),
  ).toEqual(before);
});

const sparseContents: [string, ContentBlock[]][] = [
  ["top-level content", new Array<ContentBlock>(1)],
  [
    "toolResult content",
    [{ type: "toolResult", toolCallId: "call", content: new Array<ContentBlock>(1) }],
  ],
  [
    "toolCall arguments",
    [
      {
        type: "toolCall",
        id: "call",
        name: "tool" as EntryName,
        arguments: new Array<JsonValue>(1),
      },
    ],
  ],
  [
    "nested toolCall argument array",
    [
      {
        type: "toolCall",
        id: "call",
        name: "tool" as EntryName,
        arguments: { nested: [new Array<JsonValue>(1)] },
      },
    ],
  ],
];
for (const [label, content] of sparseContents) {
  test(`sparse ${label} is rejected before create or append changes files`, async () => {
    const store = createSessionStore({ dataDir });
    await store.initialize();
    await expect(store.create(meta, [{ ...node("n1"), content }])).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(stat(join(dataDir, "sessions", sid))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.list()).toEqual([]);
    await store.create(meta, [node("n1")]);
    const names = ["meta.json", "events.jsonl", "events.commit"];
    const saved = () =>
      Promise.all(names.map((name) => readFile(join(dataDir, "sessions", sid, name))));
    const before = await saved();
    await expect(store.append(sid, [{ ...node("n2", "n1"), content }])).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(await saved()).toEqual(before);
    const restarted = createSessionStore({ dataDir });
    expect(await restarted.initialize()).toEqual([]);
    expect(await collect(restarted.readTree(sid))).toEqual([node("n1")]);
  });
}

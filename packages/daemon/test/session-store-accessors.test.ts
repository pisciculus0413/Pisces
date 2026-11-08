import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeId, SessionId, SessionMeta, SessionNode } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSessionStore } from "../src/index.js";

const time = "2026-11-06T13:00:00.000Z";
const sid = "s1" as SessionId;
const meta: SessionMeta = {
  id: sid,
  model: "m",
  provider: "p",
  workspace: "/workspace",
  createdAt: time,
  schemaVersion: 1,
};
const node = (value: string, parent = value): SessionNode => ({
  id: value as NodeId,
  parentId: parent as NodeId,
  kind: "agent",
  role: "user",
  content: [{ type: "text", text: "中文🐟" }],
  source: "create",
  createdAt: time,
  schemaVersion: 1,
});
const ids = (nodes: SessionNode[]) => nodes.map((value) => value.id);
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result = [];
  for await (const value of values) result.push(value);
  return result;
}
let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pisces-accessors-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

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

test("metadata reads return a detached clone", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  await store.create(meta, [node("n1")]);
  const first = await store.getMeta(sid);
  first.model = "mutated";
  first.workspace = "/elsewhere";
  const second = await store.getMeta(sid);
  expect(second).toEqual(meta);
  expect(second).not.toBe(first);
});

test("missing sessions report session.not_found", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  await expect(store.getMeta(sid)).rejects.toMatchObject({ code: "session.not_found" });
  await expect(store.commitOffset(sid)).rejects.toMatchObject({ code: "session.not_found" });
  await expect(collect(store.readTreeSince(sid, 0))).rejects.toMatchObject({
    code: "session.not_found",
  });
});

test("a corrupt meta file reports storage.corrupt", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  await store.create(meta, [node("n1")]);
  await writeFile(join(dataDir, "sessions", sid, "meta.json"), "{");
  const restarted = createSessionStore({ dataDir });
  await restarted.initialize();
  await expect(restarted.getMeta(sid)).rejects.toMatchObject({ code: "storage.corrupt" });
});

test("reads before initialization throw TypeError", async () => {
  const store = createSessionStore({ dataDir });
  expect(() => store.readTreeSince(sid, 0)).toThrow(TypeError);
  await expect(store.getMeta(sid)).rejects.toThrow(TypeError);
  await expect(store.commitOffset(sid)).rejects.toThrow(TypeError);
});

test("an offset at the commit boundary yields nothing", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  await store.create(meta, [node("n1"), node("n2", "n1")]);
  expect(await collect(store.readTreeSince(sid, await store.commitOffset(sid)))).toEqual([]);
});

test("rejects invalid offsets synchronously", async () => {
  const store = createSessionStore({ dataDir });
  await store.initialize();
  await store.create(meta, [node("n1")]);
  expect(ids(await collect(store.readTreeSince(sid, 0)))).toEqual(["n1"]);
  for (const offset of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => store.readTreeSince(sid, offset)).toThrow(TypeError);
});

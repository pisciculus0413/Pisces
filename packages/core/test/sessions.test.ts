import { expect, test } from "vitest";
import {
  createSessions,
  type NodeId,
  type SessionId,
  type SessionMeta,
  type SessionNodeDraft,
} from "../src/index.js";
import { MemorySessionRepository } from "./support/memory-session-repository.js";

const meta: SessionMeta = {
  id: "s1" as SessionId,
  model: "m",
  provider: "p",
  workspace: "/workspace",
  createdAt: "2026-11-06T13:00:00.000Z",
  schemaVersion: 1,
};
const draft: SessionNodeDraft = {
  kind: "agent",
  role: "user",
  content: [{ type: "text", text: "hello" }],
  source: "create",
};
async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
function fixture() {
  const repository = new MemorySessionRepository();
  let id = 0;
  const sessions = createSessions({
    repository,
    newId: () => `n${++id}` as NodeId,
    now: () => meta.createdAt,
  });
  return { repository, sessions };
}
test("creates and appends an immutable ordered tree", async () => {
  const { sessions } = fixture();
  const first = await sessions.create(meta, [draft, draft]);
  const next = await sessions.append(meta.id, [draft, draft]);
  expect([...first, ...next].map((n) => [n.id, n.parentId])).toEqual([
    ["n1", "n1"],
    ["n2", "n1"],
    ["n3", "n2"],
    ["n4", "n3"],
  ]);
  expect(await collect(sessions.readTree(meta.id))).toEqual([...first, ...next]);
  expect(
    [...first, ...next].every((n) => n.createdAt === meta.createdAt && n.schemaVersion === 1),
  ).toBe(true);
});
test("branches follow the last append independently of reads", async () => {
  const { sessions } = fixture();
  await sessions.create(meta, [draft, draft, draft]);
  await sessions.append(meta.id, [draft], "n1" as NodeId);
  expect((await collect(sessions.readBranch(meta.id))).map((n) => n.id)).toEqual(["n1", "n4"]);
  expect((await collect(sessions.readBranch(meta.id, "n3" as NodeId))).map((n) => n.id)).toEqual([
    "n1",
    "n2",
    "n3",
  ]);
  expect((await sessions.append(meta.id, [draft]))[0]?.parentId).toBe("n4");
  await sessions.create({ ...meta, id: "s2" as SessionId }, [draft]);
  for (const id of ["missing", "n6"])
    await expect(sessions.append(meta.id, [draft], id as NodeId)).rejects.toMatchObject({
      code: "session.node_not_found",
    });
  expect((await collect(sessions.readTree(meta.id))).length).toBe(5);
  await expect(sessions.append("missing" as SessionId, [draft])).rejects.toMatchObject({
    code: "session.not_found",
  });
  await expect(collect(sessions.readBranch(meta.id, "missing" as NodeId))).rejects.toMatchObject({
    code: "session.node_not_found",
  });
});
test("empty batches consume no dependencies", async () => {
  const sessions = createSessions({
    repository: new Proxy({} as never, {
      get() {
        throw new Error("repository used");
      },
    }),
    newId() {
      throw new Error("id used");
    },
    now() {
      throw new Error("clock used");
    },
  });
  await expect(sessions.create(meta, [])).rejects.toBeInstanceOf(TypeError);
  await expect(sessions.append(meta.id, [])).rejects.toBeInstanceOf(TypeError);
});
test("failed writes preserve committed snapshots and original errors", async () => {
  const { sessions, repository } = fixture();
  const error = new Error("write failed");
  repository.failNextWrite("create", error);
  await expect(sessions.create(meta, [draft, draft])).rejects.toBe(error);
  expect(await sessions.list()).toEqual([]);
  await expect(collect(sessions.readTree(meta.id))).rejects.toMatchObject({
    code: "session.not_found",
  });
  await sessions.create(meta, [draft, draft]);
  const snapshot = await collect(sessions.readTree(meta.id));
  repository.failNextWrite("append", error);
  await expect(sessions.append(meta.id, [draft, draft])).rejects.toBe(error);
  expect(await collect(sessions.readTree(meta.id))).toEqual(snapshot);
  expect(await collect(sessions.readBranch(meta.id))).toEqual(snapshot);
  expect((await sessions.append(meta.id, [draft]))[0]?.parentId).toBe(snapshot.at(-1)?.id);
  repository.failNextWrite("updateMeta", error);
  await expect(sessions.updateMeta(meta.id, { ...meta, model: "new" })).rejects.toBe(error);
  expect(await sessions.list()).toEqual([meta]);
  await sessions.updateMeta(meta.id, {
    ...meta,
    id: "other" as SessionId,
    workspace: "other",
    createdAt: "other",
    schemaVersion: 99,
    model: "new",
    provider: "new",
  });
  expect(await sessions.list()).toEqual([{ ...meta, model: "new", provider: "new" }]);
  const tree = await collect(sessions.readTree(meta.id));
  if (tree[0]) tree[0].content.length = 0;
  const list = await sessions.list();
  if (list[0]) list[0].workspace = "changed";
  expect((await collect(sessions.readTree(meta.id)))[0]?.content).toEqual(draft.content);
  expect((await sessions.list())[0]?.workspace).toBe(meta.workspace);
  await expect(sessions.create(meta, [draft])).rejects.toBeInstanceOf(TypeError);
});
test("read iterables and delegate promises preserve identity", async () => {
  const { repository } = fixture();
  const error = new Error("read");
  const iterable = {
    async *[Symbol.asyncIterator]() {
      yield {} as never;
      throw error;
    },
  };
  const list = Promise.resolve([meta]);
  const updated = Promise.resolve();
  repository.readTree = () => iterable;
  repository.readBranch = () => iterable;
  repository.list = () => list;
  repository.updateMeta = () => updated;
  const sessions = createSessions({ repository, newId: () => "unused" as NodeId, now: () => "" });
  expect(sessions.readTree(meta.id)).toBe(iterable);
  expect(sessions.readBranch(meta.id)).toBe(iterable);
  await expect(collect(sessions.readTree(meta.id))).rejects.toBe(error);
  expect(sessions.list()).toBe(list);
  expect(sessions.updateMeta(meta.id, meta)).toBe(updated);
});
test("an existing session with an empty branch is corrupt", async () => {
  const { repository } = fixture();
  repository.readBranch = () => ({ async *[Symbol.asyncIterator]() {} });
  const sessions = createSessions({
    repository,
    newId() {
      throw new Error("id used");
    },
    now() {
      throw new Error("clock used");
    },
  });
  await expect(sessions.append(meta.id, [draft])).rejects.toMatchObject({
    code: "storage.corrupt",
  });
});

// Validator must see real generated fields and run before the repository write.
test.each([false, true])(
  "write validation rejects atomically with actual nodes (append=%s)",
  async (append) => {
    const { sessions, repository } = fixture();
    if (append) await sessions.create(meta, [draft]);
    const error = new Error("rejected");
    let checked = false;
    const options = {
      validate(nodes: readonly import("../src/index.js").SessionNode[]) {
        checked = true;
        expect(nodes.map((node) => [node.id, node.parentId])).toEqual(
          append
            ? [
                ["n2", "n1"],
                ["n3", "n2"],
              ]
            : [
                ["n1", "n1"],
                ["n2", "n1"],
              ],
        );
        expect(nodes[0]?.createdAt).toBe(meta.createdAt);
        throw error;
      },
    };
    await expect(
      append
        ? sessions.append(meta.id, [draft, draft], undefined, options)
        : sessions.create(meta, [draft, draft], options),
    ).rejects.toBe(error);
    expect(checked).toBe(true);
    expect(
      append ? await collect(repository.readTree(meta.id)) : await sessions.list(),
    ).toHaveLength(append ? 1 : 0);
  },
);

test.each([false, true])(
  "write validator receives an isolated copy (append=%s)",
  async (append) => {
    const { sessions } = fixture();
    if (append) await sessions.create(meta, [draft]);
    let checked = false;
    const options = {
      validate(nodes: readonly import("../src/index.js").SessionNode[]) {
        checked = true;
        if (nodes[0]) {
          nodes[0].content.length = 0;
          nodes[0].id = "changed" as NodeId;
        }
      },
    };
    const nodes = await (append
      ? sessions.append(meta.id, [draft], undefined, options)
      : sessions.create(meta, [draft], options));
    expect(checked).toBe(true);
    expect(nodes[0]?.content).toEqual(draft.content);
    expect(nodes[0]?.id).toBe(append ? "n2" : "n1");
    expect(await collect(sessions.readTree(meta.id))).toContainEqual(nodes[0]);
  },
);

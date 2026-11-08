import { expect, test } from "vitest";
import type {
  ContentBlock,
  DefinitionSnapshot,
  EntryName,
  QueueEntryId,
  QueueEntryInput,
} from "../src/index.js";
import {
  collect,
  createContextHarness,
  declaration,
  gate,
  META,
} from "./support/context-harness.js";

const OPTIONS = { contextWindow: 100000, maxOutput: 0 };
const name = (value: string) => `pkg#${value}` as EntryName;
const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];
const user = (value = "hello"): QueueEntryInput => ({
  kind: "agent",
  role: "user",
  source: "user",
  content: text(value),
});
const instruction = (value: string): QueueEntryInput => ({
  kind: "agent",
  role: "system",
  source: "instruction",
  content: text(value),
});
const definition = (description: string): DefinitionSnapshot => ({
  name: name("tool"),
  kind: "tool",
  description,
  parameters: {},
  definitionHash: description,
});

async function enqueue(h: ReturnType<typeof createContextHarness>, entries: QueueEntryInput[]) {
  return h.runExclusive(async () => {
    const ids = h.context.enqueue(entries);
    h.context.confirm();
    return ids;
  });
}

function gatedSource(persisted = false) {
  const entered = gate();
  const release = gate();
  const h = createContextHarness({
    persisted,
    entries: { kind: (entry) => (entry === name("tool") ? "tool" : "context") },
    sources: {
      get: (entry) => ({
        id: entry,
        resolve: async () => {
          expect(h.isLocked()).toBe(false);
          entered.release();
          await release.promise;
          return [{ source: "ignored", content: text(entry) }];
        },
      }),
    },
  });
  return { h, entered, release };
}

// Catches missing create, queue consumption, explicit parent and history-only return paths.
test("creates a user-only session, excludes pending entries and skips empty append", async () => {
  const h = createContextHarness();
  await enqueue(h, [user()]);
  await h.runExclusive(async () => {
    h.context.enqueue([user("pending")]);
  });
  const result = await h.context.assemble(OPTIONS);
  expect(result.first).toBe(true);
  expect(result.request).toEqual({
    model: "model",
    messages: [{ role: "user", content: text("hello") }],
  });
  expect(result.nodes.map((node) => node.id)).toEqual(["n1"]);
  expect(result.headId).toBe("n1");
  expect(h.context.snapshot().queue.map((entry) => entry.id)).toEqual(["q2"]);
  expect(h.events.map((event) => event.type)).toEqual([
    "queue.updated",
    "queue.updated",
    "queue.updated",
    "session.updated",
    "queue.updated",
  ]);
  const seq = h.context.snapshot().seq;
  const next = await h.context.assemble(OPTIONS);
  expect(next).toEqual({ ...result, first: false, nodes: [] });
  expect(h.context.snapshot().seq).toBe(seq);
  expect(await collect(h.sessions.readTree(META.id))).toHaveLength(1);
});

test.each([{ entries: [] }, { entries: [declaration({ toggle: [] })] }])(
  "rejects empty visible sequence $entries before create",
  async ({ entries }) => {
    const h = createContextHarness();
    await enqueue(h, entries);
    const before = h.context.snapshot();
    await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({ code: "turn.empty" });
    expect(h.context.snapshot()).toEqual(before);
    expect(await h.sessions.list()).toEqual([]);
  },
);

test.each(["create", "instruction"])("allows first system message from %s", async (source) => {
  const h = createContextHarness();
  await enqueue(h, [{ ...instruction("system"), source }]);
  expect((await h.context.assemble(OPTIONS)).request.messages).toEqual([
    { role: "system", content: text("system") },
  ]);
});

test("source-only and skill-only selected content are valid first messages", async () => {
  for (const kind of ["context", "skill"] as const) {
    const h = createContextHarness({
      entries: { kind: () => kind },
      sources: {
        get: (entry) => ({
          id: entry,
          resolve: async () => [{ source: "description", content: text("source") }],
        }),
      },
      skills: {
        selected: () => [{ name: name("entry"), source: "description", content: text("skill") }],
      },
    });
    await enqueue(h, [declaration({ toggle: [name("entry")] })]);
    const result = await h.context.assemble(OPTIONS);
    expect(result.request.messages).toEqual([
      { role: "system", content: text(kind === "context" ? "source" : "skill") },
    ]);
    expect(result.nodes.map((node) => node.role)).toEqual(["system", "declaration"]);
    expect(result.headId).toBe(result.nodes[1]?.id);
    expect(h.context.snapshot().selection).toEqual(["pkg#entry"]);
  }
});

test("appends to explicit old parent with that branch's frozen definitions; default tracks last append", async () => {
  const h = createContextHarness({ entries: { kind: () => "tool" } });
  await enqueue(h, [
    user("root"),
    declaration({ toggle: [name("tool")], definitions: [definition("old")] }),
  ]);
  const root = await h.context.assemble(OPTIONS);
  await enqueue(h, [user("sibling"), declaration({ toggle: [name("tool")] })]);
  const sibling = await h.context.assemble(OPTIONS);
  expect(sibling.request.tools).toBeUndefined();
  await enqueue(h, [user("branch")]);
  const branch = await h.context.assemble({ ...OPTIONS, nodeId: root.headId });
  expect(branch.nodes[0]?.parentId).toBe(root.headId);
  expect(h.context.snapshot().selection).toEqual([name("tool")]);
  expect(await h.context.selectionFor()).toEqual([name("tool")]);
  expect(branch.request.tools).toEqual([{ name: "pkg#tool", description: "old", parameters: {} }]);
  expect(branch.request.messages.map((message) => message.content)).toEqual([
    text("root"),
    text("branch"),
  ]);
  expect((await h.context.assemble(OPTIONS)).headId).toBe(branch.headId);
  expect(
    (await h.context.assemble({ ...OPTIONS, nodeId: sibling.headId })).request.messages.map(
      (message) => message.content,
    ),
  ).toEqual([text("root"), text("sibling")]);
});

// Empty historical reads must not replace the default branch's persisted selection.
test("reading an enabled old branch without nodes preserves the disabled default", async () => {
  const h = createContextHarness({ entries: { kind: () => "tool" } });
  await enqueue(h, [
    user("root"),
    declaration({ toggle: [name("tool")], definitions: [definition("old")] }),
  ]);
  const old = await h.context.assemble(OPTIONS);
  await enqueue(h, [declaration({ toggle: [name("tool")] })]);
  const latest = await h.context.assemble(OPTIONS);
  const before = h.context.snapshot();
  const tree = await collect(h.repository.readTree(META.id));
  const eventCount = h.events.length;
  const result = await h.context.assemble({ ...OPTIONS, nodeId: old.headId });
  expect(result.nodes).toEqual([]);
  expect(result.headId).toBe(old.headId);
  expect(result.selection).toEqual([name("tool")]);
  expect(result.request.tools).toEqual([{ name: "pkg#tool", description: "old", parameters: {} }]);
  expect(result.request.messages).toEqual([{ role: "user", content: text("root") }]);
  expect(h.context.snapshot()).toEqual(before);
  expect(h.events).toHaveLength(eventCount);
  expect(await h.context.selectionFor()).toEqual([]);
  expect(await collect(h.repository.readTree(META.id))).toEqual(tree);
  expect((await collect(h.repository.readBranch(META.id))).at(-1)?.id).toBe(latest.headId);
});

test("compaction alone on an old branch advances the default selection", async () => {
  const h = createContextHarness({ entries: { kind: () => "tool" } });
  await enqueue(h, [
    declaration({ toggle: [name("tool")], definitions: [definition("old")] }),
    user("x".repeat(1200)),
    user("y".repeat(2400)),
  ]);
  const old = await h.context.assemble(OPTIONS);
  await enqueue(h, [declaration({ toggle: [name("tool")] })]);
  await h.context.assemble(OPTIONS);
  const start = h.events.length;
  const result = await h.context.assemble({
    contextWindow: 1024,
    maxOutput: 0,
    nodeId: old.headId,
  });
  expect(result.nodes.map((node) => node.role)).toEqual(["compaction"]);
  expect(result.nodes[0]?.parentId).toBe(old.headId);
  expect(h.context.snapshot().selection).toEqual([name("tool")]);
  expect(await h.context.selectionFor()).toEqual([name("tool")]);
  expect((await collect(h.repository.readBranch(META.id))).at(-1)?.id).toBe(result.headId);
  expect(h.events.slice(start).map((event) => event.type)).toEqual([
    "session.updated",
    "selection.updated",
  ]);
});

test("explicit parent in a temporary session fails without creating", async () => {
  const h = createContextHarness();
  await enqueue(h, [user()]);
  await expect(
    h.context.assemble({ ...OPTIONS, nodeId: "missing" as import("../src/index.js").NodeId }),
  ).rejects.toMatchObject({ code: "session.node_not_found" });
  expect(await h.sessions.list()).toEqual([]);
});

// Catches using B's drafts, budget or protected instruction after a concurrent delete.
test.each(["user", "instruction"])(
  "rebuilds request and budget after removing huge %s while resolving",
  async (role) => {
    const { h, entered, release } = gatedSource();
    const [id] = await enqueue(h, [
      role === "instruction" ? instruction("x".repeat(10000)) : user("x".repeat(10000)),
      declaration({ toggle: [name("source")] }),
    ]);
    const pending = h.context.assemble({ contextWindow: 1024, maxOutput: 0 });
    await entered.promise;
    await h.runExclusive(async () => {
      h.context.remove(id as QueueEntryId);
    });
    release.release();
    const result = await pending;
    expect(result.nodes.map((node) => node.source)).toEqual(["pkg#source", "user"]);
    expect(result.request.messages).toEqual([{ role: "system", content: text("pkg#source") }]);
    expect(h.context.snapshot().queue).toEqual([]);
  },
);

test("recomputes compaction thresholds from survivors instead of B's larger batch", async () => {
  const { h, entered, release } = gatedSource(true);
  await h.sessions.create(META, [user("x".repeat(1500))]);
  const [id] = await enqueue(h, [
    user("x".repeat(300)),
    instruction("i".repeat(1300)),
    declaration({ toggle: [name("source")] }),
  ]);
  const pending = h.context.assemble({ contextWindow: 1024, maxOutput: 0 });
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.remove(id as QueueEntryId);
  });
  release.release();
  const result = await pending;
  expect(result.nodes.some((node) => node.role === "compaction")).toBe(false);
  expect(result.request.messages.map((message) => message.content)).toEqual([
    text("x".repeat(1500)),
    text("pkg#source"),
    text("i".repeat(1300)),
  ]);
});

test("persists compactions with drafts and advances head to the batch end", async () => {
  const h = createContextHarness({ persisted: true });
  const [old] = await h.sessions.create(META, [user("x".repeat(3000))]);
  await enqueue(h, [instruction("i".repeat(2200))]);
  const result = await h.context.assemble({ contextWindow: 1024, maxOutput: 0 });
  expect(result.nodes.map((node) => node.role).sort()).toEqual(["compaction", "system"]);
  expect(result.nodes[0]?.parentId).toBe(old?.id);
  expect(result.headId).toBe(result.nodes.at(-1)?.id);
  expect(
    result.request.messages.some(
      (message) =>
        message.content[0]?.type === "text" && message.content[0].text.startsWith("[compaction]"),
    ),
  ).toBe(true);
  expect(await collect(h.sessions.readTree(META.id))).toHaveLength(3);
});

// Catches stale source results and expansion of the frozen first window during a retry.
test("retries changed selection once and excludes later confirmed entries", async () => {
  const { h, entered, release } = gatedSource();
  const [q1] = await enqueue(h, [declaration({ toggle: [name("source")] }), user("original")]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.remove(q1 as QueueEntryId);
    h.context.enqueue([user("later")]);
    h.context.confirm();
  });
  release.release();
  const result = await pending;
  expect(result.request.messages).toEqual([{ role: "user", content: text("original") }]);
  expect(result.selection).toEqual([]);
  expect(result.nodes.map((node) => node.source)).toEqual(["user"]);
  expect(h.context.snapshot().queue.map((entry) => entry.content)).toEqual([text("later")]);
});

test("a retry can resolve newly selected sources, but never retain discarded old fragments", async () => {
  const { h, entered, release } = gatedSource();
  const [q1] = await enqueue(h, [
    declaration({ toggle: [name("a"), name("b")] }),
    declaration({ toggle: [name("a")] }),
    user(),
  ]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.remove(q1 as QueueEntryId);
  });
  release.release();
  const result = await pending;
  expect(result.selection).toEqual(["pkg#a"]);
  expect(result.request.messages.map((message) => message.content)).toEqual([
    text("pkg#a"),
    text("hello"),
  ]);
  expect(result.nodes.map((node) => node.source)).toEqual(["pkg#a", "user", "user"]);
});

test("rejects a second selection change without writing or consuming survivors", async () => {
  const first = gate();
  const second = gate();
  const release1 = gate();
  const release2 = gate();
  let calls = 0;
  const h = createContextHarness({
    entries: { kind: () => "context" },
    sources: {
      get: (entry) => ({
        id: entry,
        resolve: async () => {
          if (++calls === 1) {
            first.release();
            await release1.promise;
          } else {
            second.release();
            await release2.promise;
          }
          return [{ source: "ignored", content: text(entry) }];
        },
      }),
    },
  });
  const [q1, q2] = await enqueue(h, [
    declaration({ toggle: [name("a"), name("b")] }),
    declaration({ toggle: [name("a")] }),
    user(),
  ]);
  const pending = h.context.assemble(OPTIONS);
  await first.promise;
  await h.runExclusive(async () => {
    h.context.remove(q1 as QueueEntryId);
  });
  release1.release();
  await second.promise;
  await h.runExclusive(async () => {
    h.context.remove(q2 as QueueEntryId);
  });
  const before = h.context.snapshot();
  release2.release();
  await expect(pending).rejects.toMatchObject({
    code: "context.changed",
    data: { retryable: true },
  });
  expect(h.context.snapshot()).toEqual(before);
  expect(await h.sessions.list()).toEqual([]);
});

test("same-millisecond unconfirm, edit and reconfirm excludes old ids", async () => {
  const { h, entered, release } = gatedSource(true);
  await h.sessions.create(META, [user("history"), declaration({ toggle: [name("source")] })]);
  const [id] = await enqueue(h, [user("before")]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.unconfirm();
    h.context.edit(id as QueueEntryId, text("after"));
    h.context.confirm();
  });
  release.release();
  const result = await pending;
  expect(result.request.messages.map((message) => message.content)).toEqual([
    text("history"),
    text("pkg#source"),
  ]);
  expect(result.nodes.map((node) => node.source)).toEqual(["pkg#source"]);
  expect(h.context.snapshot().queue[0]?.content).toEqual(text("after"));
});

test("definition-only deletion rebuilds tools without resolving under the lock", async () => {
  const { h, entered, release } = gatedSource(true);
  await h.sessions.create(META, [
    user("history"),
    declaration({ toggle: [name("source"), name("tool")], definitions: [definition("old")] }),
  ]);
  const [id] = await enqueue(h, [declaration({ toggle: [], definitions: [definition("new")] })]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.remove(id as QueueEntryId);
  });
  release.release();
  expect((await pending).request.tools).toEqual([
    { name: "pkg#tool", description: "old", parameters: {} },
  ]);
});

test.each([false, true])(
  "head changes retry only default branches (explicit=%s)",
  async (explicit) => {
    const { h, entered, release } = gatedSource(true);
    const [root] = await h.sessions.create(META, [user("root")]);
    await enqueue(h, [declaration({ toggle: [name("source")] }), user("queued")]);
    const pending = h.context.assemble({
      ...OPTIONS,
      ...(explicit && root ? { nodeId: root.id } : {}),
    });
    await entered.promise;
    const [other] = await h.runExclusive(async () =>
      h.sessions.append(
        META.id,
        [user("writer"), { ...instruction("reused"), source: "pkg#source" }],
        root?.id,
      ),
    );
    release.release();
    const result = await pending;
    expect(result.nodes[0]?.parentId).toBe(explicit ? root?.id : "n3");
    expect(result.request.messages.map((message) => message.content)).toEqual(
      explicit
        ? [text("root"), text("pkg#source"), text("queued")]
        : [text("root"), text("writer"), text("reused"), text("queued")],
    );
    expect(other?.parentId).toBe(root?.id);
    expect(result.nodes.filter((node) => node.source === "pkg#source")).toHaveLength(
      explicit ? 1 : 0,
    );
  },
);

test("reads latest metadata in C while preserving the queue", async () => {
  const { h, entered, release } = gatedSource();
  await enqueue(h, [declaration({ toggle: [name("source")] }), user()]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.updateMeta({ ...META, model: "m2" });
  });
  release.release();
  const result = await pending;
  expect(result.request.model).toBe("m2");
  expect(result.request.messages.at(-1)?.content).toEqual(text("hello"));
});

test("aborted before A leaves queue, seq and storage untouched", async () => {
  const h = createContextHarness();
  await enqueue(h, [user()]);
  const before = h.context.snapshot();
  const signal = AbortSignal.abort({ reason: "before" });
  await expect(h.context.assemble({ ...OPTIONS, signal })).rejects.toBe(signal.reason);
  expect(h.context.snapshot()).toEqual(before);
  expect(await h.sessions.list()).toEqual([]);
});

test.each([false, true])(
  "abort during resolver stops commit even if resolver ignores signal (%s)",
  async (rejects) => {
    const { h, entered, release } = gatedSource();
    const controller = new AbortController();
    const reason = { cancelled: true };
    if (rejects)
      h.deps.sources.get = (entry) => ({
        id: entry,
        resolve: async ({ signal }) => {
          entered.release();
          await new Promise<void>((_, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
          return [];
        },
      });
    await enqueue(h, [declaration({ toggle: [name("source")] }), user()]);
    const pending = h.context.assemble({ ...OPTIONS, signal: controller.signal });
    await entered.promise;
    await h.runExclusive(async () => {
      controller.abort(reason);
      h.context.unconfirm();
    });
    const before = h.context.snapshot();
    release.release();
    await expect(pending).rejects.toBe(reason);
    expect(h.context.snapshot()).toEqual(before);
    expect(await h.sessions.list()).toEqual([]);
  },
);

test("abort while C waits for the lock prevents writing", async () => {
  const { h, entered, release } = gatedSource();
  const controller = new AbortController();
  const cRequested = gate();
  const runExclusive = h.deps.runExclusive;
  let acquisitions = 0;
  h.deps.runExclusive = async (task) => {
    if (++acquisitions === 2) cRequested.release();
    return runExclusive(task);
  };
  await enqueue(h, [declaration({ toggle: [name("source")] }), user()]);
  const pending = h.context.assemble({ ...OPTIONS, signal: controller.signal });
  await entered.promise;
  const held = gate();
  const unlock = gate();
  const holder = h.runExclusive(async () => {
    held.release();
    await unlock.promise;
    controller.abort("waiting");
    h.context.unconfirm();
  });
  await held.promise;
  release.release();
  await cRequested.promise;
  unlock.release();
  await holder;
  const before = h.context.snapshot();
  await expect(pending).rejects.toBe("waiting");
  expect(h.context.snapshot()).toEqual(before);
  expect(await h.sessions.list()).toEqual([]);
});

test("abort after append begins retains successful commit and consumption", async () => {
  const h = createContextHarness();
  await enqueue(h, [user("first")]);
  await h.context.assemble(OPTIONS);
  await enqueue(h, [user("second")]);
  const entered = gate();
  const release = gate();
  const append = h.deps.sessions.append;
  h.deps.sessions.append = async (...args) => {
    entered.release();
    await release.promise;
    return append(...args);
  };
  const controller = new AbortController();
  const pending = h.context.assemble({ ...OPTIONS, signal: controller.signal });
  await entered.promise;
  controller.abort("too late");
  release.release();
  const result = await pending;
  expect(result.nodes.map((node) => node.content)).toEqual([text("second")]);
  expect(h.context.snapshot().queue).toEqual([]);
  expect(await collect(h.sessions.readTree(META.id))).toHaveLength(2);
});

test("create, append and event clock allocation run inside the injected lock", async () => {
  const h = createContextHarness();
  const create = h.deps.sessions.create;
  const append = h.deps.sessions.append;
  h.deps.sessions.create = async (...args) => {
    expect(h.isLocked()).toBe(true);
    return create(...args);
  };
  h.deps.sessions.append = async (...args) => {
    expect(h.isLocked()).toBe(true);
    return append(...args);
  };
  const next = h.deps.eventClock.next;
  h.deps.eventClock.next = () => {
    expect(h.isLocked()).toBe(true);
    return next();
  };
  await enqueue(h, [user("first")]);
  await h.context.assemble(OPTIONS);
  await enqueue(h, [user("next")]);
  await h.context.assemble(OPTIONS);
  expect(h.context.snapshot().queue).toEqual([]);
});

test("simultaneous assembly consumes each queue and source only once", async () => {
  const { h, entered, release } = gatedSource();
  await enqueue(h, [declaration({ toggle: [name("source")] }), user()]);
  const a = h.context.assemble(OPTIONS);
  const b = h.context.assemble(OPTIONS);
  await entered.promise;
  release.release();
  const results = await Promise.all([a, b]);
  expect(results.map((result) => result.nodes.length).sort()).toEqual([0, 3]);
  expect(await collect(h.sessions.readTree(META.id))).toHaveLength(3);
  expect(h.context.snapshot().queue).toEqual([]);
});

test("independent Context instances do not share locks", async () => {
  const { h, entered, release } = gatedSource();
  await enqueue(h, [declaration({ toggle: [name("source")] })]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  const other = createContextHarness();
  await enqueue(other, [user("other")]);
  expect((await other.context.assemble(OPTIONS)).nodes).toHaveLength(1);
  release.release();
  await pending;
});

test("precommit write failure retains confirmed entries and emits no commit events", async () => {
  const h = createContextHarness();
  await enqueue(h, [user()]);
  const before = h.context.snapshot();
  const error = new Error("write failed");
  h.failNextWrite(error);
  await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
  expect(h.context.snapshot()).toEqual(before);
  expect(await h.sessions.list()).toEqual([]);
  expect((await h.context.assemble(OPTIONS)).nodes).toHaveLength(1);
});

test("a second default-head change fails without writing or consuming the original batch", async () => {
  const entered = [gate(), gate()];
  const releases = [gate(), gate()];
  let calls = 0;
  const h = createContextHarness({
    persisted: true,
    entries: { kind: () => "context" },
    sources: {
      get: (entry) => ({
        id: entry,
        resolve: async () => {
          const index = calls++;
          entered[index]?.release();
          await releases[index]?.promise;
          return [{ source: "ignored", content: text("resolved") }];
        },
      }),
    },
  });
  await h.sessions.create(META, [user("root")]);
  await enqueue(h, [declaration({ toggle: [name("source")] }), user("queued")]);
  const pending = h.context.assemble(OPTIONS);
  await entered[0]?.promise;
  await h.runExclusive(async () => {
    await h.sessions.append(META.id, [user("writer1")]);
  });
  releases[0]?.release();
  await entered[1]?.promise;
  await h.runExclusive(async () => {
    await h.sessions.append(META.id, [user("writer2")]);
  });
  const before = h.context.snapshot();
  releases[1]?.release();
  await expect(pending).rejects.toMatchObject({
    code: "context.changed",
    data: { retryable: true },
  });
  expect(h.context.snapshot()).toEqual(before);
  expect((await collect(h.sessions.readTree(META.id))).map((node) => node.content)).toEqual([
    text("root"),
    text("writer1"),
    text("writer2"),
  ]);
});

test("a retry never recaptures same-millisecond reconfirmed original entries or later entries", async () => {
  const { h, entered, release } = gatedSource(true);
  await h.sessions.create(META, [user("history")]);
  const [q1, q2] = await enqueue(h, [declaration({ toggle: [name("source")] }), user("before")]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.remove(q1 as QueueEntryId);
    h.context.unconfirm();
    h.context.edit(q2 as QueueEntryId, text("after"));
    h.context.enqueue([user("later")]);
    h.context.confirm();
  });
  release.release();
  const result = await pending;
  expect(result.nodes).toEqual([]);
  expect(result.request.messages).toEqual([{ role: "user", content: text("history") }]);
  expect(h.context.snapshot().queue.map((entry) => entry.content)).toEqual([
    text("after"),
    text("later"),
  ]);
});

test("normal commit state is complete before an event callback throws", async () => {
  const h = createContextHarness();
  await enqueue(h, [user()]);
  const error = new Error("subscriber failed");
  h.deps.events.publish = (event) => {
    if (event.type === "session.updated") {
      expect(h.context.snapshot().queue).toEqual([]);
      throw error;
    }
  };
  await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
  expect(h.context.snapshot().queue).toEqual([]);
  expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
  expect(await collect(h.sessions.readTree(META.id))).toHaveLength(1);
});

test("first reports persistence at invocation even when A waits behind another commit", async () => {
  const h = createContextHarness();
  await enqueue(h, [user()]);
  const entered = gate();
  const release = gate();
  const create = h.deps.sessions.create;
  h.deps.sessions.create = async (...args) => {
    entered.release();
    await release.promise;
    return create(...args);
  };
  const first = h.context.assemble(OPTIONS);
  await entered.promise;
  const waiting = h.context.assemble(OPTIONS);
  release.release();
  expect((await first).first).toBe(true);
  const result = await waiting;
  expect(result.first).toBe(true);
  expect(result.nodes).toEqual([]);
});

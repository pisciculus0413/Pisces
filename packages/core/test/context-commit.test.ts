import { expect, test, vi } from "vitest";
import { createContextEvents } from "../src/context/events.js";
import {
  type ContextEvent,
  type EntryName,
  type NodeId,
  PiscesError,
  type QueueEntryId,
  type QueueEntryInput,
} from "../src/index.js";
import { collect, createContextHarness, declaration, META } from "./support/context-harness.js";

const OPTIONS = { contextWindow: 10000000, maxOutput: 0 };
const user = (value = "hello"): QueueEntryInput => ({
  kind: "agent",
  role: "user",
  source: "user",
  content: [{ type: "text", text: value }],
});
type Harness = ReturnType<typeof createContextHarness>;
async function enqueue(h: Harness, entries = [user()]) {
  return h.runExclusive(async () => {
    const ids = h.context.enqueue(entries);
    h.context.confirm();
    return ids;
  });
}
const io = () => new PiscesError("storage.io", "uncertain write");

// Fails if storage.io skips factual reconciliation or consumes absent drafts.
test.each([false, true])(
  "precommit failure reconciles absent and safely retries (append=%s)",
  async (append) => {
    const h = createContextHarness();
    if (append) {
      await enqueue(h);
      await h.context.assemble(OPTIONS);
    }
    await enqueue(h, [user("next")]);
    const before = h.context.snapshot();
    const read = vi.spyOn(h.sessions, "readTree");
    const error = io();
    h.failNextWrite(error);
    await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.context.snapshot()).toEqual(before);
    expect((await h.context.assemble(OPTIONS)).nodes).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  },
);

// Fails if a committed batch is retried or an old sibling is mistaken for the suffix.
test.each([false, true])(
  "postcommit failure completes state and events exactly once (append=%s)",
  async (append) => {
    const h = createContextHarness();
    let parent: NodeId | undefined;
    if (append) {
      await enqueue(h, [user("root")]);
      parent = (await h.context.assemble(OPTIONS)).headId;
      await enqueue(h);
      await h.context.assemble(OPTIONS);
    }
    await enqueue(h);
    const error = io();
    h.failNextWriteAfterCommit(error);
    const read = vi.spyOn(h.sessions, "readTree");
    const start = h.events.length;
    await expect(
      h.context.assemble({ ...OPTIONS, ...(parent ? { nodeId: parent } : {}) }),
    ).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.context.snapshot().queue).toEqual([]);
    expect(h.events.slice(start).map((e) => e.type)).toEqual(["session.updated", "queue.updated"]);
    expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await collect(h.repository.readTree(META.id))).toHaveLength(append ? 3 : 1);
  },
);

// Fails if uncertainty permits any mutation, loses the queue or duplicates recovery events.
test.each([false, true])(
  "pending freezes mutations and initialize resolves factual commit (%s)",
  async (committed) => {
    const h = createContextHarness();
    const [id] = await enqueue(h);
    const before = h.context.snapshot();
    const error = io();
    if (committed) h.failNextWriteAfterCommit(error);
    else h.failNextWrite(error);
    h.failNextTreeRead(new Error("read failed"));
    await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
    expect(h.context.snapshot()).toEqual(before);
    await h.runExclusive(async () => {
      const mutations = [
        () => h.context.enqueue([user()]),
        () => h.context.edit(id as QueueEntryId, []),
        () => h.context.remove(id as QueueEntryId),
        () => h.context.clear(),
        () => h.context.confirm(),
        () => h.context.unconfirm(),
        () => h.context.updateMeta(META),
      ];
      for (const mutate of mutations)
        expect(mutate).toThrow(
          expect.objectContaining({ code: "context.pending_commit", data: { retryable: true } }),
        );
      expect(h.context.snapshot()).toEqual(before);
      await h.context.initialize();
    });
    expect(h.context.snapshot().queue.length).toBe(committed ? 0 : 1);
    const count = h.events.length;
    await h.runExclusive(() => h.context.initialize());
    expect(h.events).toHaveLength(count);
    expect((await h.context.assemble(OPTIONS)).nodes.length).toBe(committed ? 0 : 1);
    expect(await collect(h.repository.readTree(META.id))).toHaveLength(1);
  },
);

// Fails if callbacks interrupt later notifications or enter the storage catch.
test.each([false, true])(
  "continues notifications and prioritizes storage.io (%s)",
  async (storage) => {
    const name = "pkg#tool" as EntryName;
    const h = createContextHarness({ entries: { kind: () => "tool" } });
    await enqueue(h, [
      user(),
      declaration({
        toggle: [name],
        definitions: [
          { name, kind: "tool", description: "tool", parameters: {}, definitionHash: "h" },
        ],
      }),
    ]);
    const read = vi.spyOn(h.sessions, "readTree");
    const error = io();
    const subscriber = io();
    const delivered: ContextEvent[] = [];
    h.deps.events.publish = (event) => {
      delivered.push(event);
      expect(h.context.snapshot().queue).toEqual([]);
      if (event.type === "session.updated") throw subscriber;
    };
    if (storage) h.failNextWriteAfterCommit(error);
    if (storage) await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
    else
      await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({
        code: "event.publish_failed",
        cause: subscriber,
      });
    expect(delivered.map((e) => e.type)).toEqual([
      "session.updated",
      "selection.updated",
      "queue.updated",
    ]);
    expect(read).toHaveBeenCalledTimes(storage ? 1 : 0);
    expect(h.context.snapshot().selection).toEqual([name]);
    expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
  },
);

// Fails if sessions are notified in one oversized frame, or first-frame meta is lost.
test("frames actual envelopes at whole nodes and continues after a frame callback fails", async () => {
  const name = "pkg#source" as EntryName;
  const h = createContextHarness({
    entries: { kind: () => "context" },
    sources: {
      get: () => ({
        id: name,
        resolve: async () =>
          Array.from({ length: 20 }, () => ({
            source: "ignored",
            content: user("汉".repeat(80000)).content,
          })),
      }),
    },
  });
  await enqueue(h, [declaration({ toggle: [name] })]);
  const error = new Error("frame subscriber");
  const events: ContextEvent[] = [];
  h.deps.events.publish = (event) => {
    events.push(event);
    if (events.length === 1) throw error;
  };
  const tree = vi.spyOn(h.sessions, "readTree");
  await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({
    code: "event.publish_failed",
    cause: error,
  });
  const frames = events.filter((e) => e.type === "session.updated");
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames)
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThanOrEqual(4194304);
  expect((frames[0]?.data as { meta: unknown } | undefined)?.meta).toEqual(META);
  const nodes = frames.flatMap((e) => (e.data as { nodes: unknown[] }).nodes);
  expect(nodes).toEqual(await collect(h.repository.readTree(META.id)));
  expect(events.map((e) => e.type).slice(-2)).toEqual(["selection.updated", "queue.updated"]);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => 3 + i));
  expect(tree).toHaveBeenCalledTimes(0);
  expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
});

// Actual generated id bytes, not just content bytes, must be checked before create.
test("rejects an oversized generated single node before persistence or seq allocation", async () => {
  const { createSessions } = await import("../src/index.js");
  const h = createContextHarness();
  h.deps.sessions = createSessions({
    repository: h.repository,
    newId: () => "x".repeat(2100000) as import("../src/index.js").NodeId,
    now: () => META.createdAt,
  });
  await enqueue(h);
  const before = h.context.snapshot();
  await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({
    code: "context.source_failed",
  });
  expect(h.context.snapshot()).toEqual(before);
  expect(await h.sessions.list()).toEqual([]);
});

// A mismatch must freeze the original batch, even when the reader remains available.
test.each(["partial", "content", "parent", "extra", "watermark", "duplicate", "prefix-id"])(
  "corrupt %s suffix never retries automatically",
  async (fault) => {
    const h = createContextHarness();
    await enqueue(h, [user("root")]);
    await h.context.assemble(OPTIONS);
    await enqueue(h, [user("a"), user("b")]);
    const before = h.context.snapshot();
    const read = h.sessions.readTree;
    h.sessions.readTree = async function* (id) {
      const nodes = await collect(read(id));
      if (fault === "partial") nodes.pop();
      if (fault === "content" && nodes[1]) nodes[1].content = user("wrong").content;
      if (fault === "parent" && nodes[2])
        nodes[2].parentId = nodes[0]?.id as import("../src/index.js").NodeId;
      if (fault === "extra" && nodes[2])
        nodes.push({
          ...nodes[2],
          id: "extra" as import("../src/index.js").NodeId,
          parentId: nodes[2].id,
        });
      if (fault === "watermark") nodes.shift();
      if (fault === "duplicate" && nodes[1] && nodes[2]) {
        nodes[2].id = nodes[1].id;
        nodes[2].parentId = nodes[1].id;
      }
      if (fault === "prefix-id" && nodes[0] && nodes[1] && nodes[2]) {
        nodes[1].id = nodes[0].id;
        nodes[2].parentId = nodes[0].id;
      }
      yield* nodes;
    };
    const error = io();
    h.failNextWriteAfterCommit(error);
    await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
    expect(h.context.snapshot()).toEqual(before);
    const append = vi.spyOn(h.sessions, "append");
    await expect(h.runExclusive(() => h.context.initialize())).rejects.toMatchObject({
      code: "storage.corrupt",
    });
    await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({ code: "storage.corrupt" });
    expect(append).toHaveBeenCalledTimes(0);
    expect(() => h.context.clear()).toThrow(
      expect.objectContaining({ code: "context.pending_commit" }),
    );
    h.sessions.readTree = read;
    await h.runExclusive(() => h.context.initialize());
    expect(h.context.snapshot().queue).toEqual([]);
  },
);

test.each([false, true])(
  "assemble cannot write through failed pending reads (%s)",
  async (committed) => {
    const h = createContextHarness();
    await enqueue(h);
    const before = h.context.snapshot();
    const error = io();
    if (committed) h.failNextWriteAfterCommit(error);
    else h.failNextWrite(error);
    h.failNextTreeRead(new Error("first read"));
    await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
    const create = vi.spyOn(h.sessions, "create");
    for (let i = 0; i < 2; i++) {
      const failedRead = new Error("still unreadable");
      h.failNextTreeRead(failedRead);
      await expect(h.context.assemble(OPTIONS)).rejects.toBe(failedRead);
      expect(h.context.snapshot()).toEqual(before);
    }
    expect(create).toHaveBeenCalledTimes(0);
    expect((await h.context.assemble(OPTIONS)).nodes).toHaveLength(committed ? 0 : 1);
    expect(create).toHaveBeenCalledTimes(committed ? 0 : 1);
    expect(await collect(h.repository.readTree(META.id))).toHaveLength(1);
  },
);

// Fails if the retained original storage error is lost when recovery subscribers fail.
test("pending recovery keeps original storage error precedence and completes state", async () => {
  const h = createContextHarness();
  await enqueue(h);
  const error = io();
  h.failNextWriteAfterCommit(error);
  h.failNextTreeRead(new Error("read"));
  await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
  const delivered: string[] = [];
  h.deps.events.publish = (event) => {
    delivered.push(event.type);
    throw new Error("subscriber");
  };
  await expect(h.runExclusive(() => h.context.initialize())).rejects.toBe(error);
  expect(delivered).toEqual(["session.updated", "queue.updated"]);
  expect(h.context.snapshot().queue).toEqual([]);
  await h.runExclusive(() => h.context.initialize());
  expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
});

// Fails if the observer can mutate either returned objects or persistent history.
test("isolates requests, nodes, event objects and cached selection", async () => {
  const name = "pkg#tool" as EntryName;
  const h = createContextHarness({ entries: { kind: () => "tool" } });
  const input = user();
  await enqueue(h, [
    input,
    declaration({
      toggle: [name],
      definitions: [
        {
          name,
          kind: "tool",
          description: "tool",
          parameters: { value: "old" },
          definitionHash: "hash",
        },
      ],
    }),
  ]);
  input.content.length = 0;
  const delivered: ContextEvent[] = [];
  h.deps.events.publish = (event) => {
    delivered.push(structuredClone(event));
    const data = event.data as { nodes?: { content: unknown[] }[]; selection?: string[] };
    if (data.nodes?.[0]) data.nodes[0].content.length = 0;
    if (data.selection) data.selection.push("polluted");
    event.seq = 999;
  };
  const result = await h.context.assemble(OPTIONS);
  expect(result.request.messages[0]?.content).toEqual(user().content);
  expect(result.nodes[0]?.content).toEqual(user().content);
  result.request.messages[0]?.content.splice(0);
  result.nodes[0]?.content.splice(0);
  result.selection.push("pkg#polluted" as EntryName);
  if (result.request.tools?.[0]) result.request.tools[0].parameters.value = "polluted";
  expect(h.context.snapshot().selection).toEqual([name]);
  const next = await h.context.assemble(OPTIONS);
  expect(next.request.messages[0]?.content).toEqual(user().content);
  expect((await collect(h.repository.readTree(META.id)))[0]?.content).toEqual(user().content);
  expect(next.request.tools?.[0]?.parameters).toEqual({ value: "old" });
  expect(delivered.map((e) => e.seq)).toEqual([3, 4, 5]);
});

test("partial tree followed by not_found remains pending", async () => {
  const h = createContextHarness();
  await enqueue(h);
  const read = h.sessions.readTree;
  h.sessions.readTree = async function* (id) {
    for await (const node of read(id)) yield node;
    throw new PiscesError("session.not_found", "reader lost session");
  };
  const error = io();
  h.failNextWriteAfterCommit(error);
  await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
  await h.runExclusive(async () => {
    expect(() => h.context.clear()).toThrow(
      expect.objectContaining({ code: "context.pending_commit" }),
    );
  });
  h.sessions.readTree = read;
  await h.runExclusive(() => h.context.initialize());
  expect(h.context.snapshot().queue).toEqual([]);
});

test("first metadata may occupy its own whole event frame", async () => {
  const { createSessions } = await import("../src/index.js");
  const meta = { ...META, model: "m".repeat(2200000) };
  const h = createContextHarness({ meta });
  h.deps.sessions = createSessions({
    repository: h.repository,
    newId: () => "n".repeat(1100000) as import("../src/index.js").NodeId,
    now: () => META.createdAt,
  });
  await enqueue(h);
  await h.context.assemble(OPTIONS);
  const events = h.events.filter((event) => event.type === "session.updated");
  expect(events).toHaveLength(2);
  expect((events[0]?.data as { nodes: unknown[] } | undefined)?.nodes).toEqual([]);
  expect((events[0]?.data as { meta: unknown } | undefined)?.meta).toEqual(meta);
  expect((events[1]?.data as { nodes: unknown[] } | undefined)?.nodes).toHaveLength(1);
  for (const event of events)
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThanOrEqual(4194304);
});

test("postcommit source recovery never resolves or writes the source twice", async () => {
  const name = "pkg#source" as EntryName;
  const resolve = vi.fn(async () => [{ source: "ignored", content: user("source").content }]);
  const h = createContextHarness({
    entries: { kind: () => "context" },
    sources: { get: () => ({ id: name, resolve }) },
  });
  await enqueue(h, [declaration({ toggle: [name] })]);
  const error = io();
  h.failNextWriteAfterCommit(error);
  h.failNextTreeRead(new Error("read"));
  await expect(h.context.assemble(OPTIONS)).rejects.toBe(error);
  expect(h.context.snapshot().selection).toEqual([]);
  const eventsBefore = h.events.length;
  const result = await h.context.assemble(OPTIONS);
  expect(result.nodes).toEqual([]);
  expect(result.request.messages.map((message) => message.content)).toEqual([
    user("source").content,
  ]);
  expect(h.context.snapshot().selection).toEqual([name]);
  expect(h.events.slice(eventsBefore).map((event) => event.type)).toEqual([
    "session.updated",
    "selection.updated",
    "queue.updated",
  ]);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(await collect(h.repository.readTree(META.id))).toHaveLength(2);
});

// Both engine and protocol envelopes must fit, including 16-digit seq bytes.
test("accepts exactly 4MiB protocol envelope and rejects an engine-only fit before writing", async () => {
  const { createSessions } = await import("../src/index.js");
  const id = "i".repeat(2096900) as NodeId;
  const node = { ...user(""), id, parentId: id, createdAt: META.createdAt, schemaVersion: 1 };
  const base = {
    type: "session.updated",
    sessionId: META.id,
    seq: Number.MAX_SAFE_INTEGER,
    at: META.createdAt,
    data: { nodes: [node] },
  };
  const available = 4194303 - new TextEncoder().encode(JSON.stringify(base)).length;
  expect(available).toBeGreaterThan(0);
  for (const extra of [0, 1]) {
    let seq = Number.MAX_SAFE_INTEGER - 5;
    const h = createContextHarness({ eventClock: { current: () => seq, next: () => ++seq } });
    h.deps.sessions = createSessions({
      repository: h.repository,
      newId: () => id,
      now: () => META.createdAt,
    });
    await enqueue(h, [user("x".repeat(available + extra))]);
    const before = h.context.snapshot();
    if (extra) {
      await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({
        code: "context.source_failed",
      });
      expect(h.context.snapshot()).toEqual(before);
      expect(await h.sessions.list()).toEqual([]);
    } else {
      await h.context.assemble(OPTIONS);
      const frames = h.events.filter((event) => event.type === "session.updated");
      expect(frames).toHaveLength(2);
      const frame = frames[1];
      expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBe(4194303);
      const protocol = {
        event: frame?.type,
        data: {
          sessionId: frame?.sessionId,
          seq: frame?.seq,
          at: frame?.at,
          ...(frame?.data as object),
        },
      };
      expect(new TextEncoder().encode(JSON.stringify(protocol)).length).toBe(4194304);
    }
  }
});

test("abort during explicit-branch watermark read prevents append", async () => {
  const h = createContextHarness();
  await enqueue(h, [user("root")]);
  const root = await h.context.assemble(OPTIONS);
  await enqueue(h, [user("next")]);
  const before = h.context.snapshot();
  const read = h.sessions.readBranch;
  let defaults = 0;
  const controller = new AbortController();
  const reason = { aborted: "watermark" };
  h.sessions.readBranch = async function* (id, nodeId) {
    yield* read(id, nodeId);
    if (nodeId === undefined && ++defaults === 2) controller.abort(reason);
  };
  const outcome = await h.context
    .assemble({ ...OPTIONS, nodeId: root.headId, signal: controller.signal })
    .then(
      () => null,
      (error) => error,
    );
  expect(outcome).toBe(reason);
  expect(h.context.snapshot()).toEqual(before);
  expect(await collect(h.repository.readTree(META.id))).toHaveLength(1);
});

const eventBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const protocolEvent = (event: ContextEvent) => ({
  event: event.type,
  data: { sessionId: event.sessionId, seq: event.seq, at: event.at, ...(event.data as object) },
});

// Each queued declaration and generated node fits; only the accumulated selection overflows.
test.each([
  { extra: 0, wideSeq: true },
  { extra: 1, wideSeq: true },
  { extra: 1, wideSeq: false },
])(
  "preflights cumulative selection at the dual envelope boundary + $extra byte (wideSeq=$wideSeq)",
  async ({ extra, wideSeq }) => {
    let seq = 0;
    const h = createContextHarness({
      entries: { kind: () => "context" },
      sources: { get: (id) => ({ id, resolve: async () => [] }) },
      eventClock: { current: () => seq, next: () => ++seq },
    });
    await enqueue(h);
    await h.context.assemble(OPTIONS);
    const selected: EntryName[] = [];
    for (let i = 0; i < 16; i++) {
      const name = `pkg#${i}${"x".repeat(250000)}` as EntryName;
      selected.push(name);
      await enqueue(h, [declaration({ toggle: [name] })]);
      await h.context.assemble(OPTIONS);
    }
    const base: ContextEvent = {
      type: "selection.updated",
      sessionId: META.id,
      seq: Number.MAX_SAFE_INTEGER,
      at: META.createdAt,
      data: { selection: [...selected, "pkg#last"] },
    };
    const padding = 4194304 - eventBytes(protocolEvent(base));
    const last =
      `pkg#last${"汉".repeat(Math.floor(padding / 3))}${"x".repeat((padding % 3) + extra)}` as EntryName;
    const finalSelection = [...selected, last].sort();
    const candidate = { ...base, data: { selection: finalSelection } };
    expect(eventBytes(candidate)).toBe(4194303 + extra);
    expect(eventBytes(protocolEvent(candidate))).toBe(4194304 + extra);
    if (wideSeq) seq = Number.MAX_SAFE_INTEGER - 5;
    await enqueue(h, [declaration({ toggle: [last] })]);
    const before = h.context.snapshot();
    const eventCount = h.events.length;
    const ids = (await collect(h.repository.readTree(META.id))).map((node) => node.id);
    const append = vi.spyOn(h.repository, "append");
    if (extra) {
      const error = await h.context.assemble(OPTIONS).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(PiscesError);
      expect((error as PiscesError).code).toBe("context.selection_too_large");
      expect(append).not.toHaveBeenCalled();
      expect(h.context.snapshot()).toEqual(before);
      expect(h.events).toHaveLength(eventCount);
      expect((await collect(h.repository.readTree(META.id))).map((node) => node.id)).toEqual(ids);
      expect(await h.context.selectionFor()).toEqual([...selected].sort());
    } else {
      const result = await h.context.assemble(OPTIONS);
      expect(result.nodes).toHaveLength(1);
      expect(h.context.snapshot().queue).toEqual([]);
      expect(h.context.snapshot().selection).toEqual(finalSelection);
      const event = h.events.slice(eventCount).find((event) => event.type === "selection.updated");
      expect(eventBytes(event)).toBe(4194303);
      expect(eventBytes(protocolEvent(event as ContextEvent))).toBe(4194304);
    }
    for (const event of h.events) {
      expect(eventBytes(event)).toBeLessThanOrEqual(4194304);
      expect(eventBytes(protocolEvent(event))).toBeLessThanOrEqual(4194304);
    }
  },
);

test.each([0, 1])("generic publish guards the actual dual envelope boundary + %s byte", (extra) => {
  let seq = Number.MAX_SAFE_INTEGER - 1;
  const h = createContextHarness({ eventClock: { current: () => seq, next: () => ++seq } });
  const events = createContextEvents(h.deps);
  const base: ContextEvent = {
    type: "selection.updated",
    sessionId: META.id,
    seq: Number.MAX_SAFE_INTEGER,
    at: META.createdAt,
    data: { selection: ["pkg#x"] },
  };
  const padding = 4194304 - eventBytes(protocolEvent(base));
  const data = { selection: [`pkg#x${"x".repeat(padding + extra)}`] };
  if (extra) {
    expect(() => events.publish("selection.updated", data)).toThrow(
      expect.objectContaining({ code: "context.source_failed" }),
    );
    expect(h.events).toEqual([]);
  } else {
    events.publish("selection.updated", data);
    expect(h.events).toHaveLength(1);
    expect(eventBytes(h.events[0])).toBe(4194303);
    expect(eventBytes(protocolEvent(h.events[0] as ContextEvent))).toBe(4194304);
  }
});

// No selection event is needed for an empty historical read, even for oversized legacy state.
test("empty old-branch reads do not preflight or publish oversized stored selection", async () => {
  const h = createContextHarness({
    persisted: true,
    entries: { kind: () => "context" },
    sources: { get: (id) => ({ id, resolve: async () => [] }) },
  });
  const selected = Array.from(
    { length: 17 },
    (_, i) => `pkg#${i}${"x".repeat(250000)}` as EntryName,
  );
  const nodes = await h.sessions.create(META, [
    user(),
    ...selected.map((name) => declaration({ toggle: [name] })),
  ]);
  const oldHead = nodes.at(-1)?.id as NodeId;
  await h.sessions.append(META.id, [declaration({ toggle: [selected[16] as EntryName] })]);
  await h.runExclusive(() => h.context.initialize());
  const before = h.context.snapshot();
  const result = await h.context.assemble({ ...OPTIONS, nodeId: oldHead });
  expect(result.nodes).toEqual([]);
  expect(result.headId).toBe(oldHead);
  expect(result.selection).toEqual([...selected].sort());
  expect(h.context.snapshot()).toEqual(before);
  expect(h.events).toEqual([]);
  expect(await h.context.selectionFor()).toEqual(before.selection);
});

import { expect, test } from "vitest";
import { createQueue } from "../src/context/queue.js";
import type { ContentBlock, QueueEntryId, QueueEntryInput } from "../src/index.js";
import { collect, createContextHarness, gate, META, NOW } from "./support/context-harness.js";

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];
const user = (value = "hello"): QueueEntryInput => ({
  kind: "agent",
  role: "user",
  content: text(value),
  source: "user",
});
const instruction: QueueEntryInput = {
  kind: "agent",
  role: "system",
  content: text("instruction"),
  source: "instruction",
};
const declaration: QueueEntryInput = {
  kind: "control",
  role: "declaration",
  content: text('{"toggle":["pkg#tool"]}'),
  source: "user",
};
const qid = (value: string) => value as QueueEntryId;

test("enqueue preserves order and stays in memory until assembly", async () => {
  const h = createContextHarness({ persisted: true });
  await h.sessions.create(META, [user("persisted")]);
  const before = await collect(h.sessions.readTree(META.id));
  await h.runExclusive(async () => {
    await h.context.initialize();
    expect(h.context.enqueue([instruction, user()])).toEqual(["q1", "q2"]);
    expect(h.context.snapshot()).toEqual({
      queue: [
        { ...instruction, id: "q1", createdAt: NOW },
        { ...user(), id: "q2", createdAt: NOW },
      ],
      selection: [],
      seq: 1,
    });
  });
  expect(await collect(h.sessions.readTree(META.id))).toEqual(before);
  expect(await h.sessions.list()).toEqual([META]);
  expect(h.events).toEqual([
    {
      type: "queue.updated",
      sessionId: "s1",
      seq: 1,
      at: NOW,
      data: {
        queue: [
          { ...instruction, id: "q1", createdAt: NOW },
          { ...user(), id: "q2", createdAt: NOW },
        ],
      },
    },
  ]);
});

test("confirm locks editing, remove accepts confirmed entries, unconfirm unlocks remaining entries", () => {
  const { context, events } = createContextHarness();
  const [a, b] = context.enqueue([instruction, user()]) as [QueueEntryId, QueueEntryId];
  context.confirm();
  expect(context.snapshot().queue.map((entry) => entry.confirmedAt)).toEqual([NOW, NOW]);
  expect(() => context.edit(a, text("changed"))).toThrowError(
    expect.objectContaining({
      code: "queue.entry_locked",
      data: { reason: "confirmed" },
    }),
  );
  context.confirm();
  expect(events).toHaveLength(2);
  context.remove(a);
  context.unconfirm();
  context.unconfirm();
  context.edit(b, text("changed"));
  expect(context.snapshot().queue).toEqual([{ ...user("changed"), id: "q2", createdAt: NOW }]);
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(context.clear()).toEqual(["q2"]);
  expect(context.clear()).toEqual([]);
  expect(context.enqueue([])).toEqual([]);
  context.confirm();
  context.unconfirm();
  expect(events).toHaveLength(6);
});

test("clear returns ids in insertion order and removed ids become unknown", () => {
  const { context } = createContextHarness();
  context.enqueue([user(), instruction, user()]);
  expect(context.clear()).toEqual(["q1", "q2", "q3"]);
  for (const id of [qid("q1"), qid("unknown")]) {
    expect(() => context.edit(id, text("changed"))).toThrowError(
      expect.objectContaining({ code: "queue.entry_not_found" }),
    );
    expect(() => context.remove(id)).toThrowError(
      expect.objectContaining({ code: "queue.entry_not_found" }),
    );
  }
});

test("consume removes only requested live ids without notifying or retaining tombstones", () => {
  let id = 0;
  const changes: unknown[] = [];
  const queue = createQueue({
    newId: () => qid(`q${++id}`),
    now: () => NOW,
    onChange: () => changes.push(queue.snapshot()),
  });
  queue.enqueue([user(), instruction, user()]);
  expect(queue.consume(new Set([qid("q2"), qid("unknown")]))).toBe(true);
  expect(queue.snapshot().map((entry) => entry.id)).toEqual(["q1", "q3"]);
  expect(queue.consume(new Set([qid("q2")]))).toBe(false);
  expect(changes).toHaveLength(1);
  expect(() => queue.remove(qid("q2"))).toThrowError(
    expect.objectContaining({ code: "queue.entry_not_found" }),
  );
});

test("rejects control edits and atomically rejects invalid roles or malformed controls", () => {
  const { context, events } = createContextHarness();
  const [id] = context.enqueue([declaration]);
  expect(() => context.edit(id as QueueEntryId, text("changed"))).toThrowError(
    expect.objectContaining({ code: "queue.invalid_control" }),
  );
  const invalid = [
    { ...user(), role: "declaration" },
    { ...declaration, role: "user" },
    { ...declaration, role: "cancel" },
    { ...declaration, role: "compaction" },
    { ...declaration, content: text("[]") },
    { ...declaration, content: text("{") },
    { ...declaration, content: [...text('{"toggle":[]}'), ...text("extra")] },
    { ...declaration, content: text('{"toggle":"pkg#tool"}') },
    { ...declaration, content: text('{"toggle":["bad"]}') },
  ];
  for (const entry of invalid) {
    expect(() => context.enqueue([user(), entry as QueueEntryInput])).toThrowError(
      expect.objectContaining({ code: "queue.invalid_control" }),
    );
  }
  expect(context.snapshot().queue.map((entry) => entry.id)).toEqual(["q1"]);
  expect(events).toHaveLength(1);
});

test("input, snapshot and event mutations cannot alter queue state", () => {
  const { context, events } = createContextHarness();
  const input = user();
  context.enqueue([input]);
  input.content.length = 0;
  context.snapshot().queue[0]?.content.push({ type: "text", text: "snapshot" });
  const data = events[0]?.data as { queue: { content: ContentBlock[] }[] };
  data.queue[0]?.content.push({ type: "text", text: "event" });
  expect(context.snapshot().queue[0]?.content).toEqual(text("hello"));
  const content = text("edited");
  context.edit(qid("q1"), content);
  content.length = 0;
  expect(context.snapshot().queue[0]?.content).toEqual(text("edited"));
});

test("snapshot and events share the external event clock", () => {
  let seq = 40;
  const eventClock = { current: () => seq, next: () => ++seq };
  const { context, events } = createContextHarness({ eventClock });
  expect(context.snapshot().seq).toBe(40);
  eventClock.next();
  expect(context.snapshot().seq).toBe(41);
  context.enqueue([user()]);
  expect(events[0]?.seq).toBe(42);
  expect(context.snapshot().seq).toBe(42);
});

test("temporary initialization avoids storage and metadata updates do not persist or publish", async () => {
  const h = createContextHarness();
  h.failNextRead(new Error("must not read"));
  await h.context.initialize();
  expect(await h.context.selectionFor()).toEqual([]);
  h.context.enqueue([user()]);
  h.context.updateMeta({ ...META, model: "new", provider: "new", workspace: "other" });
  await h.context.initialize();
  expect(h.context.snapshot().queue).toHaveLength(1);
  expect(await h.sessions.list()).toEqual([]);
  expect(h.events.map((event) => event.type)).toEqual(["queue.updated"]);
});

test("persisted initialization rereads default branch without discarding queue", async () => {
  const h = createContextHarness({ persisted: true });
  await h.sessions.create(META, [user()]);
  h.context.enqueue([instruction]);
  await h.context.initialize();
  const error = new Error("read failed");
  h.failNextRead(error);
  await expect(h.context.initialize()).rejects.toBe(error);
  expect(h.context.snapshot().queue.map((entry) => entry.id)).toEqual(["q1"]);
});

test("harness serializes lock holders and rejects nested acquisition", async () => {
  const h = createContextHarness();
  const entered = gate();
  const release = gate();
  const first = h.runExclusive(async () => {
    entered.release();
    await release.promise;
    h.context.enqueue([instruction]);
    await expect(h.runExclusive(async () => {})).rejects.toThrow("not reentrant");
  });
  await entered.promise;
  const second = h.runExclusive(async () => {
    h.context.enqueue([user()]);
  });
  expect(h.context.snapshot().queue).toEqual([]);
  release.release();
  await Promise.all([first, second]);
  expect(h.context.snapshot().queue.map((entry) => entry.role)).toEqual(["system", "user"]);
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
// Construct a fixture of a requested wire size from the documented QueueEntry envelope.
function sizedInput(size: number, id = "q1", prefix = ""): QueueEntryInput {
  const input = user(prefix);
  const overhead = bytes({ ...input, id, createdAt: NOW });
  input.content = text(prefix + "x".repeat(size - overhead));
  return input;
}

test.each(["", "中文😀"])("enforces exact full-entry UTF-8 limits with prefix %j", (prefix) => {
  const { context, events } = createContextHarness();
  context.enqueue([sizedInput(262144, "q1", prefix)]);
  expect(bytes(context.snapshot().queue[0])).toBe(262144);
  expect(() => context.enqueue([sizedInput(262145, "q2", prefix)])).toThrowError(
    expect.objectContaining({ code: "queue.entry_too_large" }),
  );
  expect(context.snapshot().queue).toHaveLength(1);
  expect(events).toHaveLength(1);
});

test("enforces exact full-array limits including punctuation", () => {
  const valid = createContextHarness();
  valid.context.enqueue([
    sizedInput(262144, "q1"),
    sizedInput(262144, "q2"),
    sizedInput(262144, "q3"),
    sizedInput(262139, "q4"),
  ]);
  expect(bytes(valid.context.snapshot().queue)).toBe(1048576);
  expect(valid.events).toHaveLength(1);
  const invalid = createContextHarness();
  expect(() =>
    invalid.context.enqueue([
      sizedInput(262144, "q1"),
      sizedInput(262144, "q2"),
      sizedInput(262144, "q3"),
      sizedInput(262140, "q4"),
    ]),
  ).toThrowError(expect.objectContaining({ code: "queue.too_large" }));
  expect(invalid.context.snapshot().queue).toEqual([]);
  expect(invalid.events).toEqual([]);
});

test("oversized edits preserve the previous queue without events", () => {
  const { context, events } = createContextHarness();
  context.enqueue([user()]);
  const before = context.snapshot();
  expect(() => context.edit(qid("q1"), sizedInput(262145).content)).toThrowError(
    expect.objectContaining({ code: "queue.entry_too_large" }),
  );
  expect(context.snapshot()).toEqual(before);
  expect(events).toHaveLength(1);
  const full = createContextHarness();
  full.context.enqueue([
    sizedInput(262144, "q1"),
    sizedInput(262144, "q2"),
    sizedInput(262144, "q3"),
    sizedInput(262139, "q4"),
  ]);
  expect(() => full.context.edit(qid("q4"), sizedInput(262140, "q4").content)).toThrowError(
    expect.objectContaining({ code: "queue.too_large" }),
  );
  expect(bytes(full.context.snapshot().queue)).toBe(1048576);
  expect(full.events).toHaveLength(1);
});

test("confirmation validates the complete candidate before setting any timestamps", () => {
  const exact = createContextHarness();
  exact.context.enqueue([sizedInput(262103)]);
  exact.context.confirm();
  expect(bytes(exact.context.snapshot().queue[0])).toBe(262144);
  expect(exact.context.snapshot().queue[0]?.confirmedAt).toBe(NOW);
  const entryOverflow = createContextHarness();
  entryOverflow.context.enqueue([sizedInput(262104)]);
  const previous = entryOverflow.context.snapshot();
  expect(() => entryOverflow.context.confirm()).toThrowError(
    expect.objectContaining({ code: "queue.entry_too_large" }),
  );
  expect(entryOverflow.context.snapshot()).toEqual(previous);
  expect(entryOverflow.events).toHaveLength(1);
  const queueOverflow = createContextHarness();
  queueOverflow.context.enqueue([
    sizedInput(262103, "q1"),
    sizedInput(262103, "q2"),
    sizedInput(262103, "q3"),
    sizedInput(262098, "q4"),
    user(),
  ]);
  const queueBefore = queueOverflow.context.snapshot();
  expect(() => queueOverflow.context.confirm()).toThrowError(
    expect.objectContaining({ code: "queue.too_large" }),
  );
  expect(queueOverflow.context.snapshot()).toEqual(queueBefore);
  expect(queueOverflow.events).toHaveLength(1);
});

test("non-JSON content is rejected atomically before accepting any batch item", () => {
  const { context, events } = createContextHarness();
  const sparse = new Array(1);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const badValues = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    () => {},
    Symbol("bad"),
    sparse,
    cycle,
    new Date(),
  ];
  for (const value of badValues) {
    const content = [{ type: "toolCall", id: "c1", name: "pkg#tool", arguments: value }];
    expect(() =>
      context.enqueue([user(), { ...user(), content: content as ContentBlock[] }]),
    ).toThrowError(expect.objectContaining({ code: "queue.invalid_control" }));
    expect(context.snapshot().queue).toEqual([]);
  }
  expect(events).toEqual([]);
  expect(context.enqueue([user()])).toEqual(["q1"]);
  expect(() =>
    context.edit(qid("q1"), [{ type: "text", text: undefined }] as unknown as ContentBlock[]),
  ).toThrowError(expect.objectContaining({ code: "queue.invalid_control" }));
  expect(context.snapshot().queue[0]?.content).toEqual(text("hello"));
  expect(events).toHaveLength(1);
});

import { expect, test } from "vitest";
import type {
  ContentBlock,
  ContextEntries,
  ContextEntryKind,
  DefinitionSnapshot,
  EntryName,
  NodeId,
  QueueEntryId,
  QueueEntryInput,
  SessionNodeDraft,
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
const systemNode = (source: EntryName, value: string): SessionNodeDraft => ({
  kind: "agent",
  role: "system",
  source,
  content: text(value),
});

const snapshot = (
  entry: EntryName,
  description: string,
  kind: "tool" | "wrapper" = "tool",
  definitionHash = `hash-${description}`,
): DefinitionSnapshot => ({
  name: entry,
  kind,
  description,
  parameters: { description },
  definitionHash,
  ...(kind === "wrapper" ? { configHash: `config-${description}` } : {}),
});

const strict = (
  kinds: Record<string, ContextEntryKind>,
  match: (definition: DefinitionSnapshot) => boolean = () => true,
): ContextEntries => ({
  kind: (entry) => kinds[entry],
  matchesDefinition: match,
});

type Harness = ReturnType<typeof createContextHarness>;

async function enqueue(h: Harness, entries: QueueEntryInput[], confirm = true) {
  return h.runExclusive(async () => {
    const ids = h.context.enqueue(entries);
    if (confirm) h.context.confirm();
    return ids;
  });
}

function gatedSource(options: {
  persisted?: boolean;
  kinds: Record<string, ContextEntryKind>;
  match?: (definition: DefinitionSnapshot) => boolean;
}) {
  const entered = gate();
  const release = gate();
  let resolves = 0;
  const h = createContextHarness({
    ...(options.persisted === undefined ? {} : { persisted: options.persisted }),
    entries: strict(options.kinds, options.match),
    sources: {
      get: (entry) => ({
        id: entry,
        resolve: async () => {
          resolves++;
          expect(h.isLocked()).toBe(false);
          entered.release();
          await release.promise;
          return [{ source: "description", content: text(entry) }];
        },
      }),
    },
  });
  return { h, entered, release, resolves: () => resolves };
}

test("keeps a stale selected tool out of request.tools while the public selection stays complete", async () => {
  const good = name("good");
  const stale = name("stale");
  const h = createContextHarness({
    entries: strict({ [good]: "tool", [stale]: "tool" }, (definition) => {
      return definition.definitionHash === "hash-frozen";
    }),
  });
  await enqueue(h, [
    declaration({
      toggle: [good, stale],
      definitions: [snapshot(good, "frozen"), snapshot(stale, "old", "tool", "hash-outdated")],
    }),
    user(),
  ]);

  const result = await h.context.assemble(OPTIONS);
  expect(result.selection).toEqual([good, stale]);
  expect(result.executionSelection).toEqual([good]);
  expect(result.request.tools).toEqual([
    { name: good, description: "frozen", parameters: { description: "frozen" } },
  ]);
  expect(h.context.snapshot().selection).toEqual([good, stale]);
  const selectionEvents = h.events.filter((event) => event.type === "selection.updated");
  expect(selectionEvents.at(-1)?.data).toEqual({ selection: [good, stale] });
});

test("reuses historical content repurposed as a tool without resolving the new implementation", async () => {
  const entry = name("doc");
  let sourceLookups = 0;
  const h = createContextHarness({
    persisted: true,
    entries: strict({ [entry]: "tool" }, () => {
      throw new Error("matchesDefinition must not classify historical content");
    }),
    sources: {
      get: () => {
        sourceLookups++;
        throw new Error("the repurposed tool implementation must not be resolved");
      },
    },
  });
  await h.sessions.create(META, [
    systemNode(entry, "frozen body"),
    declaration({ toggle: [entry] }),
  ]);

  const result = await h.context.assemble(OPTIONS);
  expect(sourceLookups).toBe(0);
  expect(result.selection).toEqual([entry]);
  expect(result.executionSelection).toEqual([]);
  expect(result.request.tools ?? []).toEqual([]);
  expect(result.request.messages).toEqual([{ role: "system", content: text("frozen body") }]);
});

test("fails a fully missing selected source before any write or event", async () => {
  const missing = name("gone");
  const h = createContextHarness({ entries: strict({}, () => false) });
  await enqueue(h, [declaration({ toggle: [missing] }), user()]);
  const before = h.context.snapshot();
  const events = h.events.length;

  await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({
    code: "context.source_failed",
    data: { name: missing },
  });
  expect(h.context.snapshot()).toEqual(before);
  expect(h.events).toHaveLength(events);
  expect(await h.sessions.list()).toEqual([]);
});

test("keeps legacy manual injection executable without a matcher hook", async () => {
  const entry = name("manual");
  const h = createContextHarness({ entries: { kind: () => "tool" } });
  await enqueue(h, [
    declaration({
      toggle: [entry],
      definitions: [snapshot(entry, "manual", "tool", "hash-manual")],
    }),
    user(),
  ]);

  const result = await h.context.assemble(OPTIONS);
  expect(result.selection).toEqual([entry]);
  expect(result.executionSelection).toEqual([entry]);
  expect(result.request.tools).toEqual([
    { name: entry, description: "manual", parameters: { description: "manual" } },
  ]);
});

test("rejects a current tool without a necessary definition as corrupt in strict mode", async () => {
  const entry = name("tool");
  const h = createContextHarness({ persisted: true, entries: strict({ [entry]: "tool" }) });
  await h.sessions.create(META, [user("history"), declaration({ toggle: [entry] })]);
  const head = (await collect(h.repository.readBranch(META.id))).at(-1)?.id;
  const queue = h.context.snapshot().queue;

  await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({ code: "storage.corrupt" });
  expect(h.context.snapshot().queue).toEqual(queue);
  expect((await collect(h.repository.readBranch(META.id))).at(-1)?.id).toBe(head);
});

test("drops resolved source drafts when a confirmed declaration is deleted during B", async () => {
  const source = name("source");
  const { h, entered, release, resolves } = gatedSource({
    kinds: { [source]: "context" },
  });
  const [q1] = await enqueue(h, [declaration({ toggle: [source] }), user("original")]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.remove(q1 as QueueEntryId);
    h.context.enqueue([user("later")]);
    h.context.confirm();
  });
  release.release();

  const result = await pending;
  expect(resolves()).toBe(1);
  expect(result.request.messages).toEqual([{ role: "user", content: text("original") }]);
  expect(result.selection).toEqual([]);
  expect(result.executionSelection).toEqual([]);
  expect(result.nodes.map((node) => node.source)).toEqual(["user"]);
  expect(h.context.snapshot().queue.map((entry) => entry.content)).toEqual([text("later")]);
});

test("excludes same-millisecond unconfirm and reconfirm entries from a resolved batch", async () => {
  const source = name("source");
  const { h, entered, release } = gatedSource({ persisted: true, kinds: { [source]: "context" } });
  await h.sessions.create(META, [user("history"), declaration({ toggle: [source] })]);
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
  expect(result.selection).toEqual([source]);
  expect(result.request.messages.map((message) => message.content)).toEqual([
    text("history"),
    text(source),
  ]);
  expect(result.nodes.map((node) => node.source)).toEqual([source]);
  expect(h.context.snapshot().queue.map((entry) => entry.content)).toEqual([text("after")]);
});

test("recomputes tools from surviving definitions after a definitions-only deletion during B", async () => {
  const source = name("source");
  const tool = name("tool");
  const { h, entered, release } = gatedSource({
    persisted: true,
    kinds: { [source]: "context", [tool]: "tool" },
    match: (definition) => definition.definitionHash === "hash-old",
  });
  await h.sessions.create(META, [
    user("history"),
    declaration({ toggle: [source, tool], definitions: [snapshot(tool, "old")] }),
  ]);
  const [id] = await enqueue(h, [
    declaration({ toggle: [], definitions: [snapshot(tool, "new")] }),
  ]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    h.context.remove(id as QueueEntryId);
  });
  release.release();

  const result = await pending;
  expect(result.selection).toEqual([source, tool]);
  expect(result.executionSelection).toEqual([tool]);
  expect(result.request.tools).toEqual([
    { name: tool, description: "old", parameters: { description: "old" } },
  ]);
});

test("rejects a cross-kind survivor introduced only by the target branch before writing", async () => {
  const source = name("source");
  const tool = name("wrapper");
  const { h, entered, release } = gatedSource({
    persisted: true,
    kinds: { [source]: "context", [tool]: "wrapper" },
  });
  await h.sessions.create(META, [user("history")]);
  await enqueue(h, [
    declaration({
      toggle: [tool],
      definitions: [snapshot(tool, "frozen", "wrapper")],
    }),
    declaration({ toggle: [source] }),
    user("queued"),
  ]);
  const pending = h.context.assemble(OPTIONS);
  await entered.promise;
  await h.runExclusive(async () => {
    await h.sessions.append(META.id, [
      declaration({ toggle: [], definitions: [snapshot(tool, "frozen", "tool")] }),
    ]);
  });
  const before = h.context.snapshot();
  release.release();

  await expect(pending).rejects.toMatchObject({
    code: "queue.invalid_control",
    data: { name: tool },
  });
  expect(h.context.snapshot()).toEqual(before);
  expect((await collect(h.sessions.readTree(META.id))).map((node) => node.role)).toEqual([
    "user",
    "declaration",
  ]);
});

test("abort without committing when a strict source resolver ignores the signal", async () => {
  const source = name("source");
  const { h, entered, release } = gatedSource({ kinds: { [source]: "context" } });
  const controller = new AbortController();
  const reason = { cancelled: true };
  await enqueue(h, [declaration({ toggle: [source] }), user()]);
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
});

// Keeps the strict stale/eligibility seam reachable for the host while preserving in-memory state.
test("viewFor returns a branch view without changing the selection cache or seq", async () => {
  const entry = name("a");
  const doc = name("doc");
  const h = createContextHarness({ persisted: true });
  const [n1, on] = await h.sessions.create(META, [
    systemNode(doc, "body"),
    declaration({ toggle: [entry], definitions: [snapshot(entry, "frozen")] }),
  ]);
  const [n2] = await h.sessions.append(META.id, [declaration({ toggle: [entry] })]);
  const before = h.context.snapshot();
  const events = h.events.length;

  const view = await h.runExclusive(async () => {
    expect(h.isLocked()).toBe(true);
    return h.context.viewFor();
  });
  expect(view.selection).toEqual([]);
  expect(view.definitions).toEqual([snapshot(entry, "frozen")]);
  expect(view.contentNames).toEqual([doc]);
  expect(h.context.snapshot()).toEqual(before);
  expect(h.events).toHaveLength(events);

  const root = await h.runExclusive(() => h.context.viewFor(on?.id));
  expect(root.selection).toEqual([entry]);
  expect(root.contentNames).toEqual([doc]);
  expect(n1).toBeDefined();
  expect(n2).toBeDefined();
  const temporary = createContextHarness();
  await expect(
    temporary.runExclusive(() => temporary.context.viewFor("missing" as NodeId)),
  ).rejects.toMatchObject({ code: "session.node_not_found" });
});

test("validateQueue rejects each pending cross-kind reopen without confirming or publishing", async () => {
  const entry = name("tool");
  const h = createContextHarness({
    persisted: true,
    entries: strict({ [entry]: "tool" }),
  });
  await h.sessions.create(META, [
    user("history"),
    declaration({ toggle: [], definitions: [snapshot(entry, "old")] }),
  ]);
  await enqueue(
    h,
    [
      declaration({ toggle: [], definitions: [snapshot(entry, "same")] }),
      declaration({ toggle: [entry], definitions: [snapshot(entry, "new", "wrapper")] }),
    ],
    false,
  );
  const before = h.context.snapshot();
  const events = h.events.length;

  await h.runExclusive(async () => {
    await expect(h.context.validateQueue()).rejects.toMatchObject({
      code: "queue.invalid_control",
      data: { name: entry },
    });
  });
  expect(h.context.snapshot()).toEqual(before);
  expect(h.events).toHaveLength(events);

  await h.runExclusive(async () => {
    const pending = h.context.snapshot().queue;
    h.context.remove(pending[1]?.id as QueueEntryId);
    h.context.enqueue([declaration({ toggle: [entry], definitions: [snapshot(entry, "new")] })]);
    await expect(h.context.validateQueue()).resolves.toBeUndefined();
    expect(h.context.snapshot().queue.every((queueEntry) => !queueEntry.confirmedAt)).toBe(true);
  });
});

test("validateQueue ignores confirmed entries and is a no-op without a matcher hook", async () => {
  const entry = name("tool");
  const h = createContextHarness({
    persisted: true,
    entries: strict({ [entry]: "tool" }),
  });
  await h.sessions.create(META, [
    user("history"),
    declaration({ toggle: [], definitions: [snapshot(entry, "old")] }),
  ]);
  await enqueue(h, [
    declaration({ toggle: [entry], definitions: [snapshot(entry, "new", "wrapper")] }),
  ]);
  await h.runExclusive(async () => {
    await expect(h.context.validateQueue()).resolves.toBeUndefined();
  });

  const legacy = createContextHarness({ persisted: true, entries: { kind: () => "tool" } });
  await legacy.sessions.create(META, [
    user("history"),
    declaration({ toggle: [], definitions: [snapshot(entry, "old")] }),
  ]);
  await enqueue(legacy, [
    declaration({ toggle: [entry], definitions: [snapshot(entry, "new", "wrapper")] }),
  ]);
  await legacy.runExclusive(async () => {
    await expect(legacy.context.validateQueue()).resolves.toBeUndefined();
  });
});

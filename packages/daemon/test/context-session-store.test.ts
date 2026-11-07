import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContentBlock,
  type ContextDeps,
  type ContextEvent,
  createContext,
  createSessions,
  type DeclarationPayload,
  type EntryName,
  type NodeId,
  PiscesError,
  type QueueEntryId,
  type QueueEntryInput,
  type SessionId,
  type SessionMeta,
} from "@pisces/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessionStore } from "../src/index.js";
import { sessionStoreIo as io } from "../src/session-store/session-store-io.js";

const NOW = "2026-11-07T00:00:00.000Z";
const META: SessionMeta = {
  id: "context-store" as SessionId,
  model: "model",
  provider: "provider",
  workspace: "/workspace",
  createdAt: NOW,
  schemaVersion: 1,
};
const OPTIONS = { contextWindow: 100000, maxOutput: 0 };
const SOURCE = "pkg#context" as EntryName;
const SKILL = "pkg#skill" as EntryName;
const TOOL = "pkg#tool" as EntryName;
const SELECTION = [SOURCE, SKILL, TOOL];
const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];
const user = (value: string): QueueEntryInput => ({
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
const declaration = (payload: DeclarationPayload): QueueEntryInput => ({
  kind: "control",
  role: "declaration",
  source: "user",
  content: text(JSON.stringify(payload)),
});
const definition = (value: string) => ({
  name: TOOL,
  kind: "tool" as const,
  description: value,
  parameters: { value },
  definitionHash: `hash-${value}`,
});
const batch = () => [
  instruction("指令一"),
  instruction("指令二"),
  declaration({ toggle: SELECTION, definitions: [definition("historical")] }),
  user("同正文😀"),
];
const eio = () => Object.assign(new Error("injected EIO"), { code: "EIO" });

let dataDir: string;
let generation: number;
const path = (name = "") => join(dataDir, "sessions", META.id, name);

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), "pisces-context-store-"));
  generation = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

// This host owns exactly one real Store/Sessions pair; it never constructs a memory repository.
async function host(persisted = false) {
  const instance = ++generation;
  const store = createSessionStore({ dataDir });
  expect(await store.initialize()).toEqual([]);
  const ownership = new AsyncLocalStorage<boolean>();
  let tail = Promise.resolve();
  async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (ownership.getStore()) throw new Error("Session lock is not reentrant");
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await ownership.run(true, task);
    } finally {
      release();
    }
  }
  let nodeId = 0;
  let queueId = 0;
  let seq = 0;
  let sourceCalls = 0;
  let skillCalls = 0;
  let unavailable = false;
  const events: ContextEvent[] = [];
  const sessions = createSessions({
    repository: store,
    newId: () => `n${instance}-${++nodeId}` as NodeId,
    now: () => NOW,
  });
  const deps: ContextDeps = {
    sessionId: META.id,
    meta: META,
    persisted,
    sessions,
    entries: {
      kind: (name) =>
        name === SOURCE ? "context" : name === SKILL ? "skill" : name === TOOL ? "tool" : undefined,
    },
    sources: {
      get: (name) => ({
        id: name,
        resolve: async () => {
          expect(ownership.getStore()).not.toBe(true);
          sourceCalls++;
          if (unavailable) throw new Error("source must be reused from disk");
          return [{ source: "ignored", content: text("历史来源😀") }];
        },
      }),
    },
    skills: {
      selected: () => {
        expect(ownership.getStore()).not.toBe(true);
        skillCalls++;
        if (unavailable) throw new Error("skill must be reused from disk");
        return [{ name: SKILL, source: "ignored", content: text("历史技能") }];
      },
    },
    events: {
      publish: (event) => {
        expect(ownership.getStore()).toBe(true);
        events.push(structuredClone(event));
      },
    },
    eventClock: {
      current: () => seq,
      next: () => {
        expect(ownership.getStore()).toBe(true);
        return ++seq;
      },
    },
    runExclusive,
    newId: () => `q${instance}-${++queueId}` as QueueEntryId,
    now: () => NOW,
  };
  const context = createContext(deps);
  return {
    context,
    sessions,
    store,
    events,
    runExclusive,
    calls: () => ({ source: sourceCalls, skill: skillCalls }),
    disableResolvers: () => {
      unavailable = true;
    },
  };
}
type Host = Awaited<ReturnType<typeof host>>;
async function enqueue(h: Host, entries: QueueEntryInput[]) {
  return h.runExclusive(async () => {
    const ids = h.context.enqueue(entries);
    h.context.confirm();
    return ids;
  });
}

async function committedTree(h: Host) {
  const bytes = await fs.readFile(path("events.jsonl"));
  const commit = await fs.readFile(path("events.commit"), "utf8");
  expect(commit).toBe(`${bytes.length}\n`);
  const physical = bytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const tree = await collect(h.store.readTree(META.id));
  expect(tree).toEqual(physical);
  expect(tree.every((node) => node.schemaVersion === 1)).toBe(true);
  expect(JSON.parse(await fs.readFile(path("meta.json"), "utf8"))).toEqual(META);
  return tree;
}

// Catches premature create, lost instructions, live definitions, branch drift and queue restoration.
test("real lifecycle preserves branch snapshots and reuses source and skill history after restart", async () => {
  let h = await host();
  const create = vi.spyOn(h.store, "create");
  const append = vi.spyOn(h.store, "append");
  await enqueue(h, batch());
  await h.runExclusive(() => h.context.initialize());
  await expect(fs.stat(path())).rejects.toMatchObject({ code: "ENOENT" });
  expect(await h.store.list()).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  const first = await h.context.assemble(OPTIONS);
  expect(first.first).toBe(true);
  expect(first.nodes).toHaveLength(6);
  expect(first.request.messages).toEqual([
    { role: "system", content: text("历史来源😀") },
    { role: "system", content: text("历史技能") },
    { role: "system", content: text("指令一") },
    { role: "system", content: text("指令二") },
    { role: "user", content: text("同正文😀") },
  ]);
  expect(first.request.tools).toEqual([
    { name: TOOL, description: "historical", parameters: { value: "historical" } },
  ]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(append).not.toHaveBeenCalled();
  expect(h.calls()).toEqual({ source: 1, skill: 1 });
  expect(h.context.snapshot().queue).toEqual([]);
  await committedTree(h);

  await enqueue(h, [
    instruction("主线指令"),
    declaration({ toggle: [SOURCE, SKILL], definitions: [definition("new-main")] }),
    user("主线"),
  ]);
  const second = await h.context.assemble(OPTIONS);
  expect(second.first).toBe(false);
  expect(second.nodes).toHaveLength(3);
  expect(second.nodes[0]?.parentId).toBe(first.headId);
  expect(second.selection).toEqual([TOOL]);
  expect(second.request.tools?.[0]?.description).toBe("new-main");
  expect(await h.runExclusive(() => h.context.selectionFor(first.headId))).toEqual(SELECTION);

  await enqueue(h, [instruction("分支指令"), user("分支")]);
  const branch = await h.context.assemble({ ...OPTIONS, nodeId: first.headId });
  expect(branch.nodes).toHaveLength(2);
  expect(branch.nodes[0]?.parentId).toBe(first.headId);
  expect(branch.selection).toEqual(SELECTION);
  expect(branch.request.tools).toEqual(first.request.tools);
  expect(branch.request.messages).toEqual([
    ...first.request.messages,
    { role: "system", content: text("分支指令") },
    { role: "user", content: text("分支") },
  ]);
  expect(h.calls()).toEqual({ source: 1, skill: 1 });
  expect(append).toHaveBeenCalledTimes(2);
  const tree = await committedTree(h);
  expect(tree).toHaveLength(11);
  expect(Buffer.byteLength(JSON.stringify(tree))).toBeGreaterThan(JSON.stringify(tree).length);
  await h.runExclusive(async () => {
    h.context.enqueue([user("未确认内存项")]);
  });

  // Replace the old host; no old Store is used once the replacement starts writing.
  h = await host(true);
  h.disableResolvers();
  await h.runExclusive(() => h.context.initialize());
  expect(h.context.snapshot()).toEqual({ queue: [], selection: SELECTION, seq: 0 });
  expect(await h.runExclusive(() => h.context.selectionFor(second.headId))).toEqual([TOOL]);
  const resumed = await h.context.assemble(OPTIONS);
  expect(resumed.nodes).toEqual([]);
  expect(resumed.headId).toBe(branch.headId);
  expect(resumed.request).toEqual(branch.request);
  expect(h.calls()).toEqual({ source: 0, skill: 0 });
  expect(h.events).toEqual([]);
  expect(await committedTree(h)).toEqual(tree);
});

const modes = ["create", "append", "old-parent"] as const;
type Mode = (typeof modes)[number];
async function prepare(mode: Mode) {
  const h = await host();
  let parent: NodeId | undefined;
  if (mode !== "create") {
    await enqueue(h, [user("root")]);
    parent = (await h.context.assemble(OPTIONS)).headId;
  }
  if (mode === "old-parent") {
    // This sibling is an entire identical batch; it must never count as this invocation's commit.
    await enqueue(h, batch());
    await h.context.assemble(OPTIONS);
  }
  const beforeTree = mode === "create" ? [] : await collect(h.store.readTree(META.id));
  await enqueue(h, batch());
  return {
    h,
    beforeTree,
    options: { ...OPTIONS, ...(mode === "old-parent" ? { nodeId: parent as NodeId } : {}) },
  };
}

// Intercept the exact publication operation, keeping all preceding physical I/O real.
function failPublication(mode: Mode, after: boolean) {
  const cause = eio();
  let reached = false;
  if (after) {
    const original = io.syncDirectory;
    vi.spyOn(io, "syncDirectory").mockImplementation(async (...args) => {
      if (!reached && args[0] === path()) {
        reached = true;
        throw cause;
      }
      return original(...args);
    });
  } else {
    const original = io.rename;
    const destination = path(mode === "create" ? "meta.json" : "events.commit");
    vi.spyOn(io, "rename").mockImplementation(async (...args) => {
      if (!reached && args[0] === `${destination}.tmp` && args[1] === destination) {
        reached = true;
        throw cause;
      }
      return original(...args);
    });
  }
  return { cause, reached: () => reached };
}

test.each(modes)(
  "%s before publication keeps the queue and ignores matching old siblings",
  async (mode) => {
    const { h, beforeTree, options } = await prepare(mode);
    const before = h.context.snapshot();
    const eventCount = h.events.length;
    const fault = failPublication(mode, false);
    await expect(h.context.assemble(options)).rejects.toMatchObject({
      code: "storage.io",
      cause: fault.cause,
    });
    expect(fault.reached()).toBe(true);
    expect(h.context.snapshot()).toEqual(before);
    expect(h.events).toHaveLength(eventCount);
    if (mode === "create") {
      await expect(fs.stat(path())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(collect(h.store.readTree(META.id))).rejects.toMatchObject({
        code: "session.not_found",
      });
    } else {
      expect(await collect(h.store.readTree(META.id))).toEqual(beforeTree);
      const commit = Number(await fs.readFile(path("events.commit"), "utf8"));
      expect((await fs.stat(path("events.jsonl"))).size).toBeGreaterThan(commit);
    }
    const retry = await h.context.assemble(options);
    expect(retry.nodes).toHaveLength(6);
    expect(h.context.snapshot().queue).toEqual([]);
    expect(await committedTree(h)).toEqual([...beforeTree, ...retry.nodes]);
    if (mode === "old-parent") {
      expect(retry.nodes[0]?.parentId).toBe(beforeTree[0]?.id);
      expect(retry.nodes[0]?.id).not.toBe(beforeTree[1]?.id);
      expect(retry.nodes.map((node) => node.content)).toEqual(
        beforeTree.slice(1).map((node) => node.content),
      );
    }
  },
);

test.each(modes)(
  "%s after publication consumes exactly the new suffix while retaining storage.io",
  async (mode) => {
    const { h, beforeTree, options } = await prepare(mode);
    const eventCount = h.events.length;
    const write = vi.spyOn(h.store, mode === "create" ? "create" : "append");
    const fault = failPublication(mode, true);
    const error: unknown = await h.context.assemble(options).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PiscesError);
    expect(error).toMatchObject({ code: "storage.io", cause: fault.cause });
    expect(write).toHaveBeenCalledTimes(1);
    // Context must return the very error produced by the real Store, rather than a replacement.
    await expect(write.mock.results[0]?.value).rejects.toBe(error);
    expect(fault.reached()).toBe(true);
    expect(h.context.snapshot().queue).toEqual([]);
    expect(h.context.snapshot().selection).toEqual(SELECTION);
    expect(h.events.slice(eventCount).map((event) => event.type)).toEqual([
      "session.updated",
      ...(mode === "old-parent" ? [] : ["selection.updated"]),
      "queue.updated",
    ]);
    const tree = await committedTree(h);
    expect(tree).toHaveLength(beforeTree.length + 6);
    expect(tree.slice(0, beforeTree.length)).toEqual(beforeTree);
    const suffix = tree.slice(beforeTree.length);
    if (mode === "old-parent") {
      expect(suffix[0]?.parentId).toBe(beforeTree[0]?.id);
      expect(suffix[0]?.id).not.toBe(beforeTree[1]?.id);
      expect(suffix.map((node) => node.content)).toEqual(
        beforeTree.slice(1).map((node) => node.content),
      );
    }
    const calls = h.calls();
    const notifications = h.events.length;
    h.disableResolvers();
    expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
    expect(h.calls()).toEqual(calls);
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(notifications);
    expect(await committedTree(h)).toEqual(tree);
    const restarted = await host(true);
    restarted.disableResolvers();
    await restarted.runExclusive(() => restarted.context.initialize());
    expect(restarted.context.snapshot().queue).toEqual([]);
    expect(restarted.context.snapshot().selection).toEqual(SELECTION);
    expect((await restarted.context.assemble(OPTIONS)).nodes).toEqual([]);
    expect(restarted.calls()).toEqual({ source: 0, skill: 0 });
    expect(await committedTree(restarted)).toEqual(tree);
  },
);

test.each(
  modes.flatMap((mode) => ["initialize", "assemble"].map((recovery) => ({ mode, recovery }))),
)(
  "$mode postcommit failed factual reads freeze writes until $recovery reconciles once",
  async ({ mode, recovery }) => {
    const { h, beforeTree, options } = await prepare(mode);
    const before = h.context.snapshot();
    const eventCount = h.events.length;
    const write = vi.spyOn(h.store, mode === "create" ? "create" : "append");
    const fault = failPublication(mode, true);
    const readCause = eio();
    const readFile = io.readFile;
    let blocked = true;
    let failures = 0;
    vi.spyOn(io, "readFile").mockImplementation(async (...args) => {
      if (blocked && fault.reached() && args[0] === path("meta.json")) {
        failures++;
        throw readCause;
      }
      return readFile(...args);
    });
    await expect(h.context.assemble(options)).rejects.toMatchObject({
      code: "storage.io",
      cause: fault.cause,
    });
    expect(failures).toBe(1);
    expect(h.context.snapshot()).toEqual(before);
    await h.runExclusive(async () => {
      expect(() => h.context.clear()).toThrow(
        expect.objectContaining({ code: "context.pending_commit" }),
      );
      expect(() => h.context.enqueue([user("unsafe")])).toThrow(
        expect.objectContaining({ code: "context.pending_commit" }),
      );
    });
    await expect(h.context.assemble(options)).rejects.toMatchObject({
      code: "storage.io",
      cause: readCause,
    });
    expect(failures).toBe(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.context.snapshot()).toEqual(before);
    expect(h.events).toHaveLength(eventCount);
    blocked = false;
    if (recovery === "initialize") await h.runExclusive(() => h.context.initialize());
    else expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
    expect(h.context.snapshot().queue).toEqual([]);
    expect(h.context.snapshot().selection).toEqual(SELECTION);
    expect(h.events.slice(eventCount).map((event) => event.type)).toEqual([
      "session.updated",
      ...(mode === "old-parent" ? [] : ["selection.updated"]),
      "queue.updated",
    ]);
    const frame = h.events[eventCount];
    const nodes = (frame?.data as { nodes: unknown[] } | undefined)?.nodes;
    expect(nodes).toHaveLength(6);
    const tree = await committedTree(h);
    expect(tree).toHaveLength(beforeTree.length + 6);
    expect(nodes).toEqual(tree.slice(beforeTree.length));
    const notifications = h.events.length;
    h.disableResolvers();
    await h.runExclusive(() => h.context.initialize());
    expect((await h.context.assemble(OPTIONS)).nodes).toEqual([]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(notifications);
    expect(await committedTree(h)).toEqual(tree);
  },
);

// Catches persisting an uncommitted tail or recovering the abandoned in-memory queue.
test("a replacement Store truncates unpublished UTF-8 tail and a new Context starts with an empty queue", async () => {
  let h = await host();
  await enqueue(h, batch());
  const committed = await h.context.assemble(OPTIONS);
  const prefix = await fs.readFile(path("events.jsonl"));
  await enqueue(h, [user("未提交😀"), instruction("未提交指令")]);
  const fault = failPublication("append", false);
  await expect(h.context.assemble(OPTIONS)).rejects.toMatchObject({
    code: "storage.io",
    cause: fault.cause,
  });
  expect(h.context.snapshot().queue).toHaveLength(2);
  expect((await fs.stat(path("events.jsonl"))).size).toBeGreaterThan(prefix.length);
  expect(await collect(h.store.readTree(META.id))).toEqual(committed.nodes);
  // Also leave an incomplete multibyte sequence beyond the unpublished complete drafts.
  await fs.appendFile(path("events.jsonl"), Buffer.from([0xf0, 0x9f]));
  h = await host(true);
  h.disableResolvers();
  expect(await fs.readFile(path("events.jsonl"))).toEqual(prefix);
  await h.runExclusive(() => h.context.initialize());
  expect(h.context.snapshot().queue).toEqual([]);
  expect(h.context.snapshot().selection).toEqual(SELECTION);
  const resumed = await h.context.assemble(OPTIONS);
  expect(resumed.nodes).toEqual([]);
  expect(resumed.request).toEqual(committed.request);
  expect(resumed.headId).toBe(committed.headId);
  expect(h.calls()).toEqual({ source: 0, skill: 0 });
  expect(h.events).toEqual([]);
  expect(await committedTree(h)).toEqual(committed.nodes);
});

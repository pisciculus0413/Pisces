import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeId, SessionId, SessionMeta, SessionNode } from "@pisces/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessionStore, type SessionStore } from "../src/index.js";
import { sessionStoreIo as io } from "../src/session-store/session-store-io.js";

const time = "2026-11-06T13:00:00.000Z";
const sid = "s1" as SessionId;
const id = (value: string) => value as SessionId;
const meta = (sessionId = sid): SessionMeta => ({
  id: sessionId,
  model: "m",
  provider: "p",
  workspace: "/workspace",
  createdAt: time,
  schemaVersion: 1,
});
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
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result = [];
  for await (const value of values) result.push(value);
  return result;
}
const eio = () => Object.assign(new Error("injected I/O failure"), { code: "EIO" });
let dataDir: string;
let store: SessionStore;
const path = (name: string, sessionId = sid) => join(dataDir, "sessions", sessionId, name);
async function seed(sessionId = sid) {
  await store.create(meta(sessionId), [node("n1")]);
}
async function files(sessionId = sid) {
  return Promise.all(
    ["meta.json", "events.jsonl", "events.commit"].map((name) =>
      fs.readFile(path(name, sessionId)),
    ),
  );
}
async function restart() {
  const next = createSessionStore({ dataDir });
  const issues = await next.initialize();
  return { next, issues };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), "pisces-recovery-"));
  store = createSessionStore({ dataDir });
  await store.initialize();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dataDir, { recursive: true, force: true });
});

for (const name of ["events.jsonl", "events.commit", "meta.json"]) {
  test(`create can retry after ${name} tmp sync failure without touching other sessions`, async () => {
    await seed(id("s2"));
    const other = await files(id("s2"));
    const original = io.writeSynced;
    const spy = vi.spyOn(io, "writeSynced").mockImplementation(async (target, bytes) => {
      if (target === path(`${name}.tmp`)) {
        await original(target, bytes);
        throw eio();
      }
      return original(target, bytes);
    });
    await expect(seed()).rejects.toMatchObject({ code: "storage.io", cause: { code: "EIO" } });
    expect(await store.list()).toEqual([meta(id("s2"))]);
    expect(await files(id("s2"))).toEqual(other);
    await expect(fs.stat(path(""))).rejects.toMatchObject({ code: "ENOENT" });
    spy.mockRestore();
    await seed();
    expect(await files()).toHaveLength(3);
  });
  test(`create can retry after ${name} rename failure`, async () => {
    const original = io.rename;
    const spy = vi.spyOn(io, "rename").mockImplementation(async (from, to) => {
      if (to === path(name)) throw eio();
      return original(from, to);
    });
    await expect(seed()).rejects.toMatchObject({ code: "storage.io" });
    expect(await store.list()).toEqual([]);
    spy.mockRestore();
    await seed();
    expect(await collect(store.readTree(sid))).toEqual([node("n1")]);
  });
}

test("existing and concurrent creates preserve the exclusively owned winner", async () => {
  const outcomes = await Promise.allSettled([
    seed(),
    store.create({ ...meta(), model: "other" }, [node("winner")]),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const before = await files();
  await expect(seed()).rejects.toBeInstanceOf(TypeError);
  expect(await files()).toEqual(before);
  expect((await restart()).issues).toEqual([]);
});

for (const failure of ["partial append", "commit tmp sync", "commit rename"]) {
  test(`append ${failure} failure exposes the old whole batch and retry writes once`, async () => {
    await seed();
    const before = await fs.readFile(path("events.jsonl"));
    if (failure === "partial append") {
      vi.spyOn(io, "appendSynced").mockImplementationOnce(async (target, bytes) => {
        await fs.appendFile(target, bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw eio();
      });
    } else if (failure === "commit tmp sync") {
      const original = io.writeSynced;
      vi.spyOn(io, "writeSynced").mockImplementationOnce(async (target, bytes) => {
        await original(target, bytes);
        throw eio();
      });
    } else vi.spyOn(io, "rename").mockRejectedValueOnce(eio());
    const batch = [node("n2", "n1"), node("n3", "n2")];
    await expect(store.append(sid, batch)).rejects.toMatchObject({ code: "storage.io" });
    expect(await collect(store.readTree(sid))).toEqual([node("n1")]);
    expect((await fs.readFile(path("events.jsonl"))).subarray(0, before.length)).toEqual(before);
    vi.restoreAllMocks();
    await store.append(sid, batch);
    expect(await collect(store.readTree(sid))).toEqual([node("n1"), ...batch]);
    expect((await restart()).issues).toEqual([]);
  });
}

for (const action of ["create", "append", "updateMeta"] as const) {
  test(`${action} remains fully visible after its commit point when directory sync fails`, async () => {
    if (action !== "create") await seed();
    const original = io.syncDirectory;
    vi.spyOn(io, "syncDirectory").mockImplementation(async (target) => {
      if (target === path("")) throw eio();
      return original(target);
    });
    const operation =
      action === "create"
        ? seed()
        : action === "append"
          ? store.append(sid, [node("n2", "n1")])
          : store.updateMeta(sid, { ...meta(), model: "new" });
    await expect(operation).rejects.toMatchObject({ code: "storage.io" });
    const expectedNodes = action === "append" ? [node("n1"), node("n2", "n1")] : [node("n1")];
    expect(await collect(store.readTree(sid))).toEqual(expectedNodes);
    expect(await store.list()).toEqual([
      { ...meta(), model: action === "updateMeta" ? "new" : "m" },
    ]);
    vi.restoreAllMocks();
    const { next, issues } = await restart();
    expect(issues).toEqual([]);
    expect(await collect(next.readTree(sid))).toEqual(expectedNodes);
    expect(await next.list()).toEqual(await store.list());
  });
}

test("create survives failure to sync the sessions parent after commit", async () => {
  const original = io.syncDirectory;
  vi.spyOn(io, "syncDirectory").mockImplementation(async (target) => {
    if (target === join(dataDir, "sessions")) throw eio();
    return original(target);
  });
  await expect(seed()).rejects.toMatchObject({ code: "storage.io" });
  expect(await collect(store.readTree(sid))).toEqual([node("n1")]);
  vi.restoreAllMocks();
  expect((await restart()).issues).toEqual([]);
});

for (const failure of ["write", "rename"]) {
  test(`updateMeta ${failure} failure preserves the previous metadata`, async () => {
    await seed();
    const before = await files();
    if (failure === "write") vi.spyOn(io, "writeSynced").mockRejectedValueOnce(eio());
    else vi.spyOn(io, "rename").mockRejectedValueOnce(eio());
    await expect(store.updateMeta(sid, { ...meta(), model: "new" })).rejects.toMatchObject({
      code: "storage.io",
    });
    expect(await store.list()).toEqual([meta()]);
    expect(await files()).toEqual(before);
  });
}

test("same-session append and updateMeta queue behind an in-flight append", async () => {
  await seed();
  const entered = gate();
  const proceed = gate();
  const original = io.appendSynced;
  vi.spyOn(io, "appendSynced").mockImplementationOnce(async (target, bytes) => {
    entered.release();
    await proceed.promise;
    return original(target, bytes);
  });
  const first = store.append(sid, [node("n2", "n1")]);
  await entered.promise;
  let appendDone = false;
  let metaDone = false;
  const second = store.append(sid, [node("n3", "n2")]).finally(() => {
    appendDone = true;
  });
  const update = store.updateMeta(sid, { ...meta(), model: "new" }).finally(() => {
    metaDone = true;
  });
  const completed = Promise.allSettled([first, second, update]);
  // Give queued work an event-loop turn, without timing the actual filesystem operation.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const wasWaiting = !appendDone && !metaDone;
  proceed.release();
  await completed;
  expect(wasWaiting).toBe(true);
  await expect(second).resolves.toBeUndefined();
  await expect(update).resolves.toBeUndefined();
  expect(await collect(store.readTree(sid))).toEqual([
    node("n1"),
    node("n2", "n1"),
    node("n3", "n2"),
  ]);
  expect(await store.list()).toEqual([{ ...meta(), model: "new" }]);
});

test("failed queued write does not poison later operations", async () => {
  await seed();
  vi.spyOn(io, "appendSynced").mockRejectedValueOnce(eio());
  const first = store.append(sid, [node("n2", "n1")]);
  const second = store.append(sid, [node("n3", "n1")]);
  const result = await Promise.allSettled([first, second]);
  expect(result.map((value) => value.status)).toEqual(["rejected", "fulfilled"]);
  expect(await collect(store.readTree(sid))).toEqual([node("n1"), node("n3", "n1")]);
});

test("different sessions can write while one session waits on I/O", async () => {
  await seed();
  await seed(id("s2"));
  const entered = gate();
  const proceed = gate();
  const original = io.appendSynced;
  vi.spyOn(io, "appendSynced").mockImplementation(async (target, bytes) => {
    if (target === path("events.jsonl")) {
      entered.release();
      await proceed.promise;
    }
    return original(target, bytes);
  });
  const first = store.append(sid, [node("n2", "n1")]);
  await entered.promise;
  try {
    await store.append(id("s2"), [node("other", "n1")]);
    expect(await collect(store.readBranch(id("s2")))).toEqual([node("n1"), node("other", "n1")]);
  } finally {
    proceed.release();
    await first;
  }
});

for (const invalid of ["../x", "/tmp/x", "a/b", "a\\b", ".", "..", ""]) {
  test(`invalid session id ${JSON.stringify(invalid)} never reaches a filesystem path`, async () => {
    const sentinel = join(dataDir, "sentinel");
    await fs.writeFile(sentinel, "preserve");
    const spy = vi.spyOn(io, "lstat");
    const bad = id(invalid);
    await expect(store.create(meta(bad), [node("root")])).rejects.toBeInstanceOf(TypeError);
    await expect(store.append(bad, [node("n2", "n1")])).rejects.toBeInstanceOf(TypeError);
    await expect(store.updateMeta(bad, meta())).rejects.toBeInstanceOf(TypeError);
    await expect(collect(store.readTree(bad))).rejects.toBeInstanceOf(TypeError);
    await expect(collect(store.readBranch(bad))).rejects.toBeInstanceOf(TypeError);
    expect(spy).not.toHaveBeenCalled();
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve");
  });
}

test("missing sessions and nodes from another session have distinct errors", async () => {
  await expect(collect(store.readTree(sid))).rejects.toMatchObject({ code: "session.not_found" });
  await expect(collect(store.readBranch(sid))).rejects.toMatchObject({ code: "session.not_found" });
  await expect(store.append(sid, [node("n2", "n1")])).rejects.toMatchObject({
    code: "session.not_found",
  });
  await expect(store.updateMeta(sid, meta())).rejects.toMatchObject({ code: "session.not_found" });
  await seed();
  await store.create(meta(id("s2")), [node("external")]);
  await expect(collect(store.readBranch(sid, "external" as NodeId))).rejects.toMatchObject({
    code: "session.node_not_found",
  });
  await expect(store.append(sid, [node("n2", "external")])).rejects.toMatchObject({
    code: "session.node_not_found",
  });
});

for (const batch of [
  [],
  [node("n1", "n1"), node("n1", "n1")],
  [node("n2", "n1"), node("n3", "n1")],
  [{ ...node("n2", "n1"), content: [{ type: "text", text: 1 }] }],
]) {
  test(`invalid write batch ${JSON.stringify(batch)} leaves committed files unchanged`, async () => {
    await seed();
    const before = await files();
    await expect(store.append(sid, batch as SessionNode[])).rejects.toBeInstanceOf(TypeError);
    expect(await files()).toEqual(before);
    await expect(store.create(meta(id("s2")), batch as SessionNode[])).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(fs.stat(path("", id("s2")))).rejects.toMatchObject({ code: "ENOENT" });
  });
}

for (const tail of [
  Buffer.from(`${JSON.stringify(node("uncommitted", "n1"))}\n`),
  Buffer.from("{bad json}\n"),
  Buffer.from([0xe9, 0xb1]),
]) {
  for (const recovery of ["append", "initialize"]) {
    test(`${recovery} discards uncommitted tail ${tail.toString("hex").slice(0, 12)} only after validating the prefix`, async () => {
      await seed();
      const prefix = await fs.readFile(path("events.jsonl"));
      await fs.appendFile(path("events.jsonl"), tail);
      // New instance initialization would recover immediately, so clear the cached index via an expected invalid write.
      await expect(store.append(sid, [])).rejects.toBeInstanceOf(TypeError);
      const before = await fs.stat(path("events.jsonl"));
      expect(await collect(store.readTree(sid))).toEqual([node("n1")]);
      const after = await fs.stat(path("events.jsonl"));
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      if (recovery === "append") {
        await store.append(sid, [node("n2", "n1")]);
        expect(await fs.readFile(path("events.jsonl"))).toEqual(
          Buffer.concat([prefix, Buffer.from(`${JSON.stringify(node("n2", "n1"))}\n`)]),
        );
      } else {
        const { issues } = await restart();
        expect(issues).toEqual([]);
        expect(await fs.readFile(path("events.jsonl"))).toEqual(prefix);
      }
      const once = await files();
      expect((await restart()).issues).toEqual([]);
      expect(await files()).toEqual(once);
    });
  }
}

test("blank committed lines count toward byte positions and do not create nodes", async () => {
  await seed();
  const bytes = Buffer.from(
    ` \t\n${JSON.stringify(node("n1"))}\n\n${JSON.stringify(node("n2", "n1"))}\n   \n`,
  );
  await fs.writeFile(path("events.jsonl"), bytes);
  await fs.writeFile(path("events.commit"), `${bytes.length}\n`);
  const { next, issues } = await restart();
  expect(issues).toEqual([]);
  expect(await collect(next.readTree(sid))).toEqual([node("n1"), node("n2", "n1")]);
  expect(await collect(next.readBranch(sid))).toEqual([node("n1"), node("n2", "n1")]);
  await next.append(sid, [node("n3", "n2")]);
  expect((await fs.readFile(path("events.jsonl"))).subarray(0, bytes.length)).toEqual(bytes);
});

const eventCorruption: [string, Buffer][] = [
  ["bad JSON", Buffer.from(`${JSON.stringify(node("n1"))}\n{bad}\n`)],
  ["non-object", Buffer.from("[]\n")],
  [
    "invalid UTF-8",
    Buffer.concat([Buffer.from(`${JSON.stringify(node("n1"))}\n`), Buffer.from([0xc3, 0x28, 10])]),
  ],
  ["duplicate id", Buffer.from(`${JSON.stringify(node("n1"))}\n${JSON.stringify(node("n1"))}\n`)],
  ["missing parent", Buffer.from(`${JSON.stringify(node("n1", "missing"))}\n`)],
  ["second root", Buffer.from(`${JSON.stringify(node("n1"))}\n${JSON.stringify(node("n2"))}\n`)],
  [
    "cycle",
    Buffer.from(`${JSON.stringify(node("n1", "n2"))}\n${JSON.stringify(node("n2", "n1"))}\n`),
  ],
  [
    "forward parent",
    Buffer.from(
      `${JSON.stringify(node("n1"))}\n${JSON.stringify(node("n2", "n3"))}\n${JSON.stringify(node("n3", "n1"))}\n`,
    ),
  ],
  ...[0, 2].map((version): [string, Buffer] => [
    `node schema ${version}`,
    Buffer.from(`${JSON.stringify({ ...node("n1"), schemaVersion: version })}\n`),
  ]),
  [
    "control text must contain object",
    Buffer.from(
      `${JSON.stringify({ ...node("n1"), kind: "control", role: "cancel", content: [{ type: "text", text: "[]" }] })}\n`,
    ),
  ],
  [
    "toolResult nested block",
    Buffer.from(
      `${JSON.stringify({ ...node("n1"), content: [{ type: "toolResult", toolCallId: "t", content: [{ type: "text", text: null }] }] })}\n`,
    ),
  ],
];
for (const [label, bytes] of eventCorruption) {
  test(`corrupt committed ${label} preserves evidence and cannot yield partial records`, async () => {
    await seed();
    await seed(id("s2"));
    await fs.writeFile(path("events.jsonl"), bytes);
    await fs.writeFile(path("events.commit"), `${bytes.length}\n`);
    await fs.writeFile(path("meta.json.tmp"), "diagnostic");
    const before = await files();
    const { next, issues } = await restart();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ sessionId: sid, error: { code: "storage.corrupt" } });
    await expect(next.list()).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(next.readTree(sid)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "storage.corrupt",
    });
    await expect(collect(next.readBranch(sid))).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(next.append(sid, [node("n2", "n1")])).rejects.toMatchObject({
      code: "storage.corrupt",
    });
    await expect(next.updateMeta(sid, meta())).rejects.toMatchObject({ code: "storage.corrupt" });
    expect(await collect(next.readTree(id("s2")))).toEqual([node("n1")]);
    expect(await files()).toEqual(before);
    expect(await fs.readFile(path("meta.json.tmp"), "utf8")).toBe("diagnostic");
  });
}

for (const change of [
  { schemaVersion: 0 },
  { schemaVersion: 2 },
  { id: "wrong" },
  { workspace: "" },
  { createdAt: "2026-02-30T00:00:00.000Z" },
  { model: null },
  { provider: "" },
]) {
  test(`invalid metadata ${JSON.stringify(change)} is retained as corrupt`, async () => {
    await seed();
    await fs.writeFile(path("meta.json"), JSON.stringify({ ...meta(), ...change }));
    const before = await files();
    const { next, issues } = await restart();
    expect(issues).toMatchObject([{ sessionId: sid, error: { code: "storage.corrupt" } }]);
    await expect(next.list()).rejects.toMatchObject({ code: "storage.corrupt" });
    expect(await files()).toEqual(before);
  });
}

for (const boundary of [
  undefined,
  "",
  "-1\n",
  "0\n",
  "1.5\n",
  "9007199254740992\n",
  "999999\n",
  "1\n",
  "+1\n",
  "1\n2",
  " 1\n",
]) {
  test(`invalid commit ${JSON.stringify(boundary)} preserves meta and original events`, async () => {
    await seed();
    await fs.appendFile(path("events.jsonl"), "uncommitted");
    if (boundary === undefined) await fs.unlink(path("events.commit"));
    else await fs.writeFile(path("events.commit"), boundary);
    const metaBefore = await fs.readFile(path("meta.json"));
    const eventsBefore = await fs.readFile(path("events.jsonl"));
    const { next, issues } = await restart();
    expect(issues).toMatchObject([{ sessionId: sid, error: { code: "storage.corrupt" } }]);
    await expect(next.list()).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(collect(next.readTree(sid))).rejects.toMatchObject({ code: "storage.corrupt" });
    expect(await fs.readFile(path("meta.json"))).toEqual(metaBefore);
    expect(await fs.readFile(path("events.jsonl"))).toEqual(eventsBefore);
  });
}

test("valid commit without final newline is accepted", async () => {
  await seed();
  const value = await fs.readFile(path("events.commit"), "utf8");
  await fs.writeFile(path("events.commit"), value.trim());
  expect((await restart()).issues).toEqual([]);
});

test("recovery removes only meta-less orphan directories and owned healthy tmp files", async () => {
  await seed();
  for (const name of ["meta.json", "events.jsonl", "events.commit"])
    await fs.writeFile(path(`${name}.tmp`), "stale");
  for (const sessionId of [id("orphan1"), id("orphan2")]) {
    await fs.mkdir(path("", sessionId));
    await fs.writeFile(path("events.jsonl", sessionId), "partial");
  }
  await fs.writeFile(path("events.commit", id("orphan2")), "9\n");
  await fs.writeFile(path("active-turn.json"), "active");
  await fs.writeFile(path("notes.txt"), "notes");
  await fs.writeFile(join(dataDir, "projects.json"), "projects");
  await fs.mkdir(join(dataDir, "sessions", "uncontrolled.name"));
  await fs.writeFile(join(dataDir, "sessions", "uncontrolled.name", "keep"), "unrelated");
  const { issues } = await restart();
  expect(issues).toEqual([]);
  expect(await fs.readdir(join(dataDir, "sessions"))).toEqual(
    expect.arrayContaining([sid, "uncontrolled.name"]),
  );
  for (const sessionId of [id("orphan1"), id("orphan2")])
    await expect(fs.stat(path("", sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  for (const name of ["meta.json", "events.jsonl", "events.commit"])
    await expect(fs.stat(path(`${name}.tmp`))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path("active-turn.json"), "utf8")).toBe("active");
  expect(await fs.readFile(path("notes.txt"), "utf8")).toBe("notes");
  expect(await fs.readFile(join(dataDir, "projects.json"), "utf8")).toBe("projects");
  expect(await fs.readFile(join(dataDir, "sessions", "uncontrolled.name", "keep"), "utf8")).toBe(
    "unrelated",
  );
});

for (const target of [
  "root",
  "session",
  "meta.json",
  "events.jsonl",
  "events.commit",
  "meta.json.tmp",
]) {
  test(`symlink ${target} is rejected without scanning or removing its target`, async (context) => {
    await seed();
    const outside = join(dataDir, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "sentinel"), "preserve");
    const link =
      target === "root"
        ? join(dataDir, "sessions")
        : target === "session"
          ? path("")
          : path(target);
    await fs.rm(link, { recursive: true, force: true });
    try {
      await fs.symlink(outside, link, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    const next = createSessionStore({ dataDir });
    if (target === "root")
      await expect(next.initialize()).rejects.toMatchObject({ code: "storage.corrupt" });
    else {
      expect(await next.initialize()).toMatchObject([
        { sessionId: sid, error: { code: "storage.corrupt" } },
      ]);
      await expect(collect(next.readTree(sid))).rejects.toMatchObject({ code: "storage.corrupt" });
      await expect(next.list()).rejects.toMatchObject({ code: "storage.corrupt" });
    }
    expect(await fs.readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });
}

test("uninitialized methods reject and initialize shares exactly one scan", async () => {
  const next = createSessionStore({ dataDir });
  const spy = vi.spyOn(io, "readdir");
  await expect(next.list()).rejects.toBeInstanceOf(TypeError);
  await expect(next.create(meta(), [node("n1")])).rejects.toBeInstanceOf(TypeError);
  await expect(next.append(sid, [node("n2", "n1")])).rejects.toBeInstanceOf(TypeError);
  await expect(next.updateMeta(sid, meta())).rejects.toBeInstanceOf(TypeError);
  await expect(collect(next.readTree(sid))).rejects.toBeInstanceOf(TypeError);
  await expect(collect(next.readBranch(sid))).rejects.toBeInstanceOf(TypeError);
  const a = next.initialize();
  const b = next.initialize();
  expect(a).toBe(b);
  expect(await a).toEqual([]);
  await next.initialize();
  expect(spy).toHaveBeenCalledTimes(1);
});

test("root I/O failure rejects initialization with the original cause", async () => {
  const error = Object.assign(new Error("denied"), { code: "EACCES" });
  vi.spyOn(io, "readdir").mockRejectedValueOnce(error);
  const next = createSessionStore({ dataDir });
  await expect(next.initialize()).rejects.toMatchObject({ code: "storage.io", cause: error });
  await expect(next.list()).rejects.toBeInstanceOf(TypeError);
});

for (const platform of ["win32", "linux"] as const) {
  for (const errorCode of ["EPERM", "EACCES", "EINVAL", "ENOTSUP", "EIO"]) {
    test(`directory sync ${platform} handles ${errorCode} only when unsupported`, async () => {
      vi.spyOn(io, "open").mockRejectedValueOnce(
        Object.assign(new Error(errorCode), { code: errorCode }),
      );
      const operation = io.syncDirectory(dataDir, platform);
      if (platform === "win32" && errorCode !== "EIO")
        await expect(operation).resolves.toBeUndefined();
      else await expect(operation).rejects.toMatchObject({ code: errorCode });
    });
  }
}

test.each([false, true])(
  "a slow reader cannot cache an old commit after append (sync failure: %s)",
  async (failAfterCommit) => {
    await seed();
    await expect(store.append(sid, [])).rejects.toBeInstanceOf(TypeError);
    const entered = gate();
    const proceed = gate();
    const original = io.readFile;
    let delayed = false;
    vi.spyOn(io, "readFile").mockImplementation(async (...args) => {
      const value = await original(...args);
      if (args[0] === path("events.commit") && !delayed) {
        delayed = true;
        entered.release();
        await proceed.promise;
      }
      return value;
    });
    const reading = collect(store.readTree(sid));
    await entered.promise;
    if (failAfterCommit) vi.spyOn(io, "syncDirectory").mockRejectedValueOnce(eio());
    try {
      const appending = store.append(sid, [node("n2", "n1")]);
      if (failAfterCommit) await expect(appending).rejects.toMatchObject({ code: "storage.io" });
      else await appending;
    } finally {
      proceed.release();
    }
    expect(await reading).toEqual([node("n1")]);
    expect(await collect(store.readTree(sid))).toEqual([node("n1"), node("n2", "n1")]);
  },
);

test("a reader racing commit publication does not compare a new commit against an old file size", async () => {
  await seed();
  await expect(store.append(sid, [])).rejects.toBeInstanceOf(TypeError);
  const entered = gate();
  const proceed = gate();
  const original = io.lstat;
  let eventStats = 0;
  vi.spyOn(io, "lstat").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (args[0] === path("events.jsonl") && ++eventStats === 2) {
      entered.release();
      await proceed.promise;
    }
    return value;
  });
  const reading = collect(store.readTree(sid));
  const readResult = Promise.allSettled([reading]);
  await entered.promise;
  try {
    await store.append(sid, [node("n2", "n1")]);
  } finally {
    proceed.release();
  }
  await readResult;
  await expect(reading).resolves.toEqual([node("n1")]);
  expect(await collect(store.readTree(sid))).toEqual([node("n1"), node("n2", "n1")]);
});

for (const target of ["session", "meta.json", "events.jsonl", "events.commit"]) {
  test(`cached access still rejects an existing ${target} symlink before following it`, async (context) => {
    await seed();
    const outside = join(dataDir, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "sentinel"), "preserve");
    const link = target === "session" ? path("") : path(target);
    await fs.rm(link, { recursive: true, force: true });
    try {
      await fs.symlink(outside, link, "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(collect(store.readTree(sid))).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(store.append(sid, [node("n2", "n1")])).rejects.toMatchObject({
      code: "storage.corrupt",
    });
    await expect(store.updateMeta(sid, meta())).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(store.list()).rejects.toMatchObject({ code: "storage.corrupt" });
    expect(await fs.readFile(join(outside, "sentinel"), "utf8")).toBe("preserve");
  });
}

test("a BOM-prefixed commit is corrupt and recovery preserves all diagnostic evidence", async () => {
  await seed();
  await seed(id("s2"));
  const boundary = await fs.readFile(path("events.commit"));
  await fs.writeFile(
    path("events.commit"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), boundary]),
  );
  await fs.appendFile(path("events.jsonl"), "diagnostic uncommitted tail");
  const temporary = ["meta.json.tmp", "events.jsonl.tmp", "events.commit.tmp"];
  for (const name of temporary) await fs.writeFile(path(name), `diagnostic ${name}`);
  const before = await files();
  const { next, issues } = await restart();
  expect(issues).toMatchObject([{ sessionId: sid, error: { code: "storage.corrupt" } }]);
  await expect(next.list()).rejects.toMatchObject({ code: "storage.corrupt" });
  await expect(collect(next.readTree(sid))).rejects.toMatchObject({ code: "storage.corrupt" });
  expect(await files()).toEqual(before);
  for (const name of temporary)
    expect(await fs.readFile(path(name), "utf8")).toBe(`diagnostic ${name}`);
  expect(await collect(next.readTree(id("s2")))).toEqual([node("n1")]);
});

import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NodeId, PiscesError, type SessionId, type TurnId } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type ActiveTurnMarker, createActiveTurnStore } from "../src/gateway/active-turn.js";

const NOW = "2026-11-08T05:00:00.000Z";
const sid = "s1" as SessionId;
const marker = { turnId: "t1" as TurnId, startedAt: NOW, startOffset: 12 };
let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pisces-active-turn-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
const seed = (id: string) => mkdir(join(dataDir, "sessions", id), { recursive: true });
const markerPath = (id: string) => join(dataDir, "sessions", id, "active-turn.json");
const invalidMarker = (value: object) => value as unknown as ActiveTurnMarker;

test("writes, replaces, reads, scans and conditionally removes the marker", async () => {
  const store = createActiveTurnStore({ dataDir });
  await seed(sid);
  await store.write(sid, marker);
  expect(await store.read(sid)).toEqual(marker);
  expect(await store.list()).toEqual([{ sessionId: sid, marker }]);
  expect(await store.scan()).toEqual([{ sessionId: sid, marker }]);
  await store.write(sid, { ...marker, turnId: "t2" as TurnId });
  await store.remove(sid, "t1" as TurnId);
  expect(await store.read(sid)).toMatchObject({ turnId: "t2" });
  await store.remove(sid, "t2" as TurnId);
  expect(await store.read(sid)).toBeUndefined();
  expect(await store.list()).toEqual([]);
});

test("stores the marker at sessions/<id>/active-turn.json", async () => {
  const store = createActiveTurnStore({ dataDir });
  await seed(sid);
  const value = { ...marker, startNodeId: "n1" as NodeId };
  await store.write(sid, value);
  expect((await lstat(markerPath(sid))).isFile()).toBe(true);
  expect(JSON.parse(await readFile(markerPath(sid), "utf8"))).toEqual(value);
  expect(await store.read(sid)).toEqual(value);
  expect(await readdir(join(dataDir, "sessions", sid))).toEqual(["active-turn.json"]);
});

test("a write into a missing session directory reports storage.io", async () => {
  const store = createActiveTurnStore({ dataDir });
  await expect(store.write(sid, marker)).rejects.toMatchObject({ code: "storage.io" });
  await expect(store.read(sid)).resolves.toBeUndefined();
  await expect(store.remove(sid, "t1" as TurnId)).resolves.toBeUndefined();
  expect(await store.list()).toEqual([]);
});

test("unknown or missing marker fields read as storage.corrupt", async () => {
  const store = createActiveTurnStore({ dataDir });
  const files = {
    extra: JSON.stringify({ ...marker, extra: true }),
    missing: JSON.stringify({ turnId: "t1", startedAt: NOW }),
    "bad-turn": JSON.stringify({ ...marker, turnId: "bad/id" }),
    "bad-started": JSON.stringify({ ...marker, startedAt: "2026-11-08T05:00:00Z" }),
    "bad-offset": JSON.stringify({ ...marker, startOffset: -1 }),
    "bad-node": JSON.stringify({ ...marker, startNodeId: "" }),
    "not-json": "{",
    array: "[]",
  };
  for (const [id, value] of Object.entries(files)) {
    await seed(id);
    await writeFile(markerPath(id), value);
    await expect(store.read(id as SessionId)).rejects.toMatchObject({ code: "storage.corrupt" });
  }
  await expect(store.list()).rejects.toMatchObject({ code: "storage.corrupt" });
});

test("a symlinked marker file reads as storage.corrupt", async () => {
  const store = createActiveTurnStore({ dataDir });
  await seed(sid);
  const target = join(dataDir, "elsewhere.json");
  await writeFile(target, JSON.stringify(marker));
  await symlink(target, markerPath(sid));
  await expect(store.read(sid)).rejects.toMatchObject({ code: "storage.corrupt" });
});

test("rejects invalid markers before writing", async () => {
  const store = createActiveTurnStore({ dataDir });
  await seed(sid);
  const invalid = [
    { ...marker, turnId: "" },
    { ...marker, turnId: "bad id" },
    { ...marker, startedAt: "2026-11-08T05:00:00Z" },
    { ...marker, startedAt: `${NOW}0` },
    { ...marker, startOffset: -1 },
    { ...marker, startOffset: 1.5 },
    { ...marker, startOffset: Number.MAX_SAFE_INTEGER + 1 },
    { ...marker, startNodeId: "" },
    { ...marker, extra: true },
  ];
  for (const value of invalid)
    await expect(store.write(sid, invalidMarker(value))).rejects.toBeInstanceOf(TypeError);
  await expect(store.write("bad/id" as SessionId, marker)).rejects.toBeInstanceOf(TypeError);
  await expect(store.read(sid)).resolves.toBeUndefined();
  expect(await readdir(join(dataDir, "sessions", sid))).toEqual([]);
});

test("scan isolates a corrupt marker per session for recovery", async () => {
  const store = createActiveTurnStore({ dataDir });
  await seed("good");
  await seed("bad");
  await seed("empty");
  await store.write("good" as SessionId, marker);
  await writeFile(markerPath("bad"), JSON.stringify({ ...marker, extra: true }));
  const entries = await store.scan();
  expect(entries.map((entry) => entry.sessionId)).toEqual(["bad", "good"]);
  const bad = entries[0];
  if (!bad || !("error" in bad)) throw new Error("Expected a per-session error entry");
  expect("marker" in bad).toBe(false);
  expect(bad.error).toBeInstanceOf(PiscesError);
  expect(bad.error.code).toBe("storage.corrupt");
  expect(entries[1]).toEqual({ sessionId: "good", marker });
  await expect(store.list()).rejects.toMatchObject({ code: "storage.corrupt" });
});

test("a non-directory session path reports storage.corrupt", async () => {
  const store = createActiveTurnStore({ dataDir });
  await mkdir(join(dataDir, "sessions"), { recursive: true });
  await writeFile(join(dataDir, "sessions", sid), "x");
  await expect(store.read(sid)).rejects.toMatchObject({ code: "storage.corrupt" });
  await expect(store.write(sid, marker)).rejects.toMatchObject({ code: "storage.corrupt" });
  const entries = await store.scan();
  expect(entries).toMatchObject([{ sessionId: sid, error: expect.any(PiscesError) }]);
  await expect(entries[0]).not.toHaveProperty("marker");
  await expect(store.list()).rejects.toMatchObject({ code: "storage.corrupt" });
});

test("lists only session directories holding a marker in UTF-16 order", async () => {
  const store = createActiveTurnStore({ dataDir });
  await seed("s2");
  await seed("s10");
  await seed("s1");
  await seed("empty");
  await writeFile(join(dataDir, "sessions", "projects.json"), "[]");
  await store.write("s2" as SessionId, marker);
  await store.write("s10" as SessionId, { ...marker, turnId: "t2" as TurnId });
  await store.write("s1" as SessionId, { ...marker, turnId: "t3" as TurnId });
  expect((await store.list()).map((entry) => entry.sessionId)).toEqual(["s1", "s10", "s2"]);
});

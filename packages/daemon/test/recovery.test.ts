import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CancelPayload,
  createSessions,
  type EntryName,
  type NodeId,
  PiscesError,
  type SessionId,
  type SessionMeta,
  type SessionNode,
  type SessionNodeDraft,
  type Sessions,
  type TurnId,
} from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import { type ActiveTurnMarker, createActiveTurnStore } from "../src/gateway/active-turn.js";
import { type RecoveryDeps, recoverActiveTurns } from "../src/gateway/recovery.js";
import { createSessionStore, type SessionStore } from "../src/session-store/session-store.js";

const NOW = "2026-11-08T05:00:00.000Z";
const SID = "s1" as SessionId;
const T1 = "t1" as TurnId;
const T2 = "t2" as TurnId;

interface RecoveryHarness {
  dataDir: string;
  deps: RecoveryDeps;
  store: SessionStore;
  markers: ReturnType<typeof createActiveTurnStore>;
  tree(): Promise<SessionNode[]>;
  appendRoot(id: string): Promise<NodeId>;
  appendOldBranch(parentId: NodeId, id: string): Promise<NodeId>;
  appendTurnAssistant(parentId: NodeId, id: string, callId: string): Promise<SessionNode>;
  appendToolResult(parentId: NodeId, id: string, callId: string): Promise<SessionNode>;
  appendCancel(parentId: NodeId, payload: CancelPayload): Promise<SessionNode>;
  failNextAppendAfterCommit(): void;
  close(): Promise<void>;
}

interface HarnessOptions {
  initialize?: boolean;
  sessionId?: SessionId;
}

const draftUser = (text: string): SessionNodeDraft => ({
  kind: "agent",
  role: "user",
  source: "create",
  content: [{ type: "text", text }],
});

const draftAssistant = (callId: string): SessionNodeDraft => ({
  kind: "agent",
  role: "assistant",
  source: "assistant",
  content: [
    {
      type: "toolCall",
      id: callId,
      name: "pkg#tool" as EntryName,
      arguments: {},
    },
  ],
});

let openHarnesses: RecoveryHarness[] = [];
afterEach(async () => {
  await Promise.all(openHarnesses.map((harness) => harness.close()));
  openHarnesses = [];
});

async function createRecoveryHarness(options: HarnessOptions = {}): Promise<RecoveryHarness> {
  const sessionId = options.sessionId ?? SID;
  const dataDir = await mkdtemp(join(tmpdir(), "pisces-recovery-"));
  const store = createSessionStore({ dataDir });
  if (options.initialize !== false) await store.initialize();
  const markers = createActiveTurnStore({ dataDir });
  const meta: SessionMeta = {
    id: sessionId,
    model: "m",
    provider: "p",
    workspace: "/workspace",
    createdAt: NOW,
    schemaVersion: 1,
  };
  const requested: NodeId[] = [];
  let generated = 0;
  let created = false;
  let failNextAppend = false;
  const sessions = createSessions({
    repository: store,
    newId: () => requested.shift() ?? (`generated-${++generated}` as NodeId),
    now: () => NOW,
  });
  const recoverySessions: Sessions = {
    ...sessions,
    async append(id, drafts, parentId, writeOptions) {
      const nodes = await sessions.append(id, drafts, parentId, writeOptions);
      if (failNextAppend) {
        failNextAppend = false;
        throw new PiscesError("storage.io", "Append committed before failing");
      }
      return nodes;
    },
  };
  const withId = async <T>(id: string, task: () => Promise<T>): Promise<T> => {
    requested.push(id as NodeId);
    return task();
  };
  const appendWithId = async (id: string, draft: SessionNodeDraft, parentId: NodeId) => {
    const [node] = await withId(id, () => sessions.append(sessionId, [draft], parentId));
    return node as SessionNode;
  };
  const deps: RecoveryDeps = { store, markers, sessions: recoverySessions };
  let cancelCount = 0;
  const harness: RecoveryHarness = {
    dataDir,
    deps,
    store,
    markers,
    async tree() {
      const nodes: SessionNode[] = [];
      for await (const node of store.readTree(sessionId)) nodes.push(node);
      return nodes;
    },
    async appendRoot(id) {
      if (created) throw new Error("Session root already exists");
      created = true;
      const [node] = await withId(id, () => sessions.create(meta, [draftUser("root")]));
      return (node as SessionNode).id;
    },
    async appendOldBranch(parentId, id) {
      const [node] = await withId(id, () =>
        sessions.append(
          sessionId,
          [
            {
              kind: "agent",
              role: "assistant",
              source: "old",
              content: [
                {
                  type: "toolCall",
                  id: "call_old",
                  name: "pkg#old" as EntryName,
                  arguments: {},
                },
              ],
            },
          ],
          parentId,
        ),
      );
      return (node as SessionNode).id;
    },
    async appendTurnAssistant(parentId, id, callId) {
      return appendWithId(id, draftAssistant(callId), parentId);
    },
    async appendToolResult(parentId, id, callId) {
      return appendWithId(
        id,
        {
          kind: "agent",
          role: "tool",
          source: "tool",
          content: [{ type: "toolResult", toolCallId: callId, content: [] }],
        },
        parentId,
      );
    },
    async appendCancel(parentId, payload) {
      return appendWithId(
        `cancel-${++cancelCount}`,
        {
          kind: "control",
          role: "cancel",
          source: "driver",
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
        parentId,
      );
    },
    failNextAppendAfterCommit() {
      failNextAppend = true;
    },
    async close() {
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  openHarnesses.push(harness);
  return harness;
}

const cancelPayload = (node: SessionNode): CancelPayload =>
  JSON.parse((node.content[0] as { text: string }).text) as CancelPayload;

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected a committed node");
  return value;
};

test("ignores the pre-turn sibling branch, synthesizes interrupted results, and cancels once", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  await h.appendOldBranch(root, "old");
  const startOffset = await h.store.commitOffset(SID);
  await h.markers.write(SID, {
    turnId: T1,
    startedAt: NOW,
    startOffset,
    startNodeId: root,
  });
  const endpoint = await h.appendTurnAssistant(root, "turn", "call_1");

  const issues = await recoverActiveTurns(h.deps);

  expect(issues).toEqual([]);
  const nodes = await h.tree();
  expect(nodes).toHaveLength(5);
  const tail = nodes.slice(-2);
  expect(tail[0]).toMatchObject({
    kind: "agent",
    role: "tool",
    source: "recovery",
    content: [{ type: "toolResult", toolCallId: "call_1", synthetic: "interrupted" }],
  });
  expect(JSON.parse((required(tail[1]).content[0] as { text: string }).text)).toEqual({
    turnId: T1,
    reason: "daemon_restart",
    at: endpoint.id,
  });
  expect(nodes.at(-2)?.parentId).toBe(endpoint.id);
  expect(nodes.at(-1)?.parentId).toBe(nodes.at(-2)?.id);
  expect(nodes.filter((node) => node.role === "tool")).toHaveLength(1);
  expect(await h.markers.read(SID)).toBeUndefined();
});

test("a temporary session marker without startNodeId starts from the root", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  await h.markers.write(SID, { turnId: T1, startedAt: NOW, startOffset: 0 });
  const endpoint = await h.appendTurnAssistant(root, "turn", "call_1");

  expect(await recoverActiveTurns(h.deps)).toEqual([]);

  const nodes = await h.tree();
  expect(nodes.at(-2)?.parentId).toBe(endpoint.id);
  expect(nodes.at(-2)).toMatchObject({
    kind: "agent",
    role: "tool",
    content: [{ type: "toolResult", toolCallId: "call_1", synthetic: "interrupted" }],
  });
  expect(cancelPayload(required(nodes.at(-1))).at).toBe(endpoint.id);
  expect(await h.markers.read(SID)).toBeUndefined();
});

test("a call with an existing toolResult gets no synthetic node", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  const startOffset = await h.store.commitOffset(SID);
  await h.markers.write(SID, { turnId: T1, startedAt: NOW, startOffset, startNodeId: root });
  const assistant = await h.appendTurnAssistant(root, "turn", "call_1");
  const result = await h.appendToolResult(assistant.id, "result", "call_1");
  const before = await h.tree();

  expect(await recoverActiveTurns(h.deps)).toEqual([]);

  const nodes = await h.tree();
  expect(nodes).toHaveLength(before.length + 1);
  expect(nodes.at(-1)).toMatchObject({ kind: "control", role: "cancel" });
  expect(cancelPayload(required(nodes.at(-1))).at).toBe(result.id);
  expect(nodes.filter((node) => node.synthetic === "interrupted")).toEqual([]);
  expect(await h.markers.read(SID)).toBeUndefined();
});

test("a same-turn cancel on the walked path deletes the marker without appending", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  const startOffset = await h.store.commitOffset(SID);
  await h.markers.write(SID, { turnId: T1, startedAt: NOW, startOffset, startNodeId: root });
  await h.appendCancel(root, { turnId: T1, reason: "daemon_restart", at: root });
  const before = await h.tree();

  expect(await recoverActiveTurns(h.deps)).toEqual([]);

  expect(await h.tree()).toEqual(before);
  expect(await h.markers.read(SID)).toBeUndefined();
});

test("a same-turn cancel on a non-selected sibling branch is ignored", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  const startOffset = await h.store.commitOffset(SID);
  await h.markers.write(SID, { turnId: T1, startedAt: NOW, startOffset, startNodeId: root });
  const sibling = await h.appendCancel(root, {
    turnId: T1,
    reason: "daemon_restart",
    at: root,
  });
  const endpoint = await h.appendTurnAssistant(root, "turn", "call_1");

  expect(await recoverActiveTurns(h.deps)).toEqual([]);

  const nodes = await h.tree();
  const cancels = nodes.filter((node) => node.role === "cancel");
  expect(cancels).toHaveLength(2);
  expect(required(cancels[0]).id).toBe(sibling.id);
  expect(cancelPayload(required(cancels[1])).at).toBe(endpoint.id);
  expect(nodes.at(-2)).toMatchObject({
    role: "tool",
    content: [{ type: "toolResult", toolCallId: "call_1", synthetic: "interrupted" }],
  });
  expect(await h.markers.read(SID)).toBeUndefined();
});

test("a same-turn cancel committed before startOffset is ignored", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  const early = await h.appendCancel(root, { turnId: T1, reason: "daemon_restart", at: root });
  const startOffset = await h.store.commitOffset(SID);
  await h.markers.write(SID, {
    turnId: T1,
    startedAt: NOW,
    startOffset,
    startNodeId: early.id,
  });
  const endpoint = await h.appendTurnAssistant(early.id, "turn", "call_1");

  expect(await recoverActiveTurns(h.deps)).toEqual([]);

  const nodes = await h.tree();
  const cancels = nodes.filter((node) => node.role === "cancel");
  expect(cancels).toHaveLength(2);
  expect(required(cancels[0]).id).toBe(early.id);
  expect(cancelPayload(required(cancels[1])).at).toBe(endpoint.id);
  expect(nodes.at(-2)).toMatchObject({
    role: "tool",
    content: [{ type: "toolResult", toolCallId: "call_1", synthetic: "interrupted" }],
  });
  expect(await h.markers.read(SID)).toBeUndefined();
});

test("an append that commits before throwing keeps the marker and dedupes next run", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  const startOffset = await h.store.commitOffset(SID);
  const marker: ActiveTurnMarker = {
    turnId: T1,
    startedAt: NOW,
    startOffset,
    startNodeId: root,
  };
  await h.markers.write(SID, marker);
  await h.appendTurnAssistant(root, "turn", "call_1");
  h.failNextAppendAfterCommit();

  const issues = await recoverActiveTurns(h.deps);

  expect(issues).toMatchObject([{ sessionId: SID, error: { code: "storage.io" } }]);
  expect(await h.markers.read(SID)).toEqual(marker);
  const first = await h.tree();
  expect(first.at(-1)).toMatchObject({ kind: "control", role: "cancel" });

  expect(await recoverActiveTurns(h.deps)).toEqual([]);

  expect(await h.tree()).toEqual(first);
  expect(await h.markers.read(SID)).toBeUndefined();
});

test("a pure append failure reports one issue and keeps the marker", async () => {
  const h = await createRecoveryHarness();
  const root = await h.appendRoot("n1");
  const startOffset = await h.store.commitOffset(SID);
  await h.markers.write(SID, { turnId: T1, startedAt: NOW, startOffset, startNodeId: root });
  await h.appendTurnAssistant(root, "turn", "call_1");
  const before = await h.tree();
  h.deps.sessions = {
    ...h.deps.sessions,
    async append() {
      throw new PiscesError("storage.io", "Append failed before commit");
    },
  };

  const issues = await recoverActiveTurns(h.deps);

  expect(issues).toMatchObject([{ sessionId: SID, error: { code: "storage.io" } }]);
  expect(await h.tree()).toEqual(before);
  expect(await h.markers.read(SID)).toBeDefined();
});

test("missing and corrupt sessions keep their markers", async () => {
  const missing = await createRecoveryHarness();
  await mkdir(join(missing.dataDir, "sessions", SID), { recursive: true });
  await missing.markers.write(SID, { turnId: T1, startedAt: NOW, startOffset: 0 });
  const missingIssues = await recoverActiveTurns(missing.deps);
  expect(missingIssues).toMatchObject([{ sessionId: SID, error: { code: "session.not_found" } }]);
  expect(await missing.markers.read(SID)).toBeDefined();

  const corrupt = await createRecoveryHarness();
  const root = await corrupt.appendRoot("n1");
  const startOffset = await corrupt.store.commitOffset(SID);
  await corrupt.markers.write(SID, {
    turnId: T2,
    startedAt: NOW,
    startOffset,
    startNodeId: root,
  });
  await writeFile(join(corrupt.dataDir, "sessions", SID, "events.commit"), "{");
  const restarted = createSessionStore({ dataDir: corrupt.dataDir });
  const initialization = await restarted.initialize();
  expect(initialization).toMatchObject([{ sessionId: SID, error: { code: "storage.corrupt" } }]);
  const corruptIssues = await recoverActiveTurns({
    store: restarted,
    markers: corrupt.markers,
    sessions: corrupt.deps.sessions,
  });
  expect(corruptIssues).toMatchObject([{ sessionId: SID, error: { code: "storage.corrupt" } }]);
  expect(await corrupt.markers.read(SID)).toBeDefined();
});

test("a marker whose startNodeId is absent reports session.node_not_found", async () => {
  const h = await createRecoveryHarness();
  await h.appendRoot("n1");
  await h.markers.write(SID, {
    turnId: T1,
    startedAt: NOW,
    startOffset: await h.store.commitOffset(SID),
    startNodeId: "missing" as NodeId,
  });

  const issues = await recoverActiveTurns(h.deps);

  expect(issues).toMatchObject([{ sessionId: SID, error: { code: "session.node_not_found" } }]);
  expect(await h.markers.read(SID)).toBeDefined();
});

test("recovery before store initialization throws and leaves the marker", async () => {
  const h = await createRecoveryHarness({ initialize: false });
  await mkdir(join(h.dataDir, "sessions", SID), { recursive: true });
  const marker: ActiveTurnMarker = {
    turnId: T1,
    startedAt: NOW,
    startOffset: 0,
    startNodeId: "n1" as NodeId,
  };
  await h.markers.write(SID, marker);

  await expect(recoverActiveTurns(h.deps)).rejects.toBeInstanceOf(TypeError);

  expect(await h.markers.read(SID)).toEqual(marker);
});

test("a corrupt marker does not block recovery of a healthy session", async () => {
  const good = "good" as SessionId;
  const bad = "bad" as SessionId;
  const h = await createRecoveryHarness({ sessionId: good });
  const root = await h.appendRoot("n1");
  const startOffset = await h.store.commitOffset(good);
  await h.markers.write(good, {
    turnId: T1,
    startedAt: NOW,
    startOffset,
    startNodeId: root,
  });
  await h.appendTurnAssistant(root, "turn", "call_1");
  await mkdir(join(h.dataDir, "sessions", bad), { recursive: true });
  const badPath = join(h.dataDir, "sessions", bad, "active-turn.json");
  const badMarker = JSON.stringify({ turnId: T1, startedAt: NOW, startOffset: 0, extra: true });
  await writeFile(badPath, badMarker);

  const issues = await recoverActiveTurns(h.deps);

  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ sessionId: bad, error: { code: "storage.corrupt" } });
  expect(await readFile(badPath, "utf8")).toBe(badMarker);
  const nodes: SessionNode[] = [];
  for await (const node of h.store.readTree(good)) nodes.push(node);
  expect(nodes.at(-2)).toMatchObject({
    role: "tool",
    content: [{ type: "toolResult", toolCallId: "call_1", synthetic: "interrupted" }],
  });
  expect(nodes.at(-1)).toMatchObject({ role: "cancel" });
  expect(await h.markers.read(good)).toBeUndefined();
});

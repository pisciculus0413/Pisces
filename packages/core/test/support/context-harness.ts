import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ContextDeps,
  type ContextEvent,
  createContext,
  createSessions,
  type DeclarationPayload,
  type NodeId,
  type QueueEntryId,
  type QueueEntryInput,
  type SessionId,
  type SessionMeta,
  type SessionRepository,
} from "../../src/index.js";
import { MemorySessionRepository } from "./memory-session-repository.js";

export const NOW = "2026-11-07T00:00:00.000Z";
export const META: SessionMeta = {
  id: "s1" as SessionId,
  model: "model",
  provider: "provider",
  workspace: "/workspace",
  createdAt: NOW,
  schemaVersion: 1,
};

/** Queue-compatible declaration fixture, also accepted by Sessions draft methods. */
export function declaration(payload: DeclarationPayload): QueueEntryInput {
  return {
    kind: "control",
    role: "declaration",
    source: "user",
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

export function createContextHarness(overrides: Partial<ContextDeps> = {}) {
  const repository = new MemorySessionRepository();
  let readFailure: Error | undefined;
  let writeFailure: Error | undefined;
  let postcommitFailure: Error | undefined;
  let treeReadFailure: Error | undefined;
  function checkPostcommit() {
    if (postcommitFailure) {
      const error = postcommitFailure;
      postcommitFailure = undefined;
      throw error;
    }
  }
  function checkWrite() {
    if (writeFailure) {
      const error = writeFailure;
      writeFailure = undefined;
      throw error;
    }
  }
  async function* read<T>(items: AsyncIterable<T>): AsyncIterable<T> {
    if (readFailure) {
      const error = readFailure;
      readFailure = undefined;
      throw error;
    }
    yield* items;
  }
  const faults: SessionRepository = {
    create: async (meta, nodes) => {
      checkWrite();
      await repository.create(meta, nodes);
      checkPostcommit();
    },
    append: async (id, nodes) => {
      checkWrite();
      await repository.append(id, nodes);
      checkPostcommit();
    },
    updateMeta: async (id, meta) => {
      checkWrite();
      await repository.updateMeta(id, meta);
    },
    readBranch: (id, nodeId) => read(repository.readBranch(id, nodeId)),
    readTree: async function* (id) {
      if (treeReadFailure) {
        const error = treeReadFailure;
        treeReadFailure = undefined;
        throw error;
      }
      yield* read(repository.readTree(id));
    },
    list: () => repository.list(),
  };
  let nodeId = 0;
  let queueId = 0;
  let seq = 0;
  const sessions = createSessions({
    repository: faults,
    newId: () => `n${++nodeId}` as NodeId,
    now: () => NOW,
  });
  const events: ContextEvent[] = [];
  const eventClock = { current: () => seq, next: () => ++seq };
  const ownership = new AsyncLocalStorage<boolean>();
  let tail = Promise.resolve();
  async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (ownership.getStore()) throw new Error("Session lock is not reentrant");
    const previous = tail;
    const done = gate();
    tail = done.promise;
    await previous;
    try {
      return await ownership.run(true, task);
    } finally {
      done.release();
    }
  }
  const deps: ContextDeps = {
    sessionId: META.id,
    meta: structuredClone(META),
    persisted: false,
    sessions,
    entries: { kind: () => undefined },
    skills: { selected: () => [] },
    sources: { get: () => undefined },
    events: { publish: (event) => events.push(event) },
    eventClock,
    runExclusive,
    newId: () => `q${++queueId}` as QueueEntryId,
    now: () => NOW,
    ...overrides,
  };
  return {
    context: createContext(deps),
    deps,
    repository,
    sessions,
    events,
    eventClock,
    runExclusive,
    isLocked: () => ownership.getStore() === true,
    failNextWriteAfterCommit(error: Error) {
      postcommitFailure = error;
    },
    failNextTreeRead(error: Error) {
      treeReadFailure = error;
    },
    failNextRead(error: Error) {
      readFailure = error;
    },
    failNextWrite(error: Error) {
      writeFailure = error;
    },
  };
}

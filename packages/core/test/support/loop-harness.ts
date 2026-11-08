import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentLoopDriverOptions,
  type ContentBlock,
  type ContextDeps,
  type ContextEvent,
  createAgentLoopDriver,
  createContext,
  createSessions,
  createTools,
  type EngineEvent,
  type EventBus,
  type NodeId,
  type QueueEntryId,
  type QueueEntryInput,
  type SessionId,
  type SessionMeta,
  type Tools,
} from "../../src/index.js";
import { MemorySessionRepository } from "./memory-session-repository.js";

export const LOOP_NOW = "2026-11-08T00:00:00.000Z";
export const LOOP_META: SessionMeta = {
  id: "s1" as SessionId,
  model: "model",
  provider: "provider",
  workspace: "/workspace",
  createdAt: LOOP_NOW,
  schemaVersion: 1,
};

export function text(value: string): ContentBlock[] {
  return [{ type: "text", text: value }];
}

export function user(value: string): QueueEntryInput {
  return { kind: "agent", role: "user", source: "user", content: text(value) };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function createLoopHarness(overrides: { tools?: Tools } = {}) {
  const repository = new MemorySessionRepository();
  let nodeId = 0;
  let queueId = 0;
  let seq = 0;
  const sessions = createSessions({
    repository,
    newId: () => `n${++nodeId}` as NodeId,
    now: () => LOOP_NOW,
  });
  const published: EngineEvent[] = [];
  const handlers = new Set<(event: EngineEvent) => void>();
  const events: EventBus = {
    publish(event) {
      published.push(structuredClone(event));
      for (const handler of handlers) handler(event);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const contextEvents = {
    publish(event: ContextEvent) {
      events.publish(event as EngineEvent);
    },
  };
  const ownership = new AsyncLocalStorage<boolean>();
  let tail = Promise.resolve();
  let driverLocks = 0;
  async function baseRunExclusive<T>(task: () => Promise<T>): Promise<T> {
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

  let pendingHold:
    | {
        step: number;
        reached: ReturnType<typeof gate>;
        release: ReturnType<typeof gate>;
        blockNextDriverLock: boolean;
      }
    | undefined;
  events.subscribe((event) => {
    if (
      pendingHold &&
      event.type === "turn.step" &&
      (event.data as { step?: number }).step === pendingHold.step
    )
      pendingHold.blockNextDriverLock = true;
  });

  const driverRunExclusive = async <T>(_sessionId: SessionId, task: () => Promise<T>) => {
    driverLocks++;
    if (pendingHold?.blockNextDriverLock) {
      pendingHold.blockNextDriverLock = false;
      pendingHold.reached.release();
      await pendingHold.release.promise;
    }
    return baseRunExclusive(task);
  };
  const options: AgentLoopDriverOptions = {
    runExclusive: driverRunExclusive,
    now: () => LOOP_NOW,
  };
  const tools = overrides.tools ?? createTools();
  const deps: ContextDeps = {
    sessionId: LOOP_META.id,
    meta: structuredClone(LOOP_META),
    persisted: false,
    sessions,
    entries: { kind: () => undefined },
    skills: { selected: () => [] },
    sources: { get: () => undefined },
    events: contextEvents,
    eventClock: { current: () => seq, next: () => ++seq },
    runExclusive: baseRunExclusive,
    newId: () => `q${++queueId}` as QueueEntryId,
    now: () => LOOP_NOW,
  };
  const context = createContext(deps);

  async function enqueue(entries: QueueEntryInput[], confirm = true) {
    return baseRunExclusive(async () => {
      const ids = context.enqueue(entries);
      if (confirm) context.confirm();
      return ids;
    });
  }

  return {
    context,
    deps,
    driver: createAgentLoopDriver(options),
    driverLockCount: () => driverLocks,
    enqueue,
    enqueueAndConfirm: (entries: QueueEntryInput[]) => enqueue(entries, true),
    eventClock: deps.eventClock,
    events,
    handlers,
    holdAfterStep(step: number) {
      const reached = gate();
      const release = gate();
      pendingHold = { step, reached, release, blockNextDriverLock: false };
      return { reached: reached.promise, release: release.release };
    },
    isLocked: () => ownership.getStore() === true,
    now: () => LOOP_NOW,
    published,
    repository,
    resetDriverLockCount: () => {
      driverLocks = 0;
    },
    runExclusive: baseRunExclusive,
    sessions,
    tools,
  };
}

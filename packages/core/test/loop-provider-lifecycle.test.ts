import { expect, test } from "vitest";
import {
  type ExecuteProvider,
  type LlmAdapter,
  type LlmEvent,
  PiscesError,
  type SessionNode,
  type TurnId,
} from "../src/index.js";
import { createLoopHarness, LOOP_META, user } from "./support/loop-harness.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function adapterFor(parseChunk: (chunk: string) => LlmEvent[]): LlmAdapter {
  return {
    dialect: "fake",
    buildRequest: (request) => ({ path: "/chat", body: JSON.stringify(request) }),
    parseChunk,
  };
}

function executeWith(iterator: AsyncIterator<string>): ExecuteProvider {
  return () => ({
    [Symbol.asyncIterator]: () => iterator,
  });
}

function run(
  harness: ReturnType<typeof createLoopHarness>,
  adapter: LlmAdapter,
  execute: ExecuteProvider,
  signal = new AbortController().signal,
) {
  return harness.driver.run({
    sessionId: LOOP_META.id,
    turnId: "t1" as TurnId,
    meta: LOOP_META,
    context: harness.context,
    sessions: harness.sessions,
    tools: harness.tools,
    adapter,
    execute,
    events: harness.events,
    eventClock: harness.eventClock,
    contextWindow: 100000,
    maxOutput: 1000,
    signal,
  });
}

async function tree(harness: ReturnType<typeof createLoopHarness>) {
  const nodes: SessionNode[] = [];
  for await (const node of harness.sessions.readTree(LOOP_META.id)) nodes.push(node);
  return nodes;
}

test("closes the provider iterator after a parser failure", async () => {
  const harness = createLoopHarness();
  await harness.enqueueAndConfirm([user("hello")]);
  let closed = 0;
  const execute: ExecuteProvider = async function* () {
    try {
      yield "frame";
      await new Promise(() => {});
    } finally {
      closed++;
    }
  };
  const adapter = adapterFor(() => {
    throw new PiscesError("provider.invalid_response", "Provider returned an invalid response");
  });

  const result = await run(harness, adapter, execute);

  expect(result).toMatchObject({
    reason: "failed",
    error: {
      code: "provider.invalid_response",
      message: "Provider returned an invalid response",
    },
  });
  expect(closed).toBe(1);
});

test("closes the provider iterator after delta publication fails", async () => {
  const harness = createLoopHarness();
  await harness.enqueueAndConfirm([user("hello")]);
  let closed = 0;
  const execute: ExecuteProvider = async function* () {
    try {
      yield JSON.stringify([{ type: "content", delta: "partial" }]);
      await new Promise(() => {});
    } finally {
      closed++;
    }
  };
  const adapter = adapterFor((chunk) => JSON.parse(chunk) as LlmEvent[]);
  harness.events.subscribe((event) => {
    if (event.type === "turn.delta") throw new Error("publish failed");
  });

  const result = await run(harness, adapter, execute);

  expect(result).toMatchObject({
    reason: "failed",
    error: { code: "event.publish_failed" },
  });
  expect(closed).toBe(1);
});

test("closes the provider iterator after cancellation interrupts the next read", async () => {
  const harness = createLoopHarness();
  await harness.enqueueAndConfirm([user("hello")]);
  const deltaPublished = gate();
  let reads = 0;
  let closed = 0;
  const iterator: AsyncIterator<string> = {
    async next() {
      reads++;
      if (reads === 1) {
        return {
          done: false,
          value: JSON.stringify([{ type: "content", delta: "partial" }]),
        };
      }
      return new Promise((_resolve, reject) => {
        const signal = observedSignal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    async return() {
      closed++;
      return { done: true, value: undefined };
    },
  };
  let observedSignal: AbortSignal | undefined;
  const execute: ExecuteProvider = (_request, signal) => {
    observedSignal = signal;
    return {
      [Symbol.asyncIterator]: () => iterator,
    };
  };
  harness.events.subscribe((event) => {
    if (event.type === "turn.delta") deltaPublished.resolve();
  });

  const pending = run(
    harness,
    adapterFor((chunk) => JSON.parse(chunk) as LlmEvent[]),
    execute,
  );
  await deltaPublished.promise;
  await expect(harness.driver.cancel("t1" as TurnId)).resolves.toBe(true);
  const result = await pending;

  expect(result.reason).toBe("cancelled");
  expect(closed).toBe(1);
});

test("does not return a naturally completed provider iterator twice", async () => {
  const harness = createLoopHarness();
  await harness.enqueueAndConfirm([user("hello")]);
  let reads = 0;
  let closed = 0;
  const iterator: AsyncIterator<string> = {
    async next() {
      reads++;
      if (reads === 1)
        return {
          done: false,
          value: JSON.stringify([
            { type: "content", delta: "done" },
            { type: "stop", reason: "stop" },
          ]),
        };
      return { done: true, value: undefined };
    },
    async return() {
      closed++;
      return { done: true, value: undefined };
    },
  };

  const result = await run(
    harness,
    adapterFor((chunk) => JSON.parse(chunk) as LlmEvent[]),
    executeWith(iterator),
  );

  expect(result.reason).toBe("completed");
  expect(closed).toBe(0);
  expect((await tree(harness)).map((node) => node.role)).toEqual(["user", "assistant"]);
});

test("ignores iterator cleanup failure and preserves the parser error", async () => {
  const harness = createLoopHarness();
  await harness.enqueueAndConfirm([user("hello")]);
  let reads = 0;
  let closed = 0;
  const iterator: AsyncIterator<string> = {
    async next() {
      reads++;
      if (reads === 1) return { done: false, value: "frame" };
      return { done: true, value: undefined };
    },
    async return() {
      closed++;
      throw new Error("cleanup secret");
    },
  };
  const adapter = adapterFor(() => {
    throw new PiscesError("provider.invalid_response", "Provider returned an invalid response");
  });

  const result = await run(harness, adapter, executeWith(iterator));

  expect(result).toMatchObject({
    reason: "failed",
    error: {
      code: "provider.invalid_response",
      message: "Provider returned an invalid response",
    },
  });
  expect(closed).toBe(1);
  expect(JSON.stringify(result)).not.toContain("cleanup secret");
});

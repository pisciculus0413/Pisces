import { expect, test } from "vitest";
import { createSessionEventClock } from "../src/runtime/event-clock.js";

test("allocates monotonically without allocating on snapshot", () => {
  const clock = createSessionEventClock();
  expect(clock.current()).toBe(0);
  expect(clock.next()).toBe(1);
  expect(clock.next()).toBe(2);
  expect(clock.current()).toBe(2);
  expect(clock.current()).toBe(2);
  expect(createSessionEventClock(5).next()).toBe(6);
  expect(() => createSessionEventClock(-1)).toThrow(TypeError);
});

test("keeps separate clocks independent", () => {
  const first = createSessionEventClock();
  const second = createSessionEventClock();
  expect(first.next()).toBe(1);
  expect(first.next()).toBe(2);
  expect(second.next()).toBe(1);
  expect(first.current()).toBe(2);
  expect(second.current()).toBe(1);
});

test("stays strictly increasing across many allocations", () => {
  const clock = createSessionEventClock(10);
  let previous = clock.current();
  for (let index = 0; index < 1000; index += 1) {
    const allocated = clock.next();
    expect(allocated).toBeGreaterThan(previous);
    previous = allocated;
  }
  expect(clock.current()).toBe(previous);
});

test("fails on overflow without changing the current value", () => {
  const clock = createSessionEventClock(Number.MAX_SAFE_INTEGER);
  expect(clock.current()).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => clock.next()).toThrow(RangeError);
  expect(clock.current()).toBe(Number.MAX_SAFE_INTEGER);
});

test("rejects initial values that are not nonnegative safe integers", () => {
  expect(() => createSessionEventClock(-1)).toThrow(TypeError);
  expect(() => createSessionEventClock(1.5)).toThrow(TypeError);
  expect(() => createSessionEventClock(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
});

test("exports the runtime foundations from the daemon package", async () => {
  const daemon = await import("../src/index.js");
  expect(daemon.createConcurrency).toBeTypeOf("function");
  expect(daemon.createEventBus).toBeTypeOf("function");
  expect(daemon.createSessionEventClock).toBeTypeOf("function");
});

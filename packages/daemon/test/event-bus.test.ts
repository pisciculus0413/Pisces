import type { EngineEvent } from "@pisces/core";
import { expect, test } from "vitest";
import { createEventBus } from "../src/runtime/event-bus.js";

const event = (type: string): EngineEvent => ({
  type,
  at: "2026-11-08T00:00:00.000Z",
  data: {},
});

test("delivers in subscription order, attempts every handler, and rethrows the first failure", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  const failure = new Error("first");
  const off = bus.subscribe((received) => {
    seen.push(`a:${received.type}`);
    throw failure;
  });
  bus.subscribe((received) => seen.push(`b:${received.type}`));
  expect(() => bus.publish(event("turn.started"))).toThrow(failure);
  expect(seen).toEqual(["a:turn.started", "b:turn.started"]);
  off();
  off();
  bus.publish(event("turn.step"));
  expect(seen).toEqual(["a:turn.started", "b:turn.started", "b:turn.step"]);
});

test("rethrows the first failure unchanged when several handlers throw", () => {
  const bus = createEventBus();
  const first = new Error("first");
  const second = new Error("second");
  const seen: string[] = [];
  bus.subscribe(() => {
    seen.push("a");
    throw first;
  });
  bus.subscribe(() => {
    seen.push("b");
    throw second;
  });
  bus.subscribe(() => seen.push("c"));
  let thrown: unknown;
  try {
    bus.publish(event("turn.started"));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(first);
  expect(seen).toEqual(["a", "b", "c"]);
});

test("publishing with no subscribers is a no-op", () => {
  const bus = createEventBus();
  expect(() => bus.publish(event("turn.started"))).not.toThrow();
});

test("unsubscribing during a publish does not change the in-flight snapshot", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  let offB: () => void = () => {};
  bus.subscribe(() => {
    seen.push("a");
    offB();
  });
  offB = bus.subscribe(() => seen.push("b"));
  bus.publish(event("turn.started"));
  expect(seen).toEqual(["a", "b"]);
  bus.publish(event("turn.step"));
  expect(seen).toEqual(["a", "b", "a"]);
});

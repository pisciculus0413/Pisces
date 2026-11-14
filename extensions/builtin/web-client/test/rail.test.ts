import { expect, test } from "vitest";
import { computeRail } from "../web/src/rail.js";

/**
 * The rail is read top-down like a git log, newest last.
 *
 * The branch that ends at the active tip stays on lane 0 for its whole length;
 * any other branch hangs off to the side, opening a lane at its fork row and
 * closing it at its own last node.
 */

const cell = (id: string, parentId: string) => ({ id, parentId });

test("keeps the active chain on lane 0", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "b")]);

  expect(rail.map((entry) => [entry.id, entry.lane, entry.branch])).toEqual([
    ["a", 0, false],
    ["b", 0, false],
    ["c", 0, false],
  ]);
  expect(rail.map((entry) => entry.lanes)).toEqual([[0], [0], [0]]);
  expect(rail[2]).toMatchObject({ end: true, parentLane: 0 });
});

test("hangs a non-active branch off to the side of the active chain", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "a")]);

  // `c` is the newest node, so `a -> c` is the active chain and `b` is the branch.
  expect(rail.map((entry) => [entry.id, entry.lane, entry.branch, entry.parentLane])).toEqual([
    ["a", 0, false, 0],
    ["b", 1, true, 0],
    ["c", 0, false, 0],
  ]);
  expect(rail[1]?.lanes).toEqual([0, 1]);
  expect(rail[1]?.end).toBe(true);
  expect(rail[2]?.lanes).toEqual([0]);
});

test("keeps a side branch on its own lane while it continues", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "b"), cell("d", "a")]);

  // `d` is newest, so a -> d is active and a -> b -> c is the side branch.
  expect(rail.map((entry) => [entry.id, entry.lane, entry.branch])).toEqual([
    ["a", 0, false],
    ["b", 1, true],
    ["c", 1, false],
    ["d", 0, false],
  ]);
  expect(rail.map((entry) => entry.lanes)).toEqual([[0], [0, 1], [0, 1], [0]]);
  expect(rail.map((entry) => entry.end)).toEqual([false, false, true, true]);
});

test("gives each sibling branch its own side lane", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "a"), cell("d", "a")]);

  expect(rail.map((entry) => [entry.id, entry.lane])).toEqual([
    ["a", 0],
    ["b", 1],
    ["c", 2],
    ["d", 0],
  ]);
  expect(rail[3]?.lanes).toEqual([0]);
  expect(rail.map((entry) => entry.color)).toEqual([0, 1, 2, 0]);
});

test("follows the newest child back onto lane 0 when the tip is on a branch", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "a"), cell("d", "c")]);

  // `d` is newest, so the active chain is a -> c -> d: it must be straight.
  expect(rail.map((entry) => [entry.id, entry.lane, entry.branch])).toEqual([
    ["a", 0, false],
    ["b", 1, true],
    ["c", 0, false],
    ["d", 0, false],
  ]);
  expect(rail[1]?.lanes).toEqual([0, 1]);
  expect(rail[2]?.lanes).toEqual([0]);
  expect(rail[3]?.lanes).toEqual([0]);
});

test("accepts an explicit active tip", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "a")], "b");

  // With `b` as the pending branch point, `a -> b` is the active chain.
  expect(rail.map((entry) => [entry.id, entry.lane, entry.branch])).toEqual([
    ["a", 0, false],
    ["b", 0, false],
    ["c", 1, true],
  ]);
  expect(rail[2]?.lanes).toEqual([0, 1]);
});

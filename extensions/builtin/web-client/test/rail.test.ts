import { expect, test } from "vitest";
import { computeRail } from "../web/src/rail.js";

/**
 * The record column draws a git-like rail: every node is a dot on a lane, a fork
 * from an earlier node opens a new lane to the right, and lanes never merge
 * because a session tree only ever appends.
 */

const cell = (id: string, parentId: string) => ({ id, parentId });

test("keeps a linear chain on lane 0", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "b")]);

  expect(rail.map((entry) => [entry.id, entry.lane, entry.branch])).toEqual([
    ["a", 0, false],
    ["b", 0, false],
    ["c", 0, false],
  ]);
  expect(rail[2]?.lanes).toEqual([0]);
});

test("starts a new lane when a node forks from an earlier node", () => {
  const rail = computeRail([cell("a", "a"), cell("b", "a"), cell("c", "a")]);

  expect(rail.map((entry) => [entry.id, entry.lane, entry.branch])).toEqual([
    ["a", 0, false],
    ["b", 0, false],
    ["c", 1, true],
  ]);
  expect(rail[1]?.lanes).toEqual([0]);
  expect(rail[2]?.lanes).toEqual([0, 1]);
});

test("keeps a branch on its own lane while it continues", () => {
  const rail = computeRail([
    cell("a", "a"),
    cell("b", "a"),
    cell("c", "a"),
    cell("d", "c"),
    cell("e", "d"),
  ]);

  expect(rail.slice(2).map((entry) => [entry.id, entry.lane, entry.branch])).toEqual([
    ["c", 1, true],
    ["d", 1, false],
    ["e", 1, false],
  ]);
  expect(rail[4]?.lanes).toEqual([0, 1]);
});

test("never allocates a lane twice", () => {
  const rail = computeRail([
    cell("root", "root"),
    cell("b", "root"),
    cell("c", "root"),
    cell("d", "root"),
  ]);

  expect(rail.map((entry) => entry.lane)).toEqual([0, 0, 1, 2]);
  expect(rail[3]?.lanes).toEqual([0, 1, 2]);
});

test("cycles the four rail colors", () => {
  const rail = computeRail([
    cell("root", "root"),
    cell("b", "root"),
    cell("c", "root"),
    cell("d", "root"),
    cell("e", "root"),
    cell("f", "root"),
  ]);

  expect(rail.map((entry) => entry.color)).toEqual([0, 0, 1, 2, 3, 0]);
});

import { expect, test } from "vitest";
import type { EntryName, SelectionState } from "../src/index.js";
import {
  decodeCompactWireName,
  decodeWireName,
  encodeCompactWireName,
  encodeWireName,
} from "../src/index.js";

test("encodes EntryName deterministically with the URL-safe UTF-16LE charset", () => {
  expect(encodeWireName("pkg#echo" as EntryName)).toBe("t_cABrAGcAIwBlAGMAaABvAA");
  expect(encodeWireName("pkg#工具" as EntryName)).toMatch(/^t_[A-Za-z0-9_-]+$/);
  expect(decodeWireName("t_cABrAGcAIwBlAGMAaABvAA")).toBe("pkg#echo");
  expect(decodeWireName(encodeWireName("pkg#🙂" as EntryName))).toBe("pkg#🙂");
});

test.each(["", "pkg#echo", "t_", "t_a", "t_%%%", "t_cABrAGcAIwBlAGMAaABvAA="])(
  "returns undefined for malformed wire name %j",
  (value) => expect(decodeWireName(value)).toBeUndefined(),
);

test("round-trips distinct lone UTF-16 surrogates without collision", () => {
  const low = "pkg#\ud800" as EntryName;
  const high = "pkg#\udfff" as EntryName;
  const lowWireName = encodeWireName(low);
  const highWireName = encodeWireName(high);

  expect(lowWireName).not.toBe(highWireName);
  expect(decodeWireName(lowWireName)).toBe(low);
  expect(decodeWireName(highWireName)).toBe(high);
});

test("exports SelectionState from the core entry point", () => {
  const selection: SelectionState = ["pkg#echo" as EntryName];
  expect(selection).toEqual(["pkg#echo"]);
});

test("encodes long ASCII names compactly so they fit provider limits", () => {
  const shell = "@pisces/builtin-shell#shell" as EntryName;
  expect(encodeWireName(shell).length).toBeGreaterThan(64);
  const compact = encodeCompactWireName(shell);
  expect(compact).toBeDefined();
  expect(compact?.length).toBeLessThanOrEqual(64);
  expect(compact).toMatch(/^u_[A-Za-z0-9_-]+$/);
  expect(decodeCompactWireName(compact as string)).toBe(shell);
  expect(decodeCompactWireName(encodeCompactWireName("pkg#echo" as EntryName) as string)).toBe(
    "pkg#echo",
  );
});

test("decodes every padded input byte instead of masking the final quantum", () => {
  // Regression: the decoder used to drop bits from the last base64 character.
  expect(decodeWireName("t_d1FAAOVdIwAzAA")).toBe("具@工#3");
});

test("compact encoding round-trips an ASCII entry and refuses non-ASCII", () => {
  const ascii = "pkg#echo" as EntryName;
  const compact = encodeCompactWireName(ascii);
  expect(compact).toBeDefined();
  expect(decodeCompactWireName(compact as string)).toBe(ascii);
  expect(encodeCompactWireName("pkg#工具" as EntryName)).toBeUndefined();
});

test("compact encoding refuses non-ASCII and malformed values", () => {
  expect(encodeCompactWireName("pkg#工具" as EntryName)).toBeUndefined();
  expect(encodeCompactWireName("pkg#🙂" as EntryName)).toBeUndefined();
  expect(decodeCompactWireName("u_")).toBeUndefined();
  expect(decodeCompactWireName("u_%%%")).toBeUndefined();
  expect(decodeCompactWireName("u_a")).toBeUndefined();
  expect(decodeCompactWireName("t_cABrAGcAIwBlAGMAaABvAA")).toBeUndefined();
  // Trailing bits that do not canonicalize are rejected.
  expect(decodeCompactWireName("u_cABrZWNobx")).toBeUndefined();
});

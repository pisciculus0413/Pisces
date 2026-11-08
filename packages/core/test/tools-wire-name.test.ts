import { expect, test } from "vitest";
import type { EntryName, SelectionState } from "../src/index.js";
import { decodeWireName, encodeWireName } from "../src/index.js";

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

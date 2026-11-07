import { expect, test } from "vitest";
import { PiscesError } from "../src/index.js";

test("preserves domain error details and cause", () => {
  const cause = new Error("disk full");
  const data = { operation: "append" };
  const error = new PiscesError("storage.io", "write failed", { data, cause });
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("PiscesError");
  expect(error.code).toBe("storage.io");
  expect(error.message).toBe("write failed");
  expect(error.data).toBe(data);
  expect(error.cause).toBe(cause);
});

test("allows omitted error options", () => {
  const error = new PiscesError("storage.io", "write failed");
  expect(error.data).toBeUndefined();
  expect(error.cause).toBeUndefined();
});

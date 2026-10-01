import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.ts";

describe("PROTOCOL_VERSION", () => {
  it("符合 semver 结构", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

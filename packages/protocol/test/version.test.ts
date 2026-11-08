import { describe, expect, it } from "vitest";
import { negotiateVersion, PROTOCOL_VERSION } from "../src/index.ts";

describe("PROTOCOL_VERSION", () => {
  it("符合 semver 结构", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("negotiateVersion", () => {
  it("selects the first client-preferred compatible version", () => {
    expect(negotiateVersion(["1.4.0", "0.2.0", "0.1.5"], "0.1.9")).toBe("0.1.5");
  });

  it("honors client order over a higher compatible version", () => {
    expect(negotiateVersion(["0.1.0", "0.1.9"], "0.1.9")).toBe("0.1.0");
  });

  it("ignores the patch component when major and minor are compatible", () => {
    expect(negotiateVersion(["0.1.10"], "0.1.9")).toBe("0.1.10");
  });

  it("skips malformed client versions and keeps priority order", () => {
    expect(negotiateVersion(["abc", "0.1", "0.1.2"], "0.2.0")).toBe("0.1.2");
  });

  it("rejects malformed versions strictly", () => {
    expect(
      negotiateVersion(["01.0.0", "0.1.2-beta", "v0.1.2", "0.1.2 ", "0.1"], "0.2.0"),
    ).toBeUndefined();
  });

  it("returns undefined when no client major matches", () => {
    expect(negotiateVersion(["1.0.0", "2.3.4"], "0.1.0")).toBeUndefined();
  });

  it("returns undefined when every client minor is newer than the server", () => {
    expect(negotiateVersion(["0.2.0", "0.3.1"], "0.1.9")).toBeUndefined();
  });

  it("returns undefined for an empty list or a malformed server version", () => {
    expect(negotiateVersion([], "0.1.0")).toBeUndefined();
    expect(negotiateVersion(["0.1.0"], "0.x.0")).toBeUndefined();
  });

  it("defaults the server version to PROTOCOL_VERSION", () => {
    expect(negotiateVersion(["0.0.1", "0.1.0"])).toBe("0.0.1");
    expect(negotiateVersion(["0.1.0"])).toBeUndefined();
  });
});

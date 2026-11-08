import { expect, test } from "vitest";
import * as core from "../src/index.js";

test("does not expose internal event helpers from the package root", () => {
  expect(typeof core.createEventPublisher).toBe("function");
  for (const name of [
    "MAX_ENGINE_EVENT_BYTES",
    "deliverEvent",
    "eventBytes",
    "normalizePublishFailure",
    "sessionEventFrames",
    "validateSessionEventNodes",
  ])
    expect(core).not.toHaveProperty(name);
});

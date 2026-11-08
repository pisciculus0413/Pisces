import type { SessionEventClock } from "@pisces/core";

/** Creates the per-session clock shared by Context, driver, and Gateway. */
export function createSessionEventClock(initial = 0): SessionEventClock {
  if (!Number.isSafeInteger(initial) || initial < 0) {
    throw new TypeError("Session event clock initial value must be a nonnegative safe integer");
  }

  let current = initial;

  return {
    current: () => current,
    next() {
      if (current === Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Session event clock overflow");
      }
      current += 1;
      return current;
    },
  };
}

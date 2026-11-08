import type { EngineEvent, EventBus } from "@pisces/core";

export function createEventBus(): EventBus {
  const handlers = new Set<(event: EngineEvent) => void>();

  return {
    publish(event) {
      let failed = false;
      let failure: unknown;
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (error) {
          if (failed) continue;
          failed = true;
          failure = error;
        }
      }
      if (failed) throw failure;
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

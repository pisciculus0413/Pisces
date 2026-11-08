import {
  deliverEvent,
  eventBytes,
  MAX_ENGINE_EVENT_BYTES,
  normalizePublishFailure,
  sessionEventFrames,
  validateSessionEventNodes,
} from "../events.js";
import type { SessionMeta, SessionNode } from "../sessions/types.js";
import { type JsonValue, PiscesError } from "../types.js";
import type { ContextDeps, ContextEvent } from "./types.js";

const PREFLIGHT_AT = "2000-01-01T00:00:00.000Z";
const oversized = () =>
  new PiscesError("context.source_failed", "Context event exceeds event budget");
type EventDeps = Pick<ContextDeps, "events" | "eventClock" | "sessionId" | "now">;

export function createContextEvents(deps: EventDeps) {
  function envelope(type: ContextEvent["type"], data: unknown): ContextEvent {
    const event: ContextEvent = {
      type,
      sessionId: deps.sessionId,
      seq: deps.eventClock.next(),
      at: deps.now(),
      data: structuredClone(data) as JsonValue,
    };
    if (eventBytes(event) > MAX_ENGINE_EVENT_BYTES) throw oversized();
    return event;
  }

  function fits(type: ContextEvent["type"], data: unknown) {
    return (
      eventBytes({
        type,
        sessionId: deps.sessionId,
        seq: Number.MAX_SAFE_INTEGER,
        at: PREFLIGHT_AT,
        data,
      }) <= MAX_ENGINE_EVENT_BYTES
    );
  }

  function validateSelection(selection: readonly string[]) {
    if (!fits("selection.updated", { selection }))
      throw new PiscesError("context.selection_too_large", "Selection exceeds event budget");
  }

  function deliver(event: ContextEvent): void {
    try {
      deps.events.publish(structuredClone(event));
    } catch (cause) {
      throw normalizePublishFailure(cause);
    }
  }

  return {
    publish(type: ContextEvent["type"], data: unknown) {
      deliver(envelope(type, data));
    },
    publishSession(nodes: SessionNode[], meta?: SessionMeta) {
      let failure: unknown;
      let failed = false;
      for (const frame of sessionEventFrames(deps, nodes, meta)) {
        try {
          deliverEvent(deps.events, frame);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
      if (failed) throw failure;
    },
    validateSessionNodes(nodes: readonly SessionNode[], meta?: SessionMeta) {
      validateSessionEventNodes(deps.sessionId, nodes, meta);
    },
    validateSelection,
  };
}

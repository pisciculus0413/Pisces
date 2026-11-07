import type { SessionMeta, SessionNode } from "../sessions/types.js";
import { type JsonValue, PiscesError } from "../types.js";
import type { ContextDeps, ContextEvent } from "./types.js";

// Protocol uses {event, data:{sessionId,seq,at,...payload}}. Moving fields
// preserves JSON punctuation; replacing "type" with "event" adds exactly one byte.
const MAX_SESSION_ENGINE_BYTES = 4194304 - 1;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const oversized = () =>
  new PiscesError("context.source_failed", "Context node or metadata exceeds event budget");
type EventDeps = Pick<ContextDeps, "events" | "eventClock" | "sessionId" | "now">;

export function createContextEvents(deps: EventDeps) {
  function envelope(type: ContextEvent["type"], data: unknown): ContextEvent {
    return {
      type,
      sessionId: deps.sessionId,
      seq: deps.eventClock.next(),
      at: deps.now(),
      data: structuredClone(data) as JsonValue,
    };
  }

  function validateSessionNodes(nodes: readonly SessionNode[], meta?: SessionMeta) {
    const check = (data: unknown) => {
      // Largest valid clock width; UTC millisecond timestamps have fixed width.
      if (
        bytes({
          type: "session.updated",
          sessionId: deps.sessionId,
          seq: Number.MAX_SAFE_INTEGER,
          at: "2000-01-01T00:00:00.000Z",
          data,
        }) > MAX_SESSION_ENGINE_BYTES
      )
        throw oversized();
    };
    if (meta) check({ nodes: [], meta });
    for (const node of nodes) check({ nodes: [node] });
  }

  function* sessionFrames(nodes: SessionNode[], meta?: SessionMeta): Generator<ContextEvent> {
    let frame = envelope("session.updated", { nodes: [], ...(meta ? { meta } : {}) });
    let current: SessionNode[] = [];
    for (const node of nodes) {
      const data = frame.data as unknown as { nodes: SessionNode[]; meta?: SessionMeta };
      data.nodes = [...current, node];
      if (bytes(frame) > MAX_SESSION_ENGINE_BYTES) {
        data.nodes = current;
        if (!current.length && !data.meta) throw oversized();
        yield frame;
        frame = envelope("session.updated", { nodes: [node] });
        if (bytes(frame) > MAX_SESSION_ENGINE_BYTES) throw oversized();
        current = [node];
      } else current.push(node);
    }
    if (current.length || meta) yield frame;
  }

  return {
    publish(type: ContextEvent["type"], data: unknown) {
      deps.events.publish(envelope(type, data));
    },
    publishSession(nodes: SessionNode[], meta?: SessionMeta) {
      let failure: unknown;
      let failed = false;
      for (const frame of sessionFrames(nodes, meta)) {
        try {
          deps.events.publish(structuredClone(frame));
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
      if (failed) throw failure;
    },
    validateSessionNodes,
  };
}

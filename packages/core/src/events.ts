import type { SessionEventClock } from "./context/types.js";
import type { StopReason, TurnId, Usage } from "./messages.js";
import type { SessionId, SessionMeta, SessionNode } from "./sessions/types.js";
import { type JsonValue, PiscesError } from "./types.js";

export const MAX_ENGINE_EVENT_BYTES = 4194304 - 1;
const PREFLIGHT_AT = "2000-01-01T00:00:00.000Z";

export interface EngineEvent {
  type: string;
  sessionId?: SessionId;
  seq?: number;
  at: string;
  data: JsonValue;
}

export interface EventBus {
  publish(event: EngineEvent): void;
  subscribe(handler: (event: EngineEvent) => void): () => void;
}

export type TypedEngineEvent<TType extends string, TData> = Omit<
  EngineEvent,
  "type" | "sessionId" | "seq" | "data"
> & {
  type: TType;
  sessionId: SessionId;
  seq: number;
  data: TData;
};

export type SessionUpdatedEvent = TypedEngineEvent<
  "session.updated",
  { nodes: SessionNode[]; meta?: SessionMeta }
>;

export type TurnStartedEvent = TypedEngineEvent<
  "turn.started",
  { turnId: TurnId; startedAt: string }
>;

export type TurnDeltaEvent = TypedEngineEvent<
  "turn.delta",
  {
    turnId: TurnId;
    step: number;
    kind: "text" | "reasoning";
    delta: string;
  }
>;

export type TurnStepEvent = TypedEngineEvent<
  "turn.step",
  {
    turnId: TurnId;
    step: number;
    stopReason: StopReason;
    usage?: Usage;
  }
>;

export type TurnEndedEvent = TypedEngineEvent<
  "turn.ended",
  {
    turnId: TurnId;
    reason: "completed" | "cancelled" | "failed";
    endedAt: string;
    error?: { code: string; message: string };
  }
>;

export type TurnEvent = TurnStartedEvent | TurnDeltaEvent | TurnStepEvent | TurnEndedEvent;

export interface TurnEventData {
  "turn.started": TurnStartedEvent["data"];
  "turn.delta": TurnDeltaEvent["data"];
  "turn.step": TurnStepEvent["data"];
  "turn.ended": TurnEndedEvent["data"];
}

export interface EngineEventPublisher {
  publishTurn<K extends keyof TurnEventData>(type: K, data: TurnEventData[K]): void;
  publishDelta(turnId: TurnId, step: number, kind: "text" | "reasoning", delta: string): void;
  publishSession(nodes: SessionNode[], meta?: SessionMeta): void;
  validateSessionNodes(nodes: readonly SessionNode[], meta?: SessionMeta): void;
}

export interface SessionEventDeps {
  sessionId: SessionId;
  eventClock: SessionEventClock;
  now(): string;
}

export function eventBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function normalizePublishFailure(cause: unknown): PiscesError {
  if (cause instanceof PiscesError && cause.code === "event.publish_failed") return cause;
  return new PiscesError("event.publish_failed", "Event publication failed", { cause });
}

export function deliverEvent(
  events: Pick<EventBus, "publish">,
  event: {
    type: string;
    sessionId?: SessionId;
    seq?: number;
    at: string;
    data: unknown;
  },
): void {
  try {
    events.publish(structuredClone(event) as EngineEvent);
  } catch (cause) {
    throw normalizePublishFailure(cause);
  }
}

export function* sessionEventFrames(
  deps: SessionEventDeps,
  nodes: readonly SessionNode[],
  meta?: SessionMeta,
): Generator<SessionUpdatedEvent> {
  if (!nodes.length && !meta) return;
  const envelope = (data: SessionUpdatedEvent["data"]): SessionUpdatedEvent => ({
    type: "session.updated",
    sessionId: deps.sessionId,
    seq: deps.eventClock.next(),
    at: deps.now(),
    data,
  });
  let frame = envelope({ nodes: [], ...(meta ? { meta: structuredClone(meta) } : {}) });
  let current: SessionNode[] = [];
  for (const node of nodes) {
    const data = frame.data as { nodes: SessionNode[]; meta?: SessionMeta };
    data.nodes = [...current, structuredClone(node)];
    if (eventBytes(frame) > MAX_ENGINE_EVENT_BYTES) {
      data.nodes = current;
      if (!current.length && !data.meta)
        throw new PiscesError("context.source_failed", "Context event exceeds event budget");
      yield frame;
      frame = envelope({ nodes: [structuredClone(node)] });
      if (eventBytes(frame) > MAX_ENGINE_EVENT_BYTES)
        throw new PiscesError("context.source_failed", "Context event exceeds event budget");
      current = [structuredClone(node)];
    } else current.push(structuredClone(node));
  }
  if (current.length || meta) {
    (frame.data as { nodes: SessionNode[] }).nodes = current;
    yield frame;
  }
}

function fitsSessionFrame(data: unknown, sessionId: SessionId): boolean {
  return (
    eventBytes({
      type: "session.updated",
      sessionId,
      seq: Number.MAX_SAFE_INTEGER,
      at: PREFLIGHT_AT,
      data,
    }) <= MAX_ENGINE_EVENT_BYTES
  );
}

export function validateSessionEventNodes(
  sessionId: SessionId,
  nodes: readonly SessionNode[],
  meta?: SessionMeta,
): void {
  const fail = (): never => {
    throw new PiscesError("context.source_failed", "Context event exceeds event budget");
  };
  if (meta && !fitsSessionFrame({ nodes: [], meta }, sessionId)) fail();
  for (const node of nodes) if (!fitsSessionFrame({ nodes: [node] }, sessionId)) fail();
}

export function createEventPublisher(
  deps: SessionEventDeps & { events: EventBus },
): EngineEventPublisher {
  function envelope<K extends keyof TurnEventData>(type: K, data: TurnEventData[K]): TurnEvent {
    return {
      type,
      sessionId: deps.sessionId,
      seq: deps.eventClock.next(),
      at: deps.now(),
      data: structuredClone(data),
    } as TurnEvent;
  }

  function publishDelta(
    turnId: TurnId,
    step: number,
    kind: "text" | "reasoning",
    delta: string,
  ): void {
    if (!delta.length) return;
    const points = Array.from(delta);
    let offset = 0;
    do {
      const seq = deps.eventClock.next();
      const at = deps.now();
      const frame = (value: string): TurnDeltaEvent => ({
        type: "turn.delta",
        sessionId: deps.sessionId,
        seq,
        at,
        data: { turnId, step, kind, delta: value },
      });
      let low = 0;
      let high = points.length - offset;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          eventBytes(frame(points.slice(offset, offset + middle).join(""))) <=
          MAX_ENGINE_EVENT_BYTES
        )
          low = middle;
        else high = middle - 1;
      }
      if (low === 0)
        throw new PiscesError("context.source_failed", "Delta event exceeds event budget");
      deliverEvent(deps.events, frame(points.slice(offset, offset + low).join("")));
      offset += low;
    } while (offset < points.length);
  }

  return {
    publishTurn(type, data) {
      const event = envelope(type, data);
      if (eventBytes(event) > MAX_ENGINE_EVENT_BYTES)
        throw new PiscesError("context.source_failed", "Turn event exceeds event budget");
      deliverEvent(deps.events, event);
    },
    publishDelta,
    publishSession(nodes, meta) {
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
    validateSessionNodes(nodes, meta) {
      validateSessionEventNodes(deps.sessionId, nodes, meta);
    },
  };
}

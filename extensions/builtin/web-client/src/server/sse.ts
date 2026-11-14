import type { RequestHandler } from "express";
import type { WireClient, WireEvent } from "./wire.js";

/**
 * Session event fan-out.
 *
 * Every browser tab opens its own SSE stream, but they all share one upstream
 * daemon connection, which must not receive `session.subscribe` once per tab.
 * The hub refcounts subscriptions per session and hands the subscription back
 * when the last tab disconnects.
 */

export interface SubscriptionHub {
  /** Resolves with an idempotent release function; the first call subscribes upstream. */
  acquire(sessionId: string): Promise<() => void>;
}

export interface EventStreamOptions {
  keepaliveMs?: number;
}

const DEFAULT_KEEPALIVE_MS = 15_000;

interface Entry {
  count: number;
}

export function createSubscriptionHub(wire: WireClient): SubscriptionHub {
  const entries = new Map<string, Entry>();

  return {
    async acquire(sessionId) {
      const existing = entries.get(sessionId);
      if (existing !== undefined) {
        existing.count += 1;
        return release(sessionId, existing);
      }
      // Subscribe before registering: a failed subscribe must not leave a counted entry.
      await wire.request("session.subscribe", { sessionId });
      const entry: Entry = { count: 1 };
      entries.set(sessionId, entry);
      return release(sessionId, entry);
    },
  };

  /** Each returned function releases its own acquire exactly once. */
  function release(sessionId: string, entry: Entry): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.count -= 1;
      if (entry.count > 0) return;
      entries.delete(sessionId);
      // No caller can await a browser disconnect, and a failed unsubscribe only
      // costs one stale subscription until the daemon restarts.
      void Promise.resolve(wire.request("session.unsubscribe", { sessionId })).catch(() => {});
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function eventStream(
  hub: SubscriptionHub,
  wire: WireClient,
  options: EventStreamOptions = {},
): RequestHandler {
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;

  return (request, response) => {
    const sessionId = request.params.id;
    if (typeof sessionId !== "string" || sessionId === "") {
      response.status(400).json({
        error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
      });
      return;
    }

    let release: (() => void) | undefined;
    let stopEvents: (() => void) | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive !== undefined) clearInterval(keepalive);
      stopEvents?.();
      release?.();
    };

    void hub
      .acquire(sessionId)
      .then((releaseSubscription) => {
        if (closed) {
          releaseSubscription();
          return;
        }
        release = releaseSubscription;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write("retry: 2000\n\n");
        keepalive = setInterval(() => {
          if (!closed) response.write(": keepalive\n\n");
        }, keepaliveMs);
        stopEvents = wire.onEvent((event: WireEvent) => {
          if (closed) return;
          if (!isRecord(event.data) || event.data.sessionId !== sessionId) return;
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        });
      })
      .catch((error: unknown) => {
        if (closed) return;
        const code =
          isRecord(error) && typeof error.code === "string" ? error.code : "daemon.unreachable";
        response.status(503).json({ error: { code, message: "Daemon is not reachable" } });
        cleanup();
      });

    request.on("close", () => {
      cleanup();
      response.end();
    });
  };
}

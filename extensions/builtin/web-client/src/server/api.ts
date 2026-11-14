import { Router } from "express";
import { eventStream, type SubscriptionHub } from "./sse.js";
import { isProtocolError, type WireClient } from "./wire.js";

/**
 * REST projection of the protocol: one route, one method, parameters passed
 * through unchanged. Validation here is only about shape — anything semantic
 * belongs to the daemon, whose error code is forwarded verbatim.
 */

export interface ApiOptions {
  wire: WireClient;
  hub: SubscriptionHub;
}

const INVALID_REQUEST = {
  error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
} as const;

/** Error code → HTTP status. The code stays the contract; the status is a coarse class. */
const NOT_FOUND = new Set(["session.not_found", "session.node_not_found"]);
const CONFLICT = new Set([
  "turn.active",
  "turn.node_id_forbidden",
  "queue.entry_locked",
  "queue.entry_not_found",
  "queue.invalid_control",
  "queue.duplicate_name",
  "queue.entry_too_large",
  "queue.too_large",
]);

export function statusForCode(code: string): number {
  if (NOT_FOUND.has(code)) return 404;
  if (CONFLICT.has(code)) return 409;
  if (code === "protocol.invalid_request") return 400;
  if (code === "daemon.unreachable" || code === "daemon.timeout") return 503;
  if (code === "protocol.invalid_response") return 502;
  return 500;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createApiRouter(options: ApiOptions): Router {
  const { wire, hub } = options;
  const router = Router();

  const send = async (
    response: import("express").Response,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    try {
      response.json(await wire.request(method, params));
    } catch (error) {
      if (isProtocolError(error)) {
        response.status(statusForCode(error.code)).json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "internal.error";
      const message =
        isRecord(error) && typeof error.message === "string" ? error.message : "Internal error";
      response.status(statusForCode(code)).json({ error: { code, message } });
    }
  };

  /** Route params: a present but empty id is a client bug, not a daemon question. */
  const sessionIdOf = (request: import("express").Request): string | undefined => {
    const id = request.params.id;
    return typeof id === "string" && id !== "" ? id : undefined;
  };

  const limited = (value: unknown): number | undefined | null => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return null;
    const limit = Number(value);
    return Number.isInteger(limit) && limit > 0 ? limit : null;
  };

  router.get("/sessions", async (_request, response) => {
    await send(response, "session.list", {});
  });

  router.post("/sessions", async (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    await send(response, "session.create", body);
  });

  router.get("/sessions/:id", async (request, response) => {
    const sessionId = sessionIdOf(request);
    const limit = limited(request.query.limit);
    if (sessionId === undefined || limit === null) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    const node = request.query.node;
    const cursor = request.query.cursor;
    await send(response, "session.read", {
      sessionId,
      ...(typeof node === "string" ? { node } : {}),
      ...(typeof cursor === "string" ? { cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    });
  });

  router.patch("/sessions/:id", async (request, response) => {
    const sessionId = sessionIdOf(request);
    if (sessionId === undefined) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    await send(response, "session.configure", {
      sessionId,
      ...(isRecord(request.body) ? request.body : {}),
    });
  });

  router.get("/sessions/:id/entries", async (request, response) => {
    const sessionId = sessionIdOf(request);
    if (sessionId === undefined) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    await send(response, "entries.snapshot", { sessionId });
  });

  router.post("/sessions/:id/queue", async (request, response) => {
    const sessionId = sessionIdOf(request);
    const body = isRecord(request.body) ? request.body : {};
    if (sessionId === undefined || !Array.isArray(body.entries)) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    await send(response, "queue.enqueue", { sessionId, entries: body.entries });
  });

  router.delete("/sessions/:id/queue", async (request, response) => {
    const sessionId = sessionIdOf(request);
    if (sessionId === undefined) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    await send(response, "queue.clear", { sessionId });
  });

  router.patch("/sessions/:id/queue/:entryId", async (request, response) => {
    const sessionId = sessionIdOf(request);
    const id = request.params.entryId;
    const body = isRecord(request.body) ? request.body : {};
    if (sessionId === undefined || typeof id !== "string" || !Array.isArray(body.content)) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    await send(response, "queue.edit", { sessionId, id, content: body.content });
  });

  router.delete("/sessions/:id/queue/:entryId", async (request, response) => {
    const sessionId = sessionIdOf(request);
    const id = request.params.entryId;
    if (sessionId === undefined || typeof id !== "string" || id === "") {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    await send(response, "queue.remove", { sessionId, id });
  });

  router.post("/sessions/:id/turns", async (request, response) => {
    const sessionId = sessionIdOf(request);
    if (sessionId === undefined) {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    const nodeId = isRecord(request.body) ? request.body.nodeId : undefined;
    await send(response, "turn.start", {
      sessionId,
      ...(typeof nodeId === "string" && nodeId !== "" ? { nodeId } : {}),
    });
  });

  router.get("/turns", async (_request, response) => {
    await send(response, "turn.list", {});
  });

  router.post("/turns/:id/cancel", async (request, response) => {
    const turnId = request.params.id;
    if (typeof turnId !== "string" || turnId === "") {
      response.status(400).json(INVALID_REQUEST);
      return;
    }
    await send(response, "turn.cancel", { turnId });
  });

  router.get("/providers", async (_request, response) => {
    await send(response, "provider.list", {});
  });

  router.get("/sessions/:id/events", eventStream(hub, wire));

  return router;
}

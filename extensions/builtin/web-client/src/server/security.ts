import type { RequestHandler } from "express";

/**
 * Two cheap guards that together stand in for authentication.
 *
 * The bridge listens on loopback, so the only attacker that matters is a web page
 * the user happens to have open. It cannot forge a `Host` header for a
 * rebinding attack (the browser sends the attacker's domain), it cannot read a
 * response without CORS headers, and it cannot send `application/json` without
 * a preflight the bridge never approves.
 */

export const HOST_FORBIDDEN = {
  error: { code: "web.host_forbidden", message: "Host is not allowed" },
} as const;

export const UNSUPPORTED_MEDIA_TYPE = {
  error: { code: "web.unsupported_media_type", message: "Requests must be application/json" },
} as const;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Exact `host:port` match; an absent or foreign header is refused. */
export function hostGuard(allowedHosts: () => readonly string[]): RequestHandler {
  return (request, response, next) => {
    const host = request.headers.host;
    if (typeof host !== "string" || !allowedHosts().includes(host)) {
      response.status(403).json(HOST_FORBIDDEN);
      return;
    }
    next();
  };
}

/**
 * A request that carries a body must carry it as JSON; requests without a body
 * (`DELETE`, `POST … {}` from a form-free client) pass untouched. Reads stay
 * simple requests either way.
 */
export function requireJson(): RequestHandler {
  return (request, response, next) => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    const hasBody =
      request.headers["transfer-encoding"] !== undefined ||
      (request.headers["content-length"] ?? "0") !== "0";
    if (!hasBody) {
      next();
      return;
    }
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      response.status(415).json(UNSUPPORTED_MEDIA_TYPE);
      return;
    }
    next();
  };
}

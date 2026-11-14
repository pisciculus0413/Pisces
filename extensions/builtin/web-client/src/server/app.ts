import { join } from "node:path";
import express, { type Express } from "express";
import { type ApiOptions, createApiRouter } from "./api.js";
import { hostGuard, requireJson } from "./security.js";

/**
 * The bridge app: static SPA plus the `/api` surface.
 *
 * This module only wires middleware; every route lives in `api.ts` and every
 * protocol call goes through the injected `WireClient`. Nothing here caches
 * session state.
 */

export interface AppOptions {
  /** Absolute directory holding the built SPA (`index.html` + `assets/`). */
  assetsDir: string;
  /** Accepted `Host: <host>:<port>` values; read per request so an ephemeral port works. */
  allowedHosts: () => readonly string[];
  /** Present once an upstream connection exists; absent during the scaffold/tests. */
  api?: ApiOptions;
}

/** Fixed body for an unknown `/api` path; the client contract is the code, not the status. */
const API_NOT_FOUND = {
  error: { code: "protocol.unknown_method", message: "Unknown API route" },
} as const;

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(hostGuard(options.allowedHosts));
  app.use(express.static(options.assetsDir, { index: "index.html" }));
  app.use("/api", requireJson());
  app.use("/api", express.json({ limit: "24mb" }));
  if (options.api !== undefined) app.use("/api", createApiRouter(options.api));
  // Unknown API paths answer JSON before the SPA fallback can swallow them.
  app.use("/api", (_request, response) => {
    response.status(404).json(API_NOT_FOUND);
  });
  // Client-side routes: only GET page navigations fall back to the shell.
  const index = join(options.assetsDir, "index.html");
  app.use((request, response, next) => {
    if (request.method !== "GET") {
      next();
      return;
    }
    response.sendFile(index);
  });
  return app;
}

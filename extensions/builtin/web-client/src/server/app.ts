import { join } from "node:path";
import express, { type Express } from "express";

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
}

/** Fixed body for an unknown `/api` path; the client contract is the code, not the status. */
const API_NOT_FOUND = {
  error: { code: "protocol.unknown_method", message: "Unknown API route" },
} as const;

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.static(options.assetsDir, { index: "index.html" }));
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

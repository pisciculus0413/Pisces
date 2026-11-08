import { pathToFileURL } from "node:url";
import { createProviderManagement } from "@pisces/core";

/**
 * Child-process fixture for real daemon startup.
 *
 * Runs only compiled `dist/*.js` (and the ignored native addon next to it), never
 * the Vitest TypeScript aliases.
 * Usage: node host-child.mjs <entry.js> <dataDir> [ready|blocking]
 */

const [entryPath, dataDir, mode = "ready"] = process.argv.slice(2);

const emit = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const adapter = {
  dialect: "test",
  buildRequest(request) {
    return { path: "/v1/chat/completions", body: JSON.stringify(request) };
  },
  parseChunk() {
    return [
      { type: "content", delta: "ok" },
      { type: "stop", reason: "stop" },
    ];
  },
};

async function main() {
  const { startDaemon } = await import(pathToFileURL(entryPath).href);
  const providers = createProviderManagement();
  providers.registerProvider({
    id: "p",
    dialect: "test",
    baseUrl: "https://provider.test/v1",
    auth: { type: "apiKey", credentialRef: "test" },
    models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
  });
  providers.registerDialect("test", () => adapter);
  const providerHost = {
    execute() {
      if (mode === "blocking") {
        // Keeps a committed active-turn marker on disk until the process is killed.
        return async function* (_request, signal) {
          await new Promise((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        };
      }
      return async function* () {
        yield "frame";
      };
    },
    async ready() {
      return true;
    },
  };

  const host = await startDaemon({
    dataDir,
    providers,
    providerHost,
    defaults: { provider: "p", model: "m", workspace: dataDir },
  });
  emit({
    event: "ready",
    socketPath: host.socketPath,
    initializationIssues: host.initializationIssues.length,
    recoveryIssues: host.recoveryIssues.length,
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    host
      .stop()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error) => {
        const status = host.status();
        emit({
          event: "stop_error",
          code: error?.code ?? "unknown",
          state: status.state,
          activeTurns: status.activeTurns,
        });
        process.exitCode = 1;
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  emit({ event: "error", code: error?.code ?? "unknown" });
  process.exitCode = 1;
});

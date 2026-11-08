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
  const entryUrl = pathToFileURL(entryPath);
  const { startDaemon } = await import(entryUrl.href);
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

  // Test-fixture-only fault injection. The patch is installed in this child's
  // module cache for the same compiled dist singleton the host uses, and dies
  // with the process. No production code or public API is touched.
  let unlinkFaultInstalled = false;
  const installUnlinkFault = async () => {
    if (!unlinkFaultInstalled) {
      const ioUrl = new URL("./session-store/session-store-io.js", entryUrl);
      const { sessionStoreIo } = await import(ioUrl.href);
      const realUnlink = sessionStoreIo.unlink;
      sessionStoreIo.unlink = async (path) => {
        if (String(path).endsWith("active-turn.json")) {
          throw Object.assign(new Error("unlink failed"), { code: "EACCES" });
        }
        return realUnlink(path);
      };
      unlinkFaultInstalled = true;
    }
    emit({ event: "fault_installed", target: "active-turn.json" });
  };

  let commandBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    commandBuffer += chunk;
    let index = commandBuffer.indexOf("\n");
    while (index !== -1) {
      const line = commandBuffer.slice(0, index).trim();
      commandBuffer = commandBuffer.slice(index + 1);
      index = commandBuffer.indexOf("\n");
      if (line.length === 0) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        emit({ event: "command_error", code: "invalid_json" });
        continue;
      }
      if (command?.command === "install-unlink-fault") {
        void installUnlinkFault().catch((error) => {
          emit({ event: "fault_error", code: error?.code ?? "unknown" });
        });
      }
    }
  });
  process.stdin.on("error", () => {});
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

import { pathToFileURL } from "node:url";
import { createProviderManagement } from "@pisces/core";

/**
 * Child-process fixture for the compiled public host with extension composition.
 *
 * Runs only compiled `dist/*.js` and the ignored native addon next to it, never the
 * Vitest TypeScript aliases. The parent drives `snapshot`, `turn.start`, `session.read`
 * and `enqueue` over the real Unix socket; this fixture only provides the provider,
 * the extension config directory and bounded ready/stop lifecycle events.
 *
 * Usage: node extensions-child.mjs <entry.js> <dataDir> <configDir> <workspace> <toolName> [serve|platform]
 *
 * `platform` stubs the host platform to `darwin` before importing the compiled entry:
 * it verifies the platform guard precedes extension construction, native probing and bind.
 */

const [entryPath, dataDir, configDir, workspace, toolName, mode = "serve"] = process.argv.slice(2);

const emit = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let step = 0;
const adapter = {
  dialect: "test",
  buildRequest(request) {
    return { path: "/v1/chat/completions", body: JSON.stringify(request) };
  },
  parseChunk() {
    step += 1;
    if (step === 1)
      return [
        { type: "toolCall", call: { id: "call_1", name: toolName, arguments: {} } },
        { type: "stop", reason: "toolCall" },
      ];
    return [
      { type: "content", delta: "done" },
      { type: "stop", reason: "stop" },
    ];
  },
};

async function main() {
  if (mode === "platform") {
    // Read-only override in this child only: production code always reads process.platform.
    Object.defineProperty(process, "platform", { value: "darwin" });
  }
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
    extensions: { configDir },
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
        emit({ event: "stop_error", code: error?.code ?? "unknown" });
        process.exitCode = 1;
      })
      .finally(() => {
        process.stdin.destroy();
      });
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.length === 0) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        emit({ event: "command_error", code: "invalid_json" });
        continue;
      }
      if (command?.command === "ping") emit({ event: "pong" });
      else if (command?.command === "stop") shutdown();
    }
  });
  process.stdin.on("error", () => {});
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  emit({
    event: "ready",
    socketPath: host.socketPath,
    workspace,
    initializationIssues: host.initializationIssues.length,
    recoveryIssues: host.recoveryIssues.length,
  });
}

main().catch((error) => {
  emit({ event: "error", code: error?.code ?? "unknown" });
  process.exitCode = 1;
});

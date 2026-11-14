import { realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { ApiOptions } from "./api.js";
import { createApp } from "./app.js";
import { createSubscriptionHub } from "./sse.js";
import { connectWire, type WireClient, WireError } from "./wire.js";

/**
 * Process entry for the web client. It is started by the daemon
 * (`pisces client start web`), which passes the daemon socket path in the
 * environment and inherits stdout/stderr into `<dataDir>/daemon.log`.
 */

export const DEFAULT_PORT = 7801;
export const PORT_ENV = "PISCES_CLIENT_WEB_PORT";

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  port?: number;
  socketPath?: string;
  assetsDir?: string;
  /** Tests inject a fake upstream; the entry always connects to `socketPath`. */
  api?: ApiOptions;
}

const LOOPBACK = "127.0.0.1";

/** Both names the loopback interface answers to, for the port actually bound. */
function allowedHosts(port: number): readonly string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, LOOPBACK, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("listener has no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startServer(options: StartOptions = {}): Promise<ServerHandle> {
  const assetsDir = options.assetsDir ?? fileURLToPath(new URL("./web/", import.meta.url));
  let port = options.port ?? DEFAULT_PORT;
  const app = createApp({
    assetsDir,
    allowedHosts: () => allowedHosts(port),
    ...(options.api === undefined ? {} : { api: options.api }),
  });
  const server = createServer(app);
  port = await listen(server, port);
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // SSE streams stay open for as long as a tab is open; closing must not
        // wait for them.
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

function configuredPort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

/** Only the spawned entry runs; importing this module from tests has no side effects. */
async function main(): Promise<void> {
  const socketPath = process.env.PISCES_SOCKET_PATH;
  if (socketPath === undefined || socketPath === "") {
    process.stderr.write("web client: missing PISCES_SOCKET_PATH\n");
    process.exitCode = 1;
    return;
  }
  const port = configuredPort(process.env[PORT_ENV]);
  // One upstream connection for the process lifetime: the daemon is expected to
  // outlive the console. A daemon restart needs `pisces client start web` again.
  let wire: WireClient | undefined;
  let handle: ServerHandle | undefined;
  // `/api/shutdown` stops this process only: the daemon and any running turn are
  // untouched, so `pisces client start web` brings the console back.
  const stopBridge = (): void => {
    wire?.close();
    void handle?.close().catch(() => {});
    setTimeout(() => process.exit(0), 0);
  };
  try {
    wire = await connectWire(socketPath);
    handle = await startServer({
      ...(port === undefined ? {} : { port }),
      socketPath,
      api: { wire, hub: createSubscriptionHub(wire), onShutdown: stopBridge },
    });
    process.stdout.write(`web client listening on http://${LOOPBACK}:${handle.port}/\n`);
  } catch (error) {
    // Release the upstream socket first: it is the only handle that would keep a
    // failed start alive instead of letting the process exit with code 1.
    wire?.close();
    if (error instanceof WireError) {
      process.stderr.write("web client: daemon is not reachable\n");
    } else if (isAddressInUse(error)) {
      process.stderr.write(`web client: port ${port ?? DEFAULT_PORT} is already in use\n`);
    } else {
      process.stderr.write("web client: failed to start\n");
    }
    process.exitCode = 1;
  }
}

async function isEntry(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (await realpath(entry)) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (await isEntry()) {
  await main();
}

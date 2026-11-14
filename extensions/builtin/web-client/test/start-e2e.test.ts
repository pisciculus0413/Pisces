import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderManagement, type LlmAdapter } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import { type DaemonHost, startDaemon } from "../../../../packages/daemon/src/host/daemon-host.js";
import type { ProviderHost } from "../../../../packages/daemon/src/provider/provider-host.js";

/**
 * The built entry, started the way the daemon starts it (`node dist/server.js`
 * with `PISCES_SOCKET_PATH`), against a real daemon on a real Unix socket.
 */

const ENTRY = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const BUILT = existsSync(ENTRY);
const START_TIMEOUT_MS = 15_000;

const roots: string[] = [];
const hosts: DaemonHost[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  children.clear();
  for (const host of hosts.splice(0).reverse()) await host.stop().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const adapter: LlmAdapter = {
  dialect: "test",
  buildRequest(request) {
    return { path: "/v1/chat/completions", body: JSON.stringify(request) };
  },
  parseChunk() {
    return [];
  },
};

const providerHost: ProviderHost = {
  execute() {
    return async function* () {
      yield "frame";
    };
  },
  async ready() {
    return true;
  },
};

async function startFixtureDaemon(): Promise<DaemonHost> {
  const root = await mkdtemp(join(tmpdir(), "pisces-web-e2e-"));
  roots.push(root);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const providers = createProviderManagement();
  providers.registerProvider({
    id: "p",
    dialect: "test",
    baseUrl: "https://provider.test/v1",
    auth: { type: "apiKey", credentialRef: "test" },
    models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
  });
  providers.registerDialect("test", () => adapter);
  const host = await startDaemon({ dataDir, providers, providerHost });
  hosts.push(host);
  return host;
}

interface Bridge {
  url: string;
  child: ChildProcess;
}

/** Starts the built entry on an ephemeral port and waits for its log line. */
async function startBridge(socketPath: string): Promise<Bridge> {
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PISCES_SOCKET_PATH: socketPath,
      PISCES_CLIENT_ID: "web",
      PISCES_CLIENT_WEB_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";

  return new Promise<Bridge>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`bridge did not start\n${stdout}${stderr}`));
    }, START_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const match = /web client listening on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve({ url: match[1], child });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited with ${code}\n${stdout}${stderr}`));
    });
  });
}

test.skipIf(!BUILT)(
  "the built bridge serves the console and the protocol API",
  { timeout: 60_000 },
  async () => {
    const host = await startFixtureDaemon();
    const bridge = await startBridge(host.socketPath);

    const page = await fetch(bridge.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('<div id="app"></div>');

    const sessions = await fetch(new URL("/api/sessions", bridge.url));
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toEqual({ sessions: [] });

    const providers = await fetch(new URL("/api/providers", bridge.url));
    expect(providers.status).toBe(200);
    const catalog = (await providers.json()) as { providers: { id: string }[] };
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["p"]);

    // A foreign Host is refused even though the request arrives over loopback.
    // `fetch` cannot forge Host, so this goes through raw HTTP.
    const rebound = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: Number(new URL(bridge.url).port),
          path: "/api/sessions",
          headers: { host: "evil.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(rebound).toBe(403);
  },
);

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/server/app.js";

/**
 * The bridge is reachable by any page in the same browser, so the Host header is
 * the only thing separating "the user's own tab" from a DNS-rebinding attack.
 * These tests talk raw HTTP so the Host header can be set arbitrarily.
 */

let root = "";
let assetsDir = "";
const servers: import("node:http").Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-web-security-"));
  assetsDir = join(root, "web");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, "index.html"), "<!doctype html>", "utf8");
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function serve(allowedHosts: () => readonly string[]): Promise<{ port: number }> {
  const app = createApp({ assetsDir, allowedHosts });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port };
}

function send(
  port: number,
  options: { method?: string; path?: string; host?: string; body?: string; contentType?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== undefined) headers.host = options.host;
    if (options.contentType !== undefined) headers["content-type"] = options.contentType;
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const ALLOWED = ["127.0.0.1:7801", "localhost:7801"];
const allowedHosts = (): readonly string[] => ALLOWED;

test("rejects a foreign Host header", async () => {
  const { port } = await serve(allowedHosts);

  const response = await send(port, { host: "evil.example" });

  expect(response.status).toBe(403);
  expect(JSON.parse(response.body)).toEqual({
    error: { code: "web.host_forbidden", message: "Host is not allowed" },
  });
});

test("rejects a request without a Host header", async () => {
  const { port } = await serve(allowedHosts);

  const response = await send(port, {});

  expect(response.status).toBe(403);
});

test("accepts 127.0.0.1 and localhost", async () => {
  const { port } = await serve(allowedHosts);

  for (const host of ALLOWED) {
    const response = await send(port, { host });
    expect(response.status).toBe(200);
    expect(response.body).toContain("doctype");
  }
});

test("rejects a write without a JSON content type", async () => {
  const { port } = await serve(allowedHosts);

  const plain = await send(port, {
    host: ALLOWED[0] as string,
    method: "POST",
    path: "/api/sessions",
    body: "name=value",
    contentType: "application/x-www-form-urlencoded",
  });
  expect(plain.status).toBe(415);
  expect(JSON.parse(plain.body)).toEqual({
    error: { code: "web.unsupported_media_type", message: "Requests must be application/json" },
  });

  const json = await send(port, {
    host: ALLOWED[0] as string,
    method: "POST",
    path: "/api/sessions",
    body: "{}",
    contentType: "application/json",
  });
  expect(json.status).toBe(404);
});

test("never emits CORS headers", async () => {
  const { port } = await serve(allowedHosts);

  const response = await send(port, {
    host: ALLOWED[0] as string,
    method: "POST",
    path: "/api/sessions",
    body: "{}",
    contentType: "application/json",
  });

  expect(
    Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
  ).toEqual([]);
});

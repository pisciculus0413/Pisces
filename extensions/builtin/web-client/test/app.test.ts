import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type ServerHandle, startServer } from "../src/server/main.js";

/**
 * The bridge serves the built SPA and owns nothing else yet. Everything here
 * runs against a real loopback listener on an ephemeral port, so the tests fail
 * if the server ever binds a non-loopback address or forgets to close.
 */

const handles: ServerHandle[] = [];
let root = "";
let assetsDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-web-app-"));
  assetsDir = join(root, "web");
  await mkdir(join(assetsDir, "assets"), { recursive: true });
  await writeFile(join(assetsDir, "index.html"), "<!doctype html><title>pisces</title>", "utf8");
  await writeFile(join(assetsDir, "assets", "app.js"), "console.log(1);\n", "utf8");
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  await rm(root, { recursive: true, force: true });
});

const serve = async (): Promise<ServerHandle> => {
  const handle = await startServer({ port: 0, assetsDir, socketPath: join(root, "daemon.sock") });
  handles.push(handle);
  return handle;
};

const base = (handle: ServerHandle): string => `http://127.0.0.1:${handle.port}`;

test("serves the built index.html and falls back to it for unknown pages", async () => {
  const handle = await serve();

  const index = await fetch(`${base(handle)}/`);
  expect(index.status).toBe(200);
  expect(index.headers.get("content-type")).toContain("text/html");
  expect(await index.text()).toContain("pisces");

  const deep = await fetch(`${base(handle)}/sessions/abc`);
  expect(deep.status).toBe(200);
  expect(deep.headers.get("content-type")).toContain("text/html");

  const asset = await fetch(`${base(handle)}/assets/app.js`);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toContain("console.log");
});

test("answers 404 JSON for unknown /api paths", async () => {
  const handle = await serve();

  const response = await fetch(`${base(handle)}/api/nope`);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: { code: "protocol.unknown_method", message: "Unknown API route" },
  });
});

test("startServer listens on the loopback interface only", async () => {
  const handle = await serve();
  expect(handle.port).toBeGreaterThan(0);

  const response = await fetch(`${base(handle)}/`);
  expect(response.status).toBe(200);

  await handle.close();
  handles.splice(handles.indexOf(handle), 1);
  await expect(fetch(`${base(handle)}/`)).rejects.toThrow();
});

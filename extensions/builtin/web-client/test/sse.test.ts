import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSubscriptionHub, eventStream } from "../src/server/sse.js";
import { ProtocolError, type WireClient, type WireEvent } from "../src/server/wire.js";

/**
 * SSE is the only long-lived path. It must subscribe the shared upstream
 * connection exactly once per session, forward only that session's events, and
 * give the subscription back when the last browser tab goes away.
 */

interface FakeWire {
  client: WireClient;
  calls: { method: string; params: unknown }[];
  emit(event: WireEvent): void;
  listenerCount(): number;
}

function fakeWire(): FakeWire {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Set<(event: WireEvent) => void>();
  return {
    calls,
    client: {
      async request(method, params) {
        calls.push({ method, params });
        return {};
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {},
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

let root = "";
const servers: import("node:http").Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-web-sse-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
  await rm(root, { recursive: true, force: true });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

async function serve(
  wire: WireClient,
  options: { keepaliveMs?: number } = {},
): Promise<{ base: string }> {
  const hub = createSubscriptionHub(wire);
  const app = express();
  app.get("/sessions/:id/events", eventStream(hub, wire, options));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { base: `http://127.0.0.1:${address.port}` };
}

/** Reads an SSE response until `until` matches or the budget runs out. */
async function readStream(
  response: Response,
  controller: AbortController,
  predicate: (text: string) => boolean,
  budgetMs = 1000,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      reader.read(),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
    ]);
    if ("timeout" in winner) {
      if (predicate(text)) break;
      continue;
    }
    if (winner.done) break;
    text += decoder.decode(winner.value, { stream: true });
    if (predicate(text)) break;
  }
  controller.abort();
  return text;
}

test("subscribes once per session and unsubscribes on the last release", async () => {
  const wire = fakeWire();
  const hub = createSubscriptionHub(wire.client);

  const releaseFirst = await hub.acquire("s1");
  const releaseSecond = await hub.acquire("s1");
  const releaseThird = await hub.acquire("s2");

  expect(wire.calls.filter((call) => call.method === "session.subscribe")).toEqual([
    { method: "session.subscribe", params: { sessionId: "s1" } },
    { method: "session.subscribe", params: { sessionId: "s2" } },
  ]);

  releaseFirst();
  releaseFirst();
  expect(wire.calls.some((call) => call.method === "session.unsubscribe")).toBe(false);

  releaseSecond();
  await flush();
  expect(wire.calls.filter((call) => call.method === "session.unsubscribe")).toEqual([
    { method: "session.unsubscribe", params: { sessionId: "s1" } },
  ]);

  releaseThird();
  await flush();
  expect(wire.calls.filter((call) => call.method === "session.unsubscribe")).toEqual([
    { method: "session.unsubscribe", params: { sessionId: "s1" } },
    { method: "session.unsubscribe", params: { sessionId: "s2" } },
  ]);
});

test("forwards only the subscribed session's events", async () => {
  const wire = fakeWire();
  const { base } = await serve(wire.client);
  const controller = new AbortController();

  const response = await fetch(`${base}/sessions/s1/events`, { signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  wire.emit({ event: "turn.started", data: { sessionId: "s2", seq: 1 } });
  wire.emit({ event: "turn.started", data: { sessionId: "s1", seq: 2 } });

  const text = await readStream(response, controller, (body) => body.includes("turn.started"));

  expect(text).toContain("retry: 2000");
  expect(text).toContain('"sessionId":"s1"');
  expect(text).not.toContain('"sessionId":"s2"');
});

test("releases the subscription when the browser disconnects", async () => {
  const wire = fakeWire();
  const { base } = await serve(wire.client);
  const controller = new AbortController();

  const response = await fetch(`${base}/sessions/s1/events`, { signal: controller.signal });
  expect(response.status).toBe(200);
  await flush();
  expect(wire.calls.map((call) => call.method)).toEqual(["session.subscribe"]);

  controller.abort();
  await flush();
  await flush();

  expect(wire.calls.map((call) => call.method)).toEqual([
    "session.subscribe",
    "session.unsubscribe",
  ]);
  expect(wire.listenerCount()).toBe(0);
});

test("reports a failed subscribe with its own status", async () => {
  const failing: WireClient = {
    async request() {
      throw new ProtocolError("session.not_found", "Session not found");
    },
    onEvent() {
      return () => {};
    },
    close() {},
  };
  const { base } = await serve(failing);

  const response = await fetch(`${base}/sessions/missing/events`);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: { code: "session.not_found", message: "Session not found" },
  });
});

test("keeps the stream alive with a comment frame", async () => {
  const wire = fakeWire();
  const { base } = await serve(wire.client, { keepaliveMs: 20 });
  const controller = new AbortController();

  const response = await fetch(`${base}/sessions/s1/events`, { signal: controller.signal });
  const text = await readStream(response, controller, (body) => body.includes(": keepalive"));

  expect(text).toContain(": keepalive");
});

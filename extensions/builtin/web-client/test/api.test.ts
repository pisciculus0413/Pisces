import express from "express";
import { afterEach, expect, test } from "vitest";
import { createApiRouter } from "../src/server/api.js";
import { hostGuard, requireJson } from "../src/server/security.js";
import { createSubscriptionHub } from "../src/server/sse.js";
import { statusForCode } from "../src/server/status.js";
import { ProtocolError, type WireClient, WireError, type WireEvent } from "../src/server/wire.js";

/**
 * One endpoint, one protocol method — the bridge adds no semantics of its own.
 * The table below is the contract from the design document; if a route is added
 * or renamed, this test is where it shows up.
 */

interface Call {
  method: string;
  params: unknown;
}

interface FakeWire {
  client: WireClient;
  calls: Call[];
}

function fakeWire(respond: (call: Call) => unknown = () => ({ ok: true })): FakeWire {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async request(method, params) {
        const call = { method, params };
        calls.push(call);
        const result = respond(call);
        if (result instanceof Error) throw result;
        return result;
      },
      onEvent(_listener: (event: WireEvent) => void) {
        return () => {};
      },
      close() {},
    },
  };
}

const servers: import("node:http").Server[] = [];
let base = "";

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function serve(wire: WireClient): Promise<string> {
  let port = 0;
  const app = express();
  // The production middleware chain, so guard regressions surface here too.
  app.use(hostGuard(() => [`127.0.0.1:${port}`, `localhost:${port}`]));
  app.use("/api", requireJson());
  app.use("/api", express.json());
  app.use("/api", createApiRouter({ wire, hub: createSubscriptionHub(wire) }));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
  base = `http://127.0.0.1:${port}`;
  return base;
}

interface Case {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  expect: Call;
}

const CASES: Case[] = [
  {
    name: "list sessions",
    method: "GET",
    path: "/api/sessions",
    expect: { method: "session.list", params: {} },
  },
  {
    name: "read a session branch",
    method: "GET",
    path: "/api/sessions/s1?node=n2&limit=5&cursor=n1",
    expect: {
      method: "session.read",
      params: { sessionId: "s1", nodeId: "n2", limit: 5, cursor: "n1" },
    },
  },
  {
    name: "create a session",
    method: "POST",
    path: "/api/sessions",
    body: { workspace: "/tmp/ws", provider: "p", model: "m" },
    expect: {
      method: "session.create",
      params: { workspace: "/tmp/ws", provider: "p", model: "m" },
    },
  },
  {
    name: "configure a session",
    method: "PATCH",
    path: "/api/sessions/s1",
    body: { provider: "p2", model: "m2" },
    expect: {
      method: "session.configure",
      params: { sessionId: "s1", provider: "p2", model: "m2" },
    },
  },
  {
    name: "list providers",
    method: "GET",
    path: "/api/providers",
    expect: { method: "provider.list", params: {} },
  },
  {
    name: "list active turns",
    method: "GET",
    path: "/api/turns",
    expect: { method: "turn.list", params: {} },
  },
  {
    name: "start or steer a turn",
    method: "POST",
    path: "/api/sessions/s1/turns",
    body: { nodeId: "n7" },
    expect: { method: "turn.start", params: { sessionId: "s1", nodeId: "n7" } },
  },
  {
    name: "start a turn without a branch point",
    method: "POST",
    path: "/api/sessions/s1/turns",
    body: {},
    expect: { method: "turn.start", params: { sessionId: "s1" } },
  },
  {
    name: "cancel a turn",
    method: "POST",
    path: "/api/turns/t1/cancel",
    body: {},
    expect: { method: "turn.cancel", params: { turnId: "t1" } },
  },
  {
    name: "enqueue entries",
    method: "POST",
    path: "/api/sessions/s1/queue",
    body: { entries: [{ kind: "agent", role: "user", source: "web", content: [] }] },
    expect: {
      method: "queue.enqueue",
      params: {
        sessionId: "s1",
        entries: [{ kind: "agent", role: "user", source: "web", content: [] }],
      },
    },
  },
  {
    name: "edit a queued entry",
    method: "PATCH",
    path: "/api/sessions/s1/queue/q1",
    body: { content: [{ type: "text", text: "hi" }] },
    expect: {
      method: "queue.edit",
      params: { sessionId: "s1", id: "q1", content: [{ type: "text", text: "hi" }] },
    },
  },
  {
    name: "remove a queued entry",
    method: "DELETE",
    path: "/api/sessions/s1/queue/q1",
    expect: { method: "queue.remove", params: { sessionId: "s1", id: "q1" } },
  },
  {
    name: "clear the queue",
    method: "DELETE",
    path: "/api/sessions/s1/queue",
    expect: { method: "queue.clear", params: { sessionId: "s1" } },
  },
  {
    name: "snapshot entries",
    method: "GET",
    path: "/api/sessions/s1/entries",
    expect: { method: "entries.snapshot", params: { sessionId: "s1" } },
  },
];

test("maps each REST endpoint to exactly one protocol method", async () => {
  for (const item of CASES) {
    const wire = fakeWire();
    const root = await serve(wire.client);

    const response = await fetch(`${root}${item.path}`, {
      method: item.method,
      headers: item.body === undefined ? {} : { "content-type": "application/json" },
      ...(item.body === undefined ? {} : { body: JSON.stringify(item.body) }),
    });

    expect(`${item.name}: ${response.status}`).toBe(`${item.name}: 200`);
    expect(await response.json()).toEqual({ ok: true });
    expect(wire.calls).toEqual([item.expect]);
  }
});

test("rejects request parameters the protocol cannot accept", async () => {
  const wire = fakeWire();
  const root = await serve(wire.client);

  for (const [method, path, body] of [
    ["GET", "/api/sessions/s1?limit=0", undefined],
    ["GET", "/api/sessions/s1?limit=abc", undefined],
    ["POST", "/api/sessions/s1/queue", {}],
    ["PATCH", "/api/sessions/s1/queue/q1", { content: "nope" }],
  ] as const) {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
    });
  }
  expect(wire.calls).toEqual([]);
});

test("propagates protocol error codes with a coarse status", async () => {
  for (const [error, status] of [
    [new ProtocolError("session.not_found", "Session not found"), 404],
    [new ProtocolError("queue.entry_not_found", "Queue entry not found"), 409],
    [new ProtocolError("turn.active", "Turn is active"), 409],
    [new ProtocolError("queue.invalid_control", "Invalid control entry"), 409],
    [new ProtocolError("protocol.invalid_request", "Invalid request parameters"), 400],
    [new ProtocolError("storage.io", "Storage failure"), 500],
    [new WireError("daemon.timeout", "Daemon did not respond"), 503],
    [new WireError("protocol.invalid_response", "Invalid response from daemon"), 502],
  ] as const) {
    const wire = fakeWire(() => error);
    const root = await serve(wire.client);
    const response = await fetch(`${root}/api/sessions`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: { code: error.code, message: error.message },
    });
  }
});

test("never lets the body override the routed session id", async () => {
  const wire = fakeWire();
  const root = await serve(wire.client);

  const response = await fetch(`${root}/api/sessions/A`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "B", model: "m2" }),
  });

  expect(response.status).toBe(200);
  expect(wire.calls[0]?.params).toMatchObject({ sessionId: "A" });
});

test("maps unknown codes to 500 and keeps the code", async () => {
  expect(statusForCode("something.else")).toBe(500);
  expect(statusForCode("session.node_not_found")).toBe(404);
  expect(statusForCode("queue.too_large")).toBe(409);
});

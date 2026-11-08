import { EventEmitter } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
  createNdjsonDecoder,
  MAX_EVENT_BYTES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  type ProtocolEvent,
} from "@pisces/protocol";
import { expect, test } from "vitest";
import type { Gateway } from "../src/gateway/gateway.js";
import type { GatewayRequest, GatewayResponse } from "../src/gateway/protocol.js";
import { createConnection } from "../src/transport/connection.js";

const encoder = new TextEncoder();

const line = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);

const hello = (id = "hello"): Uint8Array =>
  line({ id, method: "protocol.hello", params: { versions: [PROTOCOL_VERSION] } });

const request = (id: string, method: string, params: unknown = {}): Uint8Array =>
  line({ id, method, params });

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Handle = (request: GatewayRequest, connectionId?: string) => Promise<GatewayResponse>;

interface FakeGateway {
  gateway: Gateway;
  attached: Map<string, (event: ProtocolEvent) => void>;
  detached: string[];
  handled: { request: GatewayRequest; connectionId: string | undefined }[];
}

function fakeGateway(
  handle: Handle = async (request) => ({ id: request.id, result: { ok: true } }),
): FakeGateway {
  const attached = new Map<string, (event: ProtocolEvent) => void>();
  const detached: string[] = [];
  const handled: { request: GatewayRequest; connectionId: string | undefined }[] = [];
  const gateway: Gateway = {
    handle(request, connectionId) {
      handled.push({ request, connectionId });
      return handle(request, connectionId);
    },
    attach(connectionId, enqueue) {
      attached.set(connectionId, enqueue);
    },
    detach(connectionId) {
      detached.push(connectionId);
      attached.delete(connectionId);
    },
    dispose() {},
  };
  return { gateway, attached, detached, handled };
}

class FakeSocket extends EventEmitter {
  frames: Uint8Array[] = [];
  ended = false;
  destroyed = false;
  writable = true;
  writeResult = true;
  writeFailure: Error | undefined;

  write(chunk: Uint8Array): boolean {
    if (this.writeFailure !== undefined) throw this.writeFailure;
    if (this.destroyed || this.ended) throw new Error("write after close");
    this.frames.push(Uint8Array.from(chunk));
    return this.writeResult;
  }

  end(): void {
    this.ended = true;
    this.writable = false;
    this.emit("close");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }

  feed(chunk: string | Uint8Array): void {
    this.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }

  json(): unknown[] {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return this.frames.map((frame) => JSON.parse(decoder.decode(frame)));
  }
}

const asSocket = (socket: FakeSocket): Socket => socket as unknown as Socket;

function attachedEnqueue(fake: FakeGateway, index = 0): (event: ProtocolEvent) => void {
  const entry = [...fake.attached.values()][index];
  if (entry === undefined) throw new Error("expected an attached connection");
  return entry;
}

function responseOfJsonBytes(id: string, totalBytes: number): GatewayResponse {
  const base = JSON.stringify({ id, result: { blob: "" } });
  return { id, result: { blob: "a".repeat(totalBytes - base.length) } };
}

function eventOfJsonBytes(totalBytes: number): ProtocolEvent {
  const base = JSON.stringify({
    event: "turn.delta",
    data: { sessionId: "s", seq: 1, at: "2026-11-08T00:00:00.000Z", blob: "" },
  });
  return {
    event: "turn.delta",
    data: {
      sessionId: "s",
      seq: 1,
      at: "2026-11-08T00:00:00.000Z",
      blob: "a".repeat(totalBytes - base.length),
    },
  };
}

test("completes hello and dispatches later requests with a generated connection id", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);

  expect(fake.attached.size).toBe(1);
  const connectionId = [...fake.attached.keys()][0];
  expect(connectionId).toMatch(/[0-9a-f-]{20,}/);

  socket.feed(hello());
  socket.feed(request("r1", "provider.list"));
  await connection.pending();
  await tick();

  expect(fake.handled).toHaveLength(1);
  expect(fake.handled[0]?.request.id).toBe("r1");
  expect(fake.handled[0]?.connectionId).toBe(connectionId);
  expect(socket.json()).toEqual([
    { id: "hello", result: { version: PROTOCOL_VERSION, compatible: true } },
    { id: "r1", result: { ok: true } },
  ]);
  connection.close();
});

test("ignores frames after quiesce without registering them", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);

  socket.feed(hello());
  await tick();
  connection.quiesce();
  socket.feed(request("late", "provider.list"));
  await tick();

  expect(fake.handled).toHaveLength(0);
  connection.close();
});

test("flushes a version mismatch response before closing and detaching", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);

  socket.feed(line({ id: "h", method: "protocol.hello", params: { versions: ["9.0.0"] } }));
  await tick();

  expect(socket.frames).toHaveLength(1);
  expect(socket.json()[0]).toEqual({
    id: "h",
    error: { code: "protocol.version_mismatch", message: expect.any(String) },
  });
  expect(socket.ended).toBe(true);
  expect(socket.destroyed).toBe(true);
  expect(fake.detached).toHaveLength(1);
  expect(fake.handled).toHaveLength(0);
  connection.close();
});

test("closes within the flush limit when a mismatched peer never drains", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  socket.writeResult = false;
  const connection = createConnection(asSocket(socket), fake.gateway, {
    versionMismatchFlushMs: 30,
  });

  socket.feed(line({ id: "h", method: "protocol.hello", params: { versions: ["9.0.0"] } }));
  await tick(10);
  expect(socket.frames).toHaveLength(1);
  expect(socket.ended).toBe(false);
  expect(socket.destroyed).toBe(false);

  await tick(40);
  expect(socket.destroyed).toBe(true);
  expect(fake.detached).toHaveLength(1);
  connection.close();
});

test("keeps pending operations tracked through Gateway completion after disconnect", async () => {
  let release: ((response: GatewayResponse) => void) | undefined;
  const fake = fakeGateway(
    () =>
      new Promise<GatewayResponse>((resolve) => {
        release = resolve;
      }),
  );
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);

  socket.feed(hello());
  socket.feed(request("r", "provider.list"));
  await tick();
  expect(fake.handled).toHaveLength(1);

  let settled = false;
  const pending = connection.pending().then(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);

  socket.destroy();
  expect(fake.detached).toHaveLength(1);
  await tick();
  expect(settled).toBe(false);

  release?.({ id: "r", result: { ok: true } });
  await pending;
  expect(settled).toBe(true);
  expect(socket.frames).toHaveLength(1);
  connection.close();
});

test("serializes concurrent responses and events in enqueue order", async () => {
  const replies = new Map<string, (response: GatewayResponse) => void>();
  const fake = fakeGateway(
    (request) =>
      new Promise<GatewayResponse>((resolve) => {
        replies.set(request.id, resolve);
      }),
  );
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);
  const enqueue = attachedEnqueue(fake);

  socket.feed(hello());
  await tick();
  socket.feed(request("a", "provider.list"));
  socket.feed(request("b", "turn.list"));
  await tick();

  enqueue({ event: "turn.delta", data: { seq: 2, sessionId: "s", at: "b" } });
  replies.get("a")?.({ id: "a", result: { order: 1 } });
  await tick();
  enqueue({ event: "turn.delta", data: { seq: 3, sessionId: "s", at: "c" } });
  replies.get("b")?.({ id: "b", result: { order: 2 } });
  await connection.pending();
  await tick();

  expect(socket.json()).toEqual([
    { id: "hello", result: { version: PROTOCOL_VERSION, compatible: true } },
    { event: "turn.delta", data: { seq: 2, sessionId: "s", at: "b" } },
    { id: "a", result: { order: 1 } },
    { event: "turn.delta", data: { seq: 3, sessionId: "s", at: "c" } },
    { id: "b", result: { order: 2 } },
  ]);
  connection.close();
});

test("snapshots an event before enqueue returns so later mutation cannot alter bytes", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);
  const enqueue = attachedEnqueue(fake);

  socket.feed(hello());
  await tick();

  const event: ProtocolEvent = {
    event: "turn.delta",
    data: { sessionId: "s", seq: 1, at: "2026-11-08T00:00:00.000Z", value: "first" },
  };
  enqueue(event);
  if (event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)) {
    (event.data as { value: string }).value = "second";
  }
  await tick();

  const delivered = socket.json()[1] as { data: { value: string } };
  expect(delivered.data.value).toBe("first");
  connection.close();
});

test("delivers a response of exactly MAX_RESPONSE_BYTES and closes on one byte more", async () => {
  let next: GatewayResponse = responseOfJsonBytes("response", MAX_RESPONSE_BYTES);
  const fake = fakeGateway(async (request) => ({ ...next, id: request.id }));
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);

  socket.feed(hello());
  await tick();

  socket.feed(request("response", "session.read"));
  await connection.pending();
  await tick();

  const delivered = socket.frames[1];
  expect(delivered?.byteLength).toBe(MAX_RESPONSE_BYTES + 1);
  expect(socket.json()[1]).toEqual({ id: "response", result: next.result });

  next = responseOfJsonBytes("response", MAX_RESPONSE_BYTES + 1);
  socket.feed(request("response", "session.read"));
  await connection.pending();
  await tick();

  expect(socket.frames).toHaveLength(2);
  expect(socket.destroyed).toBe(true);
  expect(fake.detached).toHaveLength(1);
  connection.close();
});

test("delivers an event of exactly MAX_EVENT_BYTES and closes only that subscriber above it", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);
  const enqueue = attachedEnqueue(fake);

  socket.feed(hello());
  await tick();

  enqueue(eventOfJsonBytes(MAX_EVENT_BYTES));
  await tick();
  expect(socket.frames[1]?.byteLength).toBe(MAX_EVENT_BYTES + 1);
  expect(socket.destroyed).toBe(false);

  expect(() => enqueue(eventOfJsonBytes(MAX_EVENT_BYTES + 1))).not.toThrow();
  await tick();
  expect(socket.frames).toHaveLength(2);
  expect(socket.destroyed).toBe(true);
  expect(fake.detached).toHaveLength(1);
  connection.close();
});

test("closes only the overflowing connection without throwing into the publisher", async () => {
  const fake = fakeGateway();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const firstConnection = createConnection(asSocket(first), fake.gateway, {
    maxQueuedBytes: 1024,
  });
  const secondConnection = createConnection(asSocket(second), fake.gateway, {
    maxQueuedBytes: 1024,
  });

  first.feed(hello());
  second.feed(hello());
  await tick();
  const firstId = [...fake.attached.keys()][0];
  const secondId = [...fake.attached.keys()][1];

  const enqueueFirst = attachedEnqueue(fake, 0);
  expect(() => enqueueFirst(eventOfJsonBytes(2048))).not.toThrow();
  await tick();

  expect(first.destroyed).toBe(true);
  expect(second.destroyed).toBe(false);
  expect(fake.attached.has(secondId as string)).toBe(true);
  expect(fake.detached).toEqual([firstId]);
  firstConnection.close();
  secondConnection.close();
});

test("bounds queued bytes and closes rather than buffering a stalled writer", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  socket.writeResult = false;
  const connection = createConnection(asSocket(socket), fake.gateway, {
    maxQueuedBytes: 256,
  });

  socket.feed("not json\nnot json\nnot json\nnot json\nnot json\nnot json\nnot json\nnot json\n");
  await tick();

  expect(socket.destroyed).toBe(true);
  expect(socket.frames.length).toBeLessThan(8);
  expect(fake.detached).toHaveLength(1);
  connection.close();
});

test("serializes writes and resumes only after drain", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  socket.writeResult = false;
  const connection = createConnection(asSocket(socket), fake.gateway);

  socket.feed(hello());
  await tick();
  expect(socket.frames).toHaveLength(1);

  attachedEnqueue(fake)(eventOfJsonBytes(200));
  await tick();
  expect(socket.frames).toHaveLength(1);

  socket.emit("drain");
  await tick();
  expect(socket.frames).toHaveLength(2);
  expect(socket.destroyed).toBe(false);
  connection.close();
});

test("attaches its listeners and Gateway connection before returning", () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);

  expect(socket.listenerCount("data")).toBe(1);
  expect(socket.listenerCount("error")).toBe(1);
  expect(socket.listenerCount("close")).toBe(1);
  expect(fake.attached.size).toBe(1);
  connection.close();
});

test("does not answer an already-poisoned decoder repeatedly", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  socket.writeResult = false;
  const connection = createConnection(asSocket(socket), fake.gateway, {
    maxQueuedBytes: 4096,
  });

  socket.feed(Buffer.alloc(8_388_608 + 1, 0x61));
  await tick();
  expect(socket.frames).toHaveLength(1);

  socket.feed(Buffer.from("more bytes\n"));
  await tick();
  socket.emit("drain");
  await tick();

  expect(socket.frames).toHaveLength(1);
  connection.close();
});

test("closes an oversize frame without writing when the socket is no longer writable", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  socket.writable = false;
  const connection = createConnection(asSocket(socket), fake.gateway);

  socket.feed(Buffer.alloc(8_388_608 + 1, 0x61));
  await tick();

  expect(socket.frames).toHaveLength(0);
  expect(socket.destroyed).toBe(true);
  expect(fake.detached).toHaveLength(1);
  connection.close();
});

test("closes only the writing connection on a write failure without leaking the error", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway);

  socket.feed(hello());
  await tick();
  const framesBefore = socket.frames.length;

  socket.writeFailure = new Error("secret socket detail");
  socket.feed(request("r", "provider.list"));
  await tick();

  expect(socket.destroyed).toBe(true);
  expect(socket.frames).toHaveLength(framesBefore);
  expect(fake.detached).toHaveLength(1);
  expect(JSON.stringify(socket.json())).not.toContain("secret socket detail");
  connection.close();
});

test("closes an idle connection that never completes hello", async () => {
  const fake = fakeGateway();
  const socket = new FakeSocket();
  const connection = createConnection(asSocket(socket), fake.gateway, {
    preHelloTimeoutMs: 20,
  });

  await tick(40);
  expect(socket.destroyed).toBe(true);
  expect(fake.detached).toHaveLength(1);
  connection.close();
});

interface Loopback {
  daemon: Socket;
  client: Socket;
  close(): Promise<void>;
}

async function loopback(): Promise<Loopback> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  const accepted = new Promise<Socket>((resolve) => {
    (server as Server).once("connection", resolve);
  });
  const client = connect(address.port, "127.0.0.1");
  const daemon = await accepted;
  return {
    daemon,
    client,
    async close() {
      client.destroy();
      daemon.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Received {
  frames: unknown[];
  waitForFrames(count: number): Promise<void>;
}

function receive(socket: Socket): Received {
  const frames: unknown[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const decoder = createNdjsonDecoder((frame) => {
    frames.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)));
    for (const waiter of [...waiters]) {
      if (frames.length < waiter.count) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  socket.on("data", (chunk: Buffer) => decoder.push(chunk));
  return {
    frames,
    waitForFrames(count) {
      if (frames.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

test("decodes a frame split inside a multi-byte UTF-8 sequence over a real socket", async () => {
  const fake = fakeGateway();
  const wire = await loopback();
  wire.client.on("error", () => {});
  const connection = createConnection(wire.daemon, fake.gateway);
  wire.daemon.resume();
  const received = receive(wire.client);

  const frame = Buffer.from(
    `${JSON.stringify({ id: "héllo", method: "protocol.hello", params: { versions: [PROTOCOL_VERSION] } })}\n`,
  );
  const split = frame.indexOf(0xc3) + 1;
  expect(split).toBeGreaterThan(1);
  wire.client.write(frame.subarray(0, split));
  await tick(5);
  expect(received.frames).toHaveLength(0);
  wire.client.write(frame.subarray(split));

  await received.waitForFrames(1);
  expect(received.frames[0]).toEqual({
    id: "héllo",
    result: { version: PROTOCOL_VERSION, compatible: true },
  });

  wire.client.write(Buffer.from([0xff, 0x0a]));
  await received.waitForFrames(2);
  expect(received.frames[1]).toMatchObject({
    id: "",
    error: { code: "protocol.invalid_json" },
  });

  wire.client.write(request("after", "provider.list"));
  await received.waitForFrames(3);
  expect(received.frames[2]).toEqual({ id: "after", result: { ok: true } });

  connection.close();
  await wire.close();
});

test("responds with frame_too_large to an over-cap partial frame and closes the socket", async () => {
  const fake = fakeGateway();
  const wire = await loopback();
  wire.client.on("error", () => {});
  const connection = createConnection(wire.daemon, fake.gateway);
  wire.daemon.resume();
  const received = receive(wire.client);
  const closed = new Promise<void>((resolve) => wire.client.once("close", resolve));
  const daemonClosed = new Promise<void>((resolve) => wire.daemon.once("close", resolve));

  const chunk = Buffer.alloc(1_000_000, 0x61);
  for (let index = 0; index < 9; index++) wire.client.write(chunk);

  await received.waitForFrames(1);
  expect(received.frames[0]).toMatchObject({
    id: "",
    error: { code: "protocol.frame_too_large" },
  });
  await closed;
  await daemonClosed;
  expect(fake.detached).toHaveLength(1);
  connection.close();
  await wire.close();
});

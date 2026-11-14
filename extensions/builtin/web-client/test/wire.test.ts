import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectWire, type WireClient, WireError } from "../src/server/wire.js";

/**
 * A fake daemon on a real Unix socket: NDJSON in, NDJSON out. It records every
 * frame so handshake order and request ids are asserted on the wire, not
 * inferred from the client's behaviour.
 */

type Frame = Record<string, unknown>;

interface FakeDaemon {
  frames: Frame[];
  push(frame: Frame): void;
  destroy(): void;
  close(): Promise<void>;
}

let root = "";
let socketPath = "";
const servers: Server[] = [];
const clients: WireClient[] = [];
const sockets = new Set<Socket>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-wire-"));
  socketPath = join(root, "daemon.sock");
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

interface DaemonBehaviour {
  /** Answer order for non-hello requests; defaults to arrival order. */
  replyOrder?: "in-order" | "reverse" | "never";
  onRequest?: (frame: Frame, socket: Socket) => void;
}

async function startDaemon(behaviour: DaemonBehaviour = {}): Promise<FakeDaemon> {
  const frames: Frame[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        if (behaviour.onRequest !== undefined) {
          behaviour.onRequest(frame, socket);
          continue;
        }
        if (frame.method === "protocol.hello") {
          socket.write(
            `${JSON.stringify({ id: frame.id, result: { version: PROTOCOL_VERSION, compatible: true } })}\n`,
          );
          continue;
        }
        pending.push(frame);
        if (behaviour.replyOrder === "never") continue;
        if (behaviour.replyOrder === "reverse") {
          if (pending.length < 2) continue;
          for (const answer of pending.splice(0).reverse()) {
            socket.write(`${JSON.stringify({ id: answer.id, result: { echo: answer.method } })}\n`);
          }
          continue;
        }
        socket.write(`${JSON.stringify({ id: frame.id, result: { echo: frame.method } })}\n`);
        pending.splice(0);
      }
    });
    socket.on("error", () => {});
  });
  const pending: Frame[] = [];
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    frames,
    push(frame) {
      for (const socket of sockets) socket.write(`${JSON.stringify(frame)}\n`);
    },
    destroy() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

const connect = async (): Promise<WireClient> => {
  const client = await connectWire(socketPath);
  clients.push(client);
  return client;
};

test("completes the hello handshake before serving requests", async () => {
  const daemon = await startDaemon();
  const client = await connect();

  await client.request("session.list", {});

  expect(daemon.frames.map((frame) => frame.method)).toEqual(["protocol.hello", "session.list"]);
  expect(daemon.frames[0]?.params).toEqual({ versions: [PROTOCOL_VERSION] });
});

test("multiplexes concurrent requests by id", async () => {
  const daemon = await startDaemon({ replyOrder: "reverse" });
  const client = await connect();

  const [first, second] = await Promise.all([
    client.request("session.list", {}),
    client.request("provider.list", {}),
  ]);

  expect(first).toEqual({ echo: "session.list" });
  expect(second).toEqual({ echo: "provider.list" });
  expect(daemon.frames).toHaveLength(3);
});

test("routes event frames to listeners and stops after unsubscribe", async () => {
  const daemon = await startDaemon();
  const client = await connect();
  const seen: unknown[] = [];
  const stop = client.onEvent((event) => seen.push(event));

  daemon.push({ event: "turn.started", data: { sessionId: "s1", seq: 1 } });
  daemon.push({ event: "turn.ended", data: { sessionId: "s1", seq: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stop();
  daemon.push({ event: "turn.started", data: { sessionId: "s1", seq: 3 } });
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(seen).toEqual([
    { event: "turn.started", data: { sessionId: "s1", seq: 1 } },
    { event: "turn.ended", data: { sessionId: "s1", seq: 2 } },
  ]);
});

test("rejects in-flight requests when the socket closes", async () => {
  const daemon = await startDaemon({ replyOrder: "never" });
  const client = await connect();
  const pending = client.request("session.list", {});

  daemon.destroy();

  await expect(pending).rejects.toBeInstanceOf(WireError);
  await expect(pending).rejects.toMatchObject({ code: "daemon.unreachable" });
});

test("rejects with daemon.unreachable when nothing is listening", async () => {
  await expect(connectWire(join(root, "absent.sock"))).rejects.toMatchObject({
    code: "daemon.unreachable",
  });
});

test("maps a failed handshake to daemon.unreachable", async () => {
  await startDaemon({
    onRequest(frame, socket) {
      socket.write(
        `${JSON.stringify({ id: frame.id, error: { code: "protocol.version_mismatch", message: "no" } })}\n`,
      );
    },
  });

  await expect(connectWire(socketPath)).rejects.toMatchObject({ code: "daemon.unreachable" });
});

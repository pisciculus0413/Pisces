import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, test } from "vitest";
import { ClientError, connectClient } from "../src/client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Frame {
  id: string;
  method: string;
  params: unknown;
}

type Reply = (value: unknown) => void;
type Handler = (frame: Frame, reply: Reply, socket: Socket) => void;

interface FakeDaemon {
  path: string;
  frames: Frame[];
  sockets: Socket[];
  close(): Promise<void>;
}

/** A minimal NDJSON daemon: records every frame and delegates to `handler`. */
async function fakeDaemon(handler: Handler): Promise<FakeDaemon> {
  const root = await mkdtemp(join(tmpdir(), "pisces-client-"));
  roots.push(root);
  const path = join(root, "pisces.sock");
  const frames: Frame[] = [];
  const sockets: Socket[] = [];

  const server: Server = createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        handler(
          frame,
          (value) => {
            socket.write(`${JSON.stringify(value)}\n`);
          },
          socket,
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  return {
    path,
    frames,
    sockets,
    async close() {
      for (const socket of sockets.splice(0)) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

const hello = (frame: Frame, reply: Reply): boolean => {
  if (frame.method !== "protocol.hello") return false;
  reply({ id: frame.id, result: { version: PROTOCOL_VERSION, compatible: true } });
  return true;
};

function autoHello(handler: Handler): Handler {
  return (frame, reply, socket) => {
    if (hello(frame, reply)) return;
    handler(frame, reply, socket);
  };
}

test("sends hello first, then requests with unique ids and their params", async () => {
  const daemon = await fakeDaemon(
    autoHello((frame, reply) => {
      reply({ id: frame.id, result: { method: frame.method, params: frame.params } });
    }),
  );
  const client = await connectClient(daemon.path);
  try {
    const first = await client.request("template.list", {});
    const second = await client.request("template.preview", {
      templateId: "notes",
      workspace: "/tmp/notes",
    });

    expect(first).toEqual({ method: "template.list", params: {} });
    expect(second).toEqual({
      method: "template.preview",
      params: { templateId: "notes", workspace: "/tmp/notes" },
    });
    expect(daemon.frames.map((frame) => frame.method)).toEqual([
      "protocol.hello",
      "template.list",
      "template.preview",
    ]);
    expect(daemon.frames[0]?.params).toEqual({ versions: [PROTOCOL_VERSION] });
    const ids = daemon.frames.map((frame) => frame.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const frame of daemon.frames) {
      expect(Object.keys(frame).sort()).toEqual(["id", "method", "params"]);
    }
  } finally {
    client.close();
    await daemon.close();
  }
});

test("rejects a protocol error with its code and message", async () => {
  const daemon = await fakeDaemon(
    autoHello((frame, reply) => {
      reply({
        id: frame.id,
        error: { code: "template.not_found", message: "Template not found" },
      });
    }),
  );
  const client = await connectClient(daemon.path);
  try {
    const error = await client.request("template.preview", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      code: "template.not_found",
      message: "Template not found",
    });
  } finally {
    client.close();
    await daemon.close();
  }
});

test("times out one request after the configured budget", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path, 100);
  try {
    const started = Date.now();
    const error = await client.request("template.list", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "client.timeout", message: "Daemon did not respond" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  } finally {
    client.close();
    await daemon.close();
  }
});

test("close rejects every pending request and destroys the socket", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  const pending = client.request("template.list", {});
  client.close();

  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ClientError);
  expect(error).toMatchObject({ code: "client.closed", message: "Client is closed" });

  await expect(client.request("template.list", {})).rejects.toMatchObject({
    code: "client.closed",
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await daemon.close();
});

test("two concurrent requests resolve independently even out of order", async () => {
  const daemon = await fakeDaemon(
    autoHello((frame, reply) => {
      const order = (frame.params as { order: number }).order;
      const delay = order === 1 ? 40 : 5;
      setTimeout(() => {
        reply({ id: frame.id, result: { order } });
      }, delay);
    }),
  );
  const client = await connectClient(daemon.path);
  try {
    const [slow, fast] = await Promise.all([
      client.request("template.preview", { order: 1 }),
      client.request("template.preview", { order: 2 }),
    ]);
    expect(slow).toEqual({ order: 1 });
    expect(fast).toEqual({ order: 2 });
  } finally {
    client.close();
    await daemon.close();
  }
});

test("a malformed response line rejects safely without leaking parser text", async () => {
  const daemon = await fakeDaemon(
    autoHello((_frame, _reply, socket) => {
      socket.write("not json\n");
    }),
  );
  const client = await connectClient(daemon.path);
  try {
    const error = await client.request("template.list", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      code: "client.protocol",
      message: "Invalid response from daemon",
    });
    expect((error as Error).message).not.toContain("JSON");
  } finally {
    client.close();
    await daemon.close();
  }
});

test("an oversized frame rejects safely without leaking parser text", async () => {
  const daemon = await fakeDaemon(
    autoHello((_frame, _reply, socket) => {
      socket.write("x".repeat(MAX_FRAME_BYTES + 1));
    }),
  );
  const client = await connectClient(daemon.path);
  try {
    const error = await client.request("template.list", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      code: "client.protocol",
      message: "Invalid response from daemon",
    });
  } finally {
    client.close();
    await daemon.close();
  }
});

test("connect failures reject with daemon.unreachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pisces-client-missing-"));
  roots.push(root);
  const error = await connectClient(join(root, "missing.sock"), 200).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ClientError);
  expect(error).toMatchObject({ code: "daemon.unreachable" });
});

test("an incompatible hello rejects the connection", async () => {
  const daemon = await fakeDaemon((frame, reply) => {
    reply({
      id: frame.id,
      error: { code: "protocol.version_mismatch", message: "No compatible protocol version" },
    });
  });
  const error = await connectClient(daemon.path, 200).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ClientError);
  expect(error).toMatchObject({ code: "protocol.version_mismatch" });
  await daemon.close();
});

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "@pisces/protocol";
import { afterEach, expect, test, vi } from "vitest";
import {
  CLIENT_TIMEOUT_MS,
  ClientError,
  connectClient,
  type EventListener,
} from "../src/client.js";

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

test("a per-request budget overrides the connection default", async () => {
  const daemon = await fakeDaemon(
    autoHello((frame, reply) => {
      setTimeout(() => {
        reply({ id: frame.id, result: { method: frame.method } });
      }, 250);
    }),
  );
  // The connection default is far too small for a scripted apply, but the
  // explicit per-request budget must still be honoured.
  const client = await connectClient(daemon.path, 100);
  try {
    const result = await client.request("template.apply", {}, { timeoutMs: 5000 });
    expect(result).toEqual({ method: "template.apply" });
  } finally {
    client.close();
    await daemon.close();
  }
});

test("a request without an override still times out at the 5 s default", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  try {
    expect(CLIENT_TIMEOUT_MS).toBe(5000);
    vi.useFakeTimers();
    let settled: unknown;
    const pending = client.request("template.apply", {}).then(
      (value) => {
        settled = value;
        return value;
      },
      (error: unknown) => {
        settled = error;
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ code: "client.timeout", message: "Daemon did not respond" });
  } finally {
    vi.useRealTimers();
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

/** Pushes one event frame, then answers the request as a barrier. */
function eventThenReply(event: string, data: unknown): Handler {
  return autoHello((frame, reply) => {
    reply({ event, data });
    reply({ id: frame.id, result: {} });
  });
}

test("delivers event frames to every listener and unsubscribes only one", async () => {
  const daemon = await fakeDaemon(eventThenReply("turn.delta", { text: "a" }));
  const client = await connectClient(daemon.path);
  try {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const unsubscribe = client.onEvent((event) => first.push(event));
    client.onEvent((event) => second.push(event));

    await client.request("turn.start", {});
    expect(first).toEqual([{ event: "turn.delta", data: { text: "a" } }]);
    expect(second).toEqual([{ event: "turn.delta", data: { text: "a" } }]);

    unsubscribe();
    unsubscribe();
    await client.request("turn.start", {});
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  } finally {
    client.close();
    await daemon.close();
  }
});

test("the same function registered twice unsubscribes one registration only", async () => {
  const daemon = await fakeDaemon(eventThenReply("turn.delta", { text: "a" }));
  const client = await connectClient(daemon.path);
  try {
    const received: unknown[] = [];
    const listener: EventListener = (event) => received.push(event);
    const unsubscribeFirst = client.onEvent(listener);
    client.onEvent(listener);

    await client.request("turn.start", {});
    expect(received).toEqual([
      { event: "turn.delta", data: { text: "a" } },
      { event: "turn.delta", data: { text: "a" } },
    ]);

    unsubscribeFirst();
    unsubscribeFirst();
    await client.request("turn.start", {});
    expect(received).toEqual([
      { event: "turn.delta", data: { text: "a" } },
      { event: "turn.delta", data: { text: "a" } },
      { event: "turn.delta", data: { text: "a" } },
    ]);
  } finally {
    client.close();
    await daemon.close();
  }
});

test("onEvent on a closed client is inert and returns a no-op unsubscribe", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  client.close();

  const listener = vi.fn();
  const unsubscribe = client.onEvent(listener);
  expect(typeof unsubscribe).toBe("function");
  expect(unsubscribe()).toBeUndefined();
  expect(unsubscribe()).toBeUndefined();
  expect(listener).not.toHaveBeenCalled();
  await daemon.close();
});

test("a response frame resolves its waiter without reaching listeners", async () => {
  const daemon = await fakeDaemon(
    autoHello((frame, reply) => {
      reply({ id: frame.id, result: { ok: true } });
    }),
  );
  const client = await connectClient(daemon.path);
  try {
    const listener = vi.fn();
    client.onEvent(listener);
    await expect(client.request("template.list", {})).resolves.toEqual({ ok: true });
    expect(listener).not.toHaveBeenCalled();
  } finally {
    client.close();
    await daemon.close();
  }
});

test.each([
  { result: {} },
  { event: 7, data: { text: "x" } },
  { event: "turn.delta", data: [1, 2] },
  { event: "turn.delta" },
])("a frame that is neither a response nor an event closes the connection", async (frame) => {
  const daemon = await fakeDaemon(
    autoHello((_frame, reply) => {
      reply(frame);
      reply({ event: "turn.delta", data: { text: "late" } });
    }),
  );
  const client = await connectClient(daemon.path);
  try {
    const listener = vi.fn();
    client.onEvent(listener);
    const error = await client.request("turn.start", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({
      code: "client.protocol",
      message: "Invalid response from daemon",
    });
    await expect(client.request("turn.start", {})).rejects.toMatchObject({
      code: "client.closed",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).not.toHaveBeenCalled();
  } finally {
    client.close();
    await daemon.close();
  }
});

test("close clears listeners so later frames are not delivered", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  const listener = vi.fn();
  client.onEvent(listener);
  client.close();

  const serverSide = daemon.sockets[0];
  expect(serverSide).toBeDefined();
  serverSide?.write(`${JSON.stringify({ event: "turn.delta", data: { text: "late" } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(listener).not.toHaveBeenCalled();
  await daemon.close();
});

test("a throwing listener does not stop the others or break the client", async () => {
  const daemon = await fakeDaemon(eventThenReply("turn.delta", { text: "a" }));
  const client = await connectClient(daemon.path);
  try {
    const received: unknown[] = [];
    client.onEvent(() => {
      throw new Error("listener boom");
    });
    client.onEvent((event) => received.push(event));

    await expect(client.request("turn.start", {})).resolves.toEqual({});
    expect(received).toEqual([{ event: "turn.delta", data: { text: "a" } }]);
  } finally {
    client.close();
    await daemon.close();
  }
});

test("onClose notifies every live registration once on explicit close", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  const first = vi.fn();
  const second = vi.fn();
  const removed = vi.fn();
  client.onClose(first);
  client.onClose(second);
  const unsubscribe = client.onClose(removed);
  unsubscribe();
  unsubscribe();

  client.close();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledWith(
    expect.objectContaining({ code: "client.closed", message: "Client is closed" }),
  );
  expect(removed).not.toHaveBeenCalled();

  client.close();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  await daemon.close();
});

test("the same close listener registered twice is notified twice", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  const listener = vi.fn();
  client.onClose(listener);
  client.onClose(listener);

  client.close();
  expect(listener).toHaveBeenCalledTimes(2);
  await daemon.close();
});

test("onClose after the client is closed invokes immediately and returns a no-op", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  client.close();

  const listener = vi.fn();
  const unsubscribe = client.onClose(listener);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({ code: "client.closed", message: "Client is closed" }),
  );
  expect(unsubscribe()).toBeUndefined();
  expect(unsubscribe()).toBeUndefined();
  expect(listener).toHaveBeenCalledTimes(1);
  await daemon.close();
});

test("a throwing close listener does not stop the others", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  client.onClose(() => {
    throw new Error("close listener boom");
  });
  const received: ClientError[] = [];
  client.onClose((error) => received.push(error));

  expect(() => client.close()).not.toThrow();
  expect(received).toHaveLength(1);
  await daemon.close();
});

test("onClose reports client.closed when the socket closes", async () => {
  const daemon = await fakeDaemon(autoHello(() => {}));
  const client = await connectClient(daemon.path);
  const errors: ClientError[] = [];
  client.onClose((error) => errors.push(error));

  daemon.sockets[0]?.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ code: "client.closed", message: "Client is closed" });
  await daemon.close();
});

test("onClose reports client.protocol on a malformed frame", async () => {
  const daemon = await fakeDaemon(
    autoHello((_frame, _reply, socket) => {
      socket.write("not json\n");
    }),
  );
  const client = await connectClient(daemon.path);
  const errors: ClientError[] = [];
  client.onClose((error) => errors.push(error));

  await client.request("template.list", {}).catch(() => {});
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    code: "client.protocol",
    message: "Invalid response from daemon",
  });
  await daemon.close();
});

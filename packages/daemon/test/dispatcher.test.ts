import { PROTOCOL_VERSION } from "@pisces/protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Gateway } from "../src/gateway/gateway.js";
import type { GatewayRequest, GatewayResponse } from "../src/gateway/protocol.js";
import { createDispatcher, type Dispatcher } from "../src/transport/dispatcher.js";
import { createGatewayHarness, type GatewayHarness } from "./support/gateway-harness.js";

const encoder = new TextEncoder();

const line = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);

const hello = (id = "hello", versions: string[] = [PROTOCOL_VERSION]): Uint8Array =>
  line({ id, method: "protocol.hello", params: { versions } });

const request = (id: string, method: string, params: unknown = {}): Uint8Array =>
  line({ id, method, params });

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Handle = (request: GatewayRequest, connectionId?: string) => Promise<GatewayResponse>;

interface RecorderOptions {
  preHelloTimeoutMs?: number;
  serverVersion?: string;
  send?: (response: GatewayResponse) => void;
}

interface Recorder {
  dispatcher: Dispatcher;
  responses: GatewayResponse[];
  calls: { close: number; flush: number };
  handled: { request: GatewayRequest; connectionId: string | undefined }[];
}

function recorder(handle: Handle, options: RecorderOptions = {}): Recorder {
  const responses: GatewayResponse[] = [];
  const calls = { close: 0, flush: 0 };
  const handled: { request: GatewayRequest; connectionId: string | undefined }[] = [];
  const gateway: Pick<Gateway, "handle"> = {
    async handle(request, connectionId) {
      handled.push({ request, connectionId });
      return handle(request, connectionId);
    },
  };
  const dispatcher = createDispatcher({
    gateway,
    connectionId: "connection-1",
    send: options.send ?? ((response) => responses.push(response)),
    close: () => {
      calls.close += 1;
    },
    flushAndClose: () => {
      calls.flush += 1;
    },
    preHelloTimeoutMs: options.preHelloTimeoutMs ?? 60_000,
    ...(options.serverVersion !== undefined ? { serverVersion: options.serverVersion } : {}),
  });
  return { dispatcher, responses, calls, handled };
}

const echo: Handle = async (request) => ({ id: request.id, result: { echoed: request.method } });

test("completes hello with the first compatible client version", () => {
  const { dispatcher, responses, handled } = recorder(echo, { serverVersion: "1.2.0" });

  dispatcher.accept(hello("handshake", ["2.0.0", "1.3.0", "1.1.0", "1.2.0"]));

  expect(responses).toEqual([{ id: "handshake", result: { version: "1.1.0", compatible: true } }]);
  expect(handled).toHaveLength(0);
  dispatcher.dispose();
});

test("requires hello before other methods but keeps the connection eligible", async () => {
  const { dispatcher, responses, handled } = recorder(echo);

  dispatcher.accept(request("early", "provider.list"));
  expect(responses[0]?.id).toBe("early");
  expect(responses[0]?.error?.code).toBe("protocol.hello_required");
  expect(handled).toHaveLength(0);

  dispatcher.accept(hello("handshake"));
  expect(responses[1]).toEqual({
    id: "handshake",
    result: { version: PROTOCOL_VERSION, compatible: true },
  });

  dispatcher.accept(request("later", "provider.list"));
  await dispatcher.pending();

  expect(handled).toHaveLength(1);
  expect(handled[0]?.request.id).toBe("later");
  expect(handled[0]?.connectionId).toBe("connection-1");
  expect(responses[2]).toEqual({ id: "later", result: { echoed: "provider.list" } });
  dispatcher.dispose();
});

test("rejects a duplicate hello without disturbing the pinned version", async () => {
  const { dispatcher, responses, handled } = recorder(echo);

  dispatcher.accept(hello("first"));
  dispatcher.accept(hello("second"));
  dispatcher.accept(request("r", "turn.list"));
  await dispatcher.pending();

  expect(responses[1]?.id).toBe("second");
  expect(responses[1]?.error?.code).toBe("protocol.invalid_request");
  expect(handled.map((entry) => entry.request.id)).toEqual(["r"]);
  dispatcher.dispose();
});

test("sends a version mismatch response, requests a flush-close, and stops reading frames", () => {
  const { dispatcher, responses, calls, handled } = recorder(echo);

  dispatcher.accept(hello("handshake", ["2.0.0", "not-a-version"]));
  expect(responses).toEqual([
    {
      id: "handshake",
      error: { code: "protocol.version_mismatch", message: expect.any(String) },
    },
  ]);
  expect(calls.flush).toBe(1);
  expect(calls.close).toBe(0);

  dispatcher.accept(hello("again"));
  dispatcher.accept(request("early", "provider.list"));
  expect(responses).toHaveLength(1);
  expect(handled).toHaveLength(0);
  dispatcher.dispose();
});

test("rejects invalid hello versions as invalid_request and remains pre-hello", async () => {
  const { dispatcher, responses, calls } = recorder(echo);

  dispatcher.accept(line({ id: "bad", method: "protocol.hello", params: { versions: "0.0.1" } }));
  dispatcher.accept(
    line({ id: "bad2", method: "protocol.hello", params: { versions: ["0.0.1", 1] } }),
  );

  expect(responses.map((response) => response.error?.code)).toEqual([
    "protocol.invalid_request",
    "protocol.invalid_request",
  ]);
  expect(calls.flush).toBe(0);

  dispatcher.accept(hello("good"));
  expect(responses[2]?.result).toEqual({ version: PROTOCOL_VERSION, compatible: true });
  dispatcher.dispose();
});

test("maps invalid UTF-8 and malformed JSON to invalid_json with the empty id sentinel", () => {
  const { dispatcher, responses } = recorder(echo);

  dispatcher.accept(new Uint8Array([0x7b, 0xff, 0x7d]));
  dispatcher.accept(encoder.encode("{"));

  expect(responses).toHaveLength(2);
  for (const response of responses) {
    expect(response.id).toBe("");
    expect(response.error?.code).toBe("protocol.invalid_json");
    expect(response.error?.message).not.toContain("{");
    expect(response.error?.message).not.toContain("\u00ff");
  }
  dispatcher.dispose();
});

test("validates the envelope shape with the empty id sentinel for unusable ids", () => {
  const { dispatcher, responses } = recorder(echo);

  const invalid: { frame: unknown; id: string }[] = [
    { frame: [], id: "" },
    { frame: null, id: "" },
    { frame: 42, id: "" },
    { frame: "text", id: "" },
    { frame: {}, id: "" },
    { frame: { method: "provider.list", params: {} }, id: "" },
    { frame: { id: 7, method: "provider.list", params: {} }, id: "" },
    { frame: { id: "ok", params: {} }, id: "ok" },
    { frame: { id: "ok", method: 1, params: {} }, id: "ok" },
    { frame: { id: "ok", method: "provider.list" }, id: "ok" },
    { frame: { id: "ok", method: "provider.list", params: [] }, id: "ok" },
    { frame: { id: "ok", method: "provider.list", params: null }, id: "ok" },
  ];

  for (const entry of invalid) dispatcher.accept(line(entry.frame));

  expect(responses).toHaveLength(invalid.length);
  for (const [index, response] of responses.entries()) {
    expect(response.id).toBe(invalid[index]?.id);
    expect(response.error?.code).toBe("protocol.invalid_request");
  }
  dispatcher.dispose();
});

test("keeps answering repeated framing errors without accepting a handshake", () => {
  const { dispatcher, responses, handled } = recorder(echo);

  for (let index = 0; index < 3; index++) dispatcher.accept(encoder.encode("not json"));
  expect(responses.map((response) => response.error?.code)).toEqual([
    "protocol.invalid_json",
    "protocol.invalid_json",
    "protocol.invalid_json",
  ]);
  expect(handled).toHaveLength(0);
  dispatcher.dispose();
});

test("maps a rejected Gateway operation to a fixed internal error", async () => {
  const { dispatcher, responses } = recorder(async () => {
    throw new Error("Authorization: Bearer super-secret");
  });

  dispatcher.accept(hello());
  dispatcher.accept(request("r", "provider.list"));
  await dispatcher.pending();

  expect(responses[1]).toEqual({
    id: "r",
    error: { code: "internal.error", message: "Internal error" },
  });
  expect(JSON.stringify(responses)).not.toContain("super-secret");
  dispatcher.dispose();
});

test("tracks an admitted operation in pending until its response is enqueued", async () => {
  let release: ((response: GatewayResponse) => void) | undefined;
  const { dispatcher, responses } = recorder(
    () =>
      new Promise<GatewayResponse>((resolve) => {
        release = resolve;
      }),
  );

  dispatcher.accept(hello());
  dispatcher.accept(request("slow", "provider.list"));

  let settled = false;
  const pending = dispatcher.pending().then(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);

  release?.({ id: "slow", result: { ok: true } });
  await pending;

  expect(settled).toBe(true);
  expect(responses.at(-1)).toEqual({ id: "slow", result: { ok: true } });
  dispatcher.dispose();
});

test("quiescing rejects new frames before pending registration and leaves running work alone", async () => {
  let release: ((response: GatewayResponse) => void) | undefined;
  const { dispatcher, responses, handled } = recorder(
    () =>
      new Promise<GatewayResponse>((resolve) => {
        release = resolve;
      }),
  );

  dispatcher.accept(hello());
  dispatcher.accept(request("admitted", "provider.list"));
  dispatcher.quiesce();

  dispatcher.accept(request("rejected", "turn.list"));
  expect(handled.map((entry) => entry.request.id)).toEqual(["admitted"]);

  let settled = false;
  const pending = dispatcher.pending().then(() => {
    settled = true;
  });
  await tick();
  expect(settled).toBe(false);

  release?.({ id: "admitted", result: { ok: true } });
  await pending;
  expect(responses.map((response) => response.id)).toEqual(["hello", "admitted"]);
  dispatcher.dispose();
});

test("closes a connection that never completes hello within the pre-hello timeout", () => {
  vi.useFakeTimers();
  try {
    const { dispatcher, calls } = recorder(echo, { preHelloTimeoutMs: 5000 });

    vi.advanceTimersByTime(4999);
    expect(calls.close).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.close).toBe(1);

    dispatcher.accept(hello());
    vi.advanceTimersByTime(10_000);
    expect(calls.close).toBe(1);
    dispatcher.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("cancels the pre-hello timeout after a successful hello", () => {
  vi.useFakeTimers();
  try {
    const { dispatcher, calls } = recorder(echo, { preHelloTimeoutMs: 5000 });
    dispatcher.accept(hello());
    vi.advanceTimersByTime(10_000);
    expect(calls.close).toBe(0);
    dispatcher.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("stops sending after the writer refuses a response", async () => {
  let sendCount = 0;
  const { dispatcher, responses } = recorder(echo, {
    send: (response) => {
      sendCount += 1;
      responses.push(response);
      throw new Error("closed");
    },
  });

  dispatcher.accept(hello());
  dispatcher.accept(request("r", "provider.list"));
  await dispatcher.pending();

  expect(sendCount).toBe(1);
  expect(responses).toHaveLength(1);
  dispatcher.dispose();
});

describe("routing through the real Gateway", () => {
  let harness: GatewayHarness;

  beforeAll(async () => {
    harness = await createGatewayHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  test("inherited method names remain unknown", async () => {
    const responses: GatewayResponse[] = [];
    const dispatcher = createDispatcher({
      gateway: harness.gateway,
      connectionId: "wire-connection",
      send: (response) => responses.push(response),
      close: () => {},
      flushAndClose: () => {},
      preHelloTimeoutMs: 60_000,
    });

    dispatcher.accept(hello());
    for (const method of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      dispatcher.accept(request(method, method));
    }
    await dispatcher.pending();

    expect(responses.slice(1).map((response) => response.error?.code)).toEqual([
      "protocol.unknown_method",
      "protocol.unknown_method",
      "protocol.unknown_method",
      "protocol.unknown_method",
      "protocol.unknown_method",
    ]);
    dispatcher.dispose();
  });
});

import {
  type Credential,
  createOpenAiChatAdapter,
  createProviderManagement,
  type LlmEvent,
  PiscesError,
  type ProviderDescriptor,
  type WireRequest,
} from "@pisces/core";
import { afterEach, expect, test, vi } from "vitest";
import { createProviderHost, type ProviderHost, type ProviderHostOptions } from "../src/index.js";

const now = Date.parse("2026-11-08T00:00:00.000Z");

function model(id = "m") {
  return {
    id,
    contextWindow: 100_000,
    maxOutput: 4_000,
    modalities: ["text" as const],
  };
}

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: "p",
    dialect: "fake",
    baseUrl: "https://example.test/v1",
    auth: { type: "apiKey", credentialRef: "ref" },
    headers: { "x-tier": "descriptor" },
    models: [model()],
    ...overrides,
  };
}

function credentialsWith(
  entries: Record<string, Credential | undefined>,
  refreshed: Record<string, Credential | undefined> = {},
) {
  const get = vi.fn(async (credentialRef: string) => entries[credentialRef]);
  const refresh = vi.fn(async (credentialRef: string) => {
    const credential = refreshed[credentialRef];
    if (!credential) throw new Error("refresh secret");
    return credential;
  });
  return { credentials: { get, refresh }, get, refresh };
}

function providersWith(value = descriptor()) {
  const providers = createProviderManagement();
  providers.registerProvider(value);
  return providers;
}

function request(overrides: Partial<WireRequest> = {}): WireRequest {
  return {
    path: "/chat/completions",
    body: '{"x":1}',
    headers: { "x-tier": "adapter" },
    ...overrides,
  };
}

function hostOptions(overrides: Partial<ProviderHostOptions> = {}): ProviderHostOptions {
  return {
    providers: providersWith(),
    credentials: credentialsWith({
      ref: { type: "apiKey", value: "secret-key" },
    }).credentials,
    now: () => now,
    ...overrides,
  };
}

function executeFor(host: ProviderHost, signal?: AbortSignal, wire = request()) {
  return host.execute("p")(wire, signal);
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

async function raceWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sseResponse(...frames: string[]): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("resolves credentials, merges headers case-insensitively, and preserves base paths", async () => {
  const input = descriptor({
    headers: { "x-tier": "descriptor", "x-descriptor": "kept" },
  });
  const providers = providersWith(input);
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (value, init) => {
    calls.push({ input: String(value), init: init ?? {} });
    return sseResponse("ok");
  };
  const host = createProviderHost(
    hostOptions({
      providers,
      fetch: fetchImpl,
      credentials: credentialsWith({
        ref: { type: "apiKey", value: "secret-key" },
      }).credentials,
    }),
  );
  input.baseUrl = "https://evil.test";
  if (input.headers) input.headers["x-tier"] = "mutated";
  input.auth.credentialRef = "mutated";

  expect(await host.ready("p")).toBe(true);
  expect(
    await collect(
      executeFor(
        host,
        undefined,
        request({
          headers: {
            "X-Tier": "adapter",
            AUTHORIZATION: "Bearer attacker",
            "content-type": "application/custom",
          },
        }),
      ),
    ),
  ).toEqual(["ok"]);

  const call = calls[0];
  expect(call).toBeDefined();
  if (!call) throw new Error("Missing fetch call");
  expect(call.input).toBe("https://example.test/v1/chat/completions");
  expect(call.init.method).toBe("POST");
  expect(call.init.body).toBe('{"x":1}');
  const headers = new Headers(call.init.headers);
  expect(headers.get("x-tier")).toBe("adapter");
  expect(headers.get("x-descriptor")).toBe("kept");
  expect(headers.get("authorization")).toBe("Bearer secret-key");
  expect(headers.get("content-type")).toBe("application/custom");
});

test("defaults content type and reports readiness only for non-empty usable credentials", async () => {
  const calls: RequestInit[] = [];
  const credentials = credentialsWith({
    ref: { type: "apiKey", value: "secret-key" },
  });
  const readyHost = createProviderHost(
    hostOptions({
      credentials: credentials.credentials,
      fetch: async (_input, init) => {
        calls.push(init ?? {});
        return new Response("plain");
      },
    }),
  );

  expect(await readyHost.ready("p")).toBe(true);
  expect(await collect(executeFor(readyHost, undefined, request({ headers: {} })))).toEqual([
    "plain",
  ]);
  expect(new Headers(calls[0]?.headers).get("content-type")).toBe("application/json");

  const emptyModels = providersWith(descriptor({ models: [] }));
  expect(
    await createProviderHost(
      hostOptions({ providers: emptyModels, credentials: credentials.credentials }),
    ).ready("p"),
  ).toBe(false);

  for (const credential of [
    undefined,
    { type: "oauth" as const, value: "wrong-type" },
    { type: "apiKey" as const, value: "" },
    { type: "apiKey" as const, value: "expired", expiresAt: new Date(now).toISOString() },
    { type: "apiKey" as const, value: "invalid-date", expiresAt: "not-a-date" },
  ]) {
    const values = credentialsWith({ ref: credential });
    expect(
      await createProviderHost(hostOptions({ credentials: values.credentials })).ready("p"),
    ).toBe(false);
  }

  const throwing = credentialsWith({});
  throwing.get.mockRejectedValueOnce(new Error("secret credential failure"));
  expect(
    await createProviderHost(hostOptions({ credentials: throwing.credentials })).ready("p"),
  ).toBe(false);
  expect(await createProviderHost(hostOptions()).ready("missing")).toBe(false);
});

test("refreshes missing or expired OAuth credentials but not a fresh OAuth credential", async () => {
  const oauth = descriptor({ auth: { type: "oauth", credentialRef: "ref" } });
  const refreshed = credentialsWith(
    { ref: undefined },
    { ref: { type: "oauth", value: "fresh-oauth" } },
  );
  const fetchImpl: typeof fetch = async () => new Response("ok");
  const missing = createProviderHost(
    hostOptions({
      providers: providersWith(oauth),
      credentials: refreshed.credentials,
      fetch: fetchImpl,
    }),
  );
  expect(await collect(executeFor(missing))).toEqual(["ok"]);
  expect(refreshed.refresh).toHaveBeenCalledOnce();

  const expired = credentialsWith(
    { ref: { type: "oauth", value: "old", expiresAt: "2026-11-07T00:00:00.000Z" } },
    { ref: { type: "oauth", value: "new" } },
  );
  const expiredHost = createProviderHost(
    hostOptions({
      providers: providersWith(oauth),
      credentials: expired.credentials,
      fetch: fetchImpl,
    }),
  );
  expect(await collect(executeFor(expiredHost))).toEqual(["ok"]);
  expect(expired.refresh).toHaveBeenCalledOnce();

  const fresh = credentialsWith({
    ref: { type: "oauth", value: "already-fresh" },
  });
  const freshHost = createProviderHost(
    hostOptions({
      providers: providersWith(oauth),
      credentials: fresh.credentials,
      fetch: fetchImpl,
    }),
  );
  expect(await collect(executeFor(freshHost))).toEqual(["ok"]);
  expect(fresh.refresh).not.toHaveBeenCalled();
});

test("preserves cancellation while credential lookup or refresh is pending", async () => {
  let getStartedResolve!: () => void;
  const getStarted = new Promise<void>((resolve) => {
    getStartedResolve = resolve;
  });
  const getHost = createProviderHost(
    hostOptions({
      credentials: {
        get: async () => {
          getStartedResolve();
          return new Promise<Credential | undefined>(() => {});
        },
        refresh: async () => {
          throw new Error("unexpected refresh");
        },
      },
    }),
  );
  const getController = new AbortController();
  const getNext = getHost
    .execute("p")(request(), getController.signal)
    [Symbol.asyncIterator]()
    .next();
  await getStarted;
  getController.abort("stop during get");
  await expect(raceWithin(getNext)).rejects.toBe("stop during get");

  let refreshStartedResolve!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    refreshStartedResolve = resolve;
  });
  const refreshHost = createProviderHost(
    hostOptions({
      providers: providersWith(descriptor({ auth: { type: "oauth", credentialRef: "ref" } })),
      credentials: {
        get: async () => ({
          type: "oauth",
          value: "expired",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
        refresh: async () => {
          refreshStartedResolve();
          return new Promise<Credential>(() => {});
        },
      },
    }),
  );
  const refreshController = new AbortController();
  const refreshNext = refreshHost
    .execute("p")(request(), refreshController.signal)
    [Symbol.asyncIterator]()
    .next();
  await refreshStarted;
  refreshController.abort("stop during refresh");
  await expect(raceWithin(refreshNext)).rejects.toBe("stop during refresh");
});

test("retries 429 and 5xx before accepting a stream with deterministic backoff", async () => {
  const sleeps: number[] = [];
  const bodies: Array<string | undefined> = [];
  let attempt = 0;
  const host = createProviderHost(
    hostOptions({
      maxAttempts: 3,
      retryBaseDelayMs: 250,
      sleep: async (delay) => {
        sleeps.push(delay);
      },
      fetch: async (_input, init) => {
        bodies.push(init?.body as string | undefined);
        attempt++;
        if (attempt === 1) return new Response("first-secret", { status: 429 });
        if (attempt === 2) return new Response("second-secret", { status: 503 });
        return sseResponse("ok");
      },
    }),
  );

  expect(await collect(executeFor(host))).toEqual(["ok"]);
  expect(attempt).toBe(3);
  expect(sleeps).toEqual([250, 500]);
  expect(new Set(bodies)).toEqual(new Set(['{"x":1}']));
});

test("does not retry 4xx or exhausted status responses and redacts their bodies", async () => {
  for (const status of [400, 401]) {
    let attempts = 0;
    const host = createProviderHost(
      hostOptions({
        fetch: async () => {
          attempts++;
          return new Response("secret response body", { status });
        },
      }),
    );
    const failure = await collect(executeFor(host)).catch((error) => error);
    expect(failure).toMatchObject({
      code: "provider.invalid_response",
      message: "Provider returned an invalid HTTP response",
    });
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain("secret response body");
    expect(attempts).toBe(1);
  }

  let attempts = 0;
  const sleeps: number[] = [];
  const host = createProviderHost(
    hostOptions({
      sleep: async (delay) => {
        sleeps.push(delay);
      },
      fetch: async () => {
        attempts++;
        return new Response("exhausted secret", { status: 503 });
      },
    }),
  );
  await expect(collect(executeFor(host))).rejects.toMatchObject({
    code: "provider.invalid_response",
  });
  expect(attempts).toBe(3);
  expect(sleeps).toEqual([250, 500]);
});

test("does not await never-settling status response cleanup", async () => {
  let retryCancelCalls = 0;
  let attempts = 0;
  const retrying = createProviderHost(
    hostOptions({
      maxAttempts: 2,
      sleep: async () => {},
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          const body = new ReadableStream<Uint8Array>({
            cancel() {
              retryCancelCalls++;
              return new Promise<void>(() => {});
            },
          });
          return new Response(body, { status: 429 });
        }
        return new Response("ok");
      },
    }),
  );
  await expect(raceWithin(collect(executeFor(retrying)))).resolves.toEqual(["ok"]);
  expect(retryCancelCalls).toBe(1);
  expect(attempts).toBe(2);

  let terminalCancelCalls = 0;
  const terminal = createProviderHost(
    hostOptions({
      fetch: async () => {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            terminalCancelCalls++;
            return new Promise<void>(() => {});
          },
        });
        return new Response(body, { status: 400 });
      },
    }),
  );
  await expect(raceWithin(collect(executeFor(terminal)))).rejects.toMatchObject({
    code: "provider.invalid_response",
    message: "Provider returned an invalid HTTP response",
  });
  expect(terminalCancelCalls).toBe(1);
});

test("preserves cancellation during retry backoff and does not fetch again", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const host = createProviderHost(
    hostOptions({
      fetch: async () => {
        attempts++;
        return new Response("busy", { status: 429 });
      },
      sleep: async (_delay, signal) => {
        controller.abort("stop");
        signal?.throwIfAborted();
      },
    }),
  );

  await expect(collect(executeFor(host, controller.signal))).rejects.toBe("stop");
  expect(attempts).toBe(1);
});

test("distinguishes timeout from outer cancellation and redacts fetch failures", async () => {
  vi.useFakeTimers();
  let timeoutFetches = 0;
  const timedOut = createProviderHost(
    hostOptions({
      timeoutMs: 10,
      fetch: async (_input, init) => {
        timeoutFetches++;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }),
  );
  const pending = collect(executeFor(timedOut));
  const expectation = expect(pending).rejects.toMatchObject({
    code: "provider.timeout",
    message: "Provider request timed out",
  });
  await vi.advanceTimersByTimeAsync(10);
  await expectation;
  expect(timeoutFetches).toBe(1);

  const controller = new AbortController();
  const cancelled = createProviderHost(
    hostOptions({
      fetch: async () => {
        throw new Error("Authorization: Bearer secret-key");
      },
    }),
  );
  controller.abort("stop");
  await expect(collect(executeFor(cancelled, controller.signal))).rejects.toBe("stop");

  const failed = createProviderHost(
    hostOptions({
      fetch: async () => {
        throw new Error("Authorization: Bearer secret-key");
      },
    }),
  );
  const failure = await collect(executeFor(failed)).catch((error) => error);
  expect(failure).toMatchObject({
    code: "provider.transport",
    message: "Provider transport failed",
  });
  expect(failure.cause).toBeUndefined();
  expect(JSON.stringify(failure)).not.toContain("secret-key");
});

test("redacts PiscesError messages thrown by fetch", async () => {
  const host = createProviderHost(
    hostOptions({
      fetch: async () => {
        throw new PiscesError("provider.transport", "fetch secret");
      },
    }),
  );
  const failure = await collect(executeFor(host)).catch((error) => error);
  expect(failure).toMatchObject({
    code: "provider.transport",
    message: "Provider transport failed",
    cause: undefined,
  });
  expect(JSON.stringify(failure)).not.toContain("fetch secret");
});

test("redacts PiscesError messages thrown while reading a response body", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new PiscesError("provider.transport", "body secret"));
    },
  });
  const host = createProviderHost(
    hostOptions({
      fetch: async () => new Response(stream),
    }),
  );
  const failure = await collect(executeFor(host)).catch((error) => error);
  expect(failure).toMatchObject({
    code: "provider.transport",
    message: "Provider transport failed",
    cause: undefined,
  });
  expect(JSON.stringify(failure)).not.toContain("body secret");
});

test("redacts PiscesError messages thrown during retry backoff", async () => {
  const host = createProviderHost(
    hostOptions({
      fetch: async () => new Response("busy", { status: 429 }),
      sleep: async () => {
        throw new PiscesError("provider.transport", "sleep secret");
      },
    }),
  );
  const failure = await collect(executeFor(host)).catch((error) => error);
  expect(failure).toMatchObject({
    code: "provider.transport",
    message: "Provider transport failed",
    cause: undefined,
  });
  expect(JSON.stringify(failure)).not.toContain("sleep secret");
});

test("a fetch which ignores abort cannot yield a response after cancellation", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const host = createProviderHost(
    hostOptions({
      fetch: async (_input, init) =>
        new Promise<Response>((resolve) => {
          startedResolve();
          init?.signal?.addEventListener(
            "abort",
            () =>
              resolve(
                new Response(body, {
                  headers: { "content-type": "text/event-stream" },
                }),
              ),
            { once: true },
          );
        }),
    }),
  );
  const pending = collect(executeFor(host, controller.signal));
  await started;
  controller.abort("stop");
  await expect(pending).rejects.toBe("stop");
  expect(cancelled).toBe(1);
});

test("cancellation after a yielded SSE chunk cancels a stalled response body", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        else return new Promise(() => {});
      },
      cancel() {
        cancelled++;
      },
    },
    { highWaterMark: 0 },
  );
  const host = createProviderHost(
    hostOptions({
      fetch: async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
    }),
  );
  const iterator = executeFor(host, controller.signal)[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ done: false, value: "first" });

  const next = iterator.next();
  controller.abort("stop");
  const outcome = await Promise.race([
    next.then(
      () => "value",
      (error) => error,
    ),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
  ]);

  expect(outcome).toBe("stop");
  expect(cancelled).toBe(1);
});

test("does not retry a body failure after a 2xx SSE stream has started", async () => {
  let attempts = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        else controller.error(new Error("response body secret"));
      },
    },
    {
      highWaterMark: 0,
    },
  );
  const host = createProviderHost(
    hostOptions({
      fetch: async () => {
        attempts++;
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    }),
  );
  const iterator = executeFor(host)[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ done: false, value: "first" });
  const failure = await iterator.next().catch((error) => error);
  expect(failure).toMatchObject({
    code: "provider.transport",
    message: "Provider transport failed",
  });
  expect(JSON.stringify(failure)).not.toContain("response body secret");
  expect(attempts).toBe(1);
});

test("frames SSE content types with parameters and yields non-SSE bodies once", async () => {
  const sseHost = createProviderHost(
    hostOptions({
      fetch: async () =>
        new Response("data: first\n\ndata: second\n\n", {
          headers: { "Content-Type": "Text/Event-Stream; charset=utf-8" },
        }),
    }),
  );
  expect(await collect(executeFor(sseHost))).toEqual(["first", "second"]);

  const plainHost = createProviderHost(
    hostOptions({
      fetch: async () =>
        new Response('{"business":true}', {
          headers: { "content-type": "application/json" },
        }),
    }),
  );
  expect(await collect(executeFor(plainHost))).toEqual(['{"business":true}']);
});

test("consumer early exit cancels the response body", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
    cancel() {
      cancelled++;
    },
  });
  const host = createProviderHost(
    hostOptions({
      fetch: async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
    }),
  );
  const iterator = executeFor(host)[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ done: false, value: "first" });
  await iterator.return?.();
  expect(cancelled).toBe(1);
});

test("passes 2xx provider business errors unchanged to the adapter and keeps adapter errors safe", async () => {
  const body = '{"error":{"message":"secret-provider-detail"}}';
  const adapter = createOpenAiChatAdapter();
  const wire = adapter.buildRequest({
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  const host = createProviderHost(
    hostOptions({
      providers: providersWith(descriptor({ dialect: "openai-chat" })),
      fetch: async () =>
        new Response(body, {
          headers: { "content-type": "application/json" },
        }),
    }),
  );

  const [chunk] = await collect(executeFor(host, undefined, wire));
  expect(chunk).toBe(body);
  if (chunk === undefined) throw new Error("Missing provider chunk");
  expect(() => adapter.parseChunk(chunk)).toThrowError(
    expect.objectContaining({
      code: "provider.invalid_response",
      message: "Provider returned an invalid response",
    }),
  );
  try {
    adapter.parseChunk(chunk);
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain("secret-provider-detail");
  }
});

test("parses a provider SSE stream through the adapter boundary", async () => {
  const adapter = createOpenAiChatAdapter();
  const wire = adapter.buildRequest({
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  const host = createProviderHost(
    hostOptions({
      providers: providersWith(descriptor({ dialect: "openai-chat" })),
      fetch: async () =>
        sseResponse(
          JSON.stringify({
            choices: [{ delta: { content: "hello" }, finish_reason: null }],
          }),
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
          }),
          "[DONE]",
        ),
    }),
  );
  const events: LlmEvent[] = [];
  for await (const chunk of executeFor(host, undefined, wire))
    events.push(...adapter.parseChunk(chunk));

  expect(events).toEqual([
    { type: "content", delta: "hello" },
    { type: "stop", reason: "stop" },
  ]);
});

test("rejects unsafe options, URLs, headers, and unknown providers safely", async () => {
  expect(() => createProviderHost(hostOptions({ timeoutMs: 0 }))).toThrow(TypeError);
  expect(() => createProviderHost(hostOptions({ maxAttempts: 0 }))).toThrow(TypeError);
  expect(() => createProviderHost(hostOptions({ retryBaseDelayMs: -1 }))).toThrow(TypeError);

  const unknown = createProviderHost(hostOptions({ providers: createProviderManagement() }));
  await expect(collect(executeFor(unknown))).rejects.toMatchObject({
    code: "config.invalid",
  });

  let unsafeUrlFetches = 0;
  const badUrl = createProviderHost(
    hostOptions({
      fetch: async () => {
        unsafeUrlFetches++;
        return new Response("unexpected");
      },
    }),
  );
  for (const path of ["https://evil.test/steal", "/../chat", "/%2e%2e/chat", "/%252e%252e/chat"]) {
    await expect(collect(executeFor(badUrl, undefined, request({ path })))).rejects.toMatchObject({
      code: "provider.invalid_response",
      message: "Provider request URL is invalid",
    });
  }
  expect(unsafeUrlFetches).toBe(0);

  const badHeaders = createProviderHost(hostOptions());
  await expect(
    collect(executeFor(badHeaders, undefined, request({ headers: { "bad\nheader": "secret" } }))),
  ).rejects.toMatchObject({
    code: "provider.invalid_response",
  });

  const failedCredential = createProviderHost(
    hostOptions({
      credentials: credentialsWith({
        ref: { type: "apiKey", value: "expired", expiresAt: "2020-01-01T00:00:00.000Z" },
      }).credentials,
    }),
  );
  await expect(collect(executeFor(failedCredential))).rejects.toMatchObject({
    code: "provider.transport",
    message: "Provider credential is unavailable",
  });
});

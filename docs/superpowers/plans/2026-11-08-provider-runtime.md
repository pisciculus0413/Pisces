# Provider Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the provider catalog, the first concrete LLM dialect, and the daemon HTTP execution host needed to feed real provider streams into the existing `AgentLoopDriver`.

**Architecture:** Core owns provider-neutral descriptor contracts, deterministic provider/model lookup, adapter factories, and an OpenAI-compatible Chat Completions dialect. Daemon owns credential injection, URL composition, HTTP, SSE framing, timeouts, retries, and transport error normalization. Tests inject fetch, credential, time, sleep, and signal dependencies; no test performs a network request.

**Tech Stack:** TypeScript, Node >=22.19.0, ESM, pnpm 12.8.1, native `fetch`/`ReadableStream`, Vitest; no new dependencies.

**Spec:** `docs/1 High-Level Design/1 High-Level Design.md` §3.1, §4.1–4.2, §5.2.4, §6.2, §8.1–8.5; `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` §2.2, §3.1, §3.6, §3.9, §4.4.1, §5.1.1, §5.6, §8.2–8.4; `docs/2 Detailed Design Specification/P0 Decision Table.md` P0-01, P0-12.

## Global Constraints

- Work on `dev-codex`; never commit to `main`, push, or merge.
- Baseline is commit `4096cc1`; the worktree is clean and the existing suite has 22 files / 414 passing tests.
- Core must not import protocol, daemon, Node filesystem, or Node networking modules.
- The existing `LlmAdapter`, `ExecuteProvider`, `WireRequest`, `LlmRequest`, `ToolCall`, `EntryName`, and `AgentLoopDriver` contracts remain wire-compatible. Do not change the driver to understand HTTP.
- A provider async iterator that has not reached `done` must receive `return()` before the driver leaves a step on parse, event-publication, cancellation, or other failure. Cleanup failure must not replace the original turn failure.
- `source="instruction"` messages are ordinary `role="system"` messages. Every system message in `LlmRequest.messages` is serialized in order; no latest-only or other instruction filtering is allowed.
- `ToolCall.name` in records remains `EntryName`. The adapter alone encodes request tool names and decodes response tool names.
- The default wire-name scheme remains `encodeWireName`. The first concrete dialect enforces a provider limit of 64 ASCII characters before sending.
- Chat Completions does not send stored reasoning items back in the request. Incoming compatible response fields may still become `LlmEvent.reasoning`.
- All provider generation and streaming use the existing `LlmAdapter` and `ExecuteProvider`; no CLI, Gateway, Extensions loader, or persistence integration is added here.
- Retry policy defaults to exactly three total attempts and deterministic exponential delays of `retryBaseDelayMs * 2^(attempt-1)`, therefore 250ms then 500ms by default. Only HTTP 429 and 5xx responses are retried. Other HTTP statuses are not retried, cancellation is not retried, and once a successful response has yielded any byte or started streaming there is no retry.
- Each request attempt has a 60-second timeout by default. Timeout, network, HTTP-status, abort, and credential failures use fixed safe messages and never include credentials, authorization headers, descriptor headers, response bodies, or raw fetch errors.
- Do not implement `Concurrency`, the concrete `EventBus`, `Gateway`, daemon turn registration, `active-turn.json`, crash recovery, `Extensions`, a concrete `CredentialStore`, protocol methods, or CLI in this plan.
- Use TDD. Every production behavior starts with a test that is run and observed to fail for the expected missing behavior.
- Before every commit run `git status --short`; stage only the exact files changed by that task.

## Review Focus

- A provider/model lookup, adapter factory invocation, or descriptor mutation must not leak mutable caller state; selection is deterministic, duplicate provider/model/dialect identifiers are rejected, and readiness never exposes raw credential failures. Tasks 1 and 4 cover this.
- System messages can occur more than once and at any valid position; every one appears in the serialized request. Stored reasoning is omitted from Chat Completions requests, split tool-call deltas are reconstructed once per step, and the `choices:[]` usage chunk is accepted. Task 2 covers these.
- UTF-8 code points, CRLF, multiple `data:` lines, comments, and an event ending at EOF must survive arbitrary byte boundaries; no partial SSE event is delivered. Task 3 covers this.
- A 429/5xx may be retried only before a response body is accepted, while a body failure after a 2xx stream starts must fail immediately; cancellation and timeout must remain distinguishable. Task 4 covers this.
- A parser, event publisher, or abort failure after a provider chunk must close the provider iterator exactly once; a normal `done` result must not be redundantly closed. Task 0 covers this.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/loop/driver.ts` | Close an unfinished provider iterator before leaving the step | 0 |
| `packages/core/src/providers/types.ts` | Provider, model, credential, selection, adapter-factory, and management contracts | 1 |
| `packages/core/src/providers/management.ts` | Immutable provider registration, deterministic lookup/list, dialect registration, per-call adapter creation | 1 |
| `packages/core/src/providers/openai-chat.ts` | OpenAI-compatible Chat Completions request builder and stateful SSE-chunk parser | 2 |
| `packages/core/src/index.ts` | Export provider contracts, management factory, dialect key, adapter factory, and built-in dialect factory | 1–2 |
| `packages/daemon/src/provider/sse.ts` | Incremental SSE data-event framing over `ReadableStream<Uint8Array>` | 3 |
| `packages/daemon/src/provider/provider-host.ts` | Credential resolution, HTTP execution, timeout/retry, content-type handling, error redaction | 4 |
| `packages/daemon/src/index.ts` | Export `ProviderHost` and its factory | 4 |
| `packages/core/test/loop-provider-lifecycle.test.ts` | Driver iterator cleanup on parser/publication/cancel failures | 0 |
| `packages/core/test/providers-management.test.ts` | Descriptor validation, cloning, deterministic selection, dialect lifecycle | 1 |
| `packages/core/test/providers-openai-chat.test.ts` | Request mapping, no instruction filtering, tool-codec limits, streamed response parsing | 2 |
| `packages/daemon/test/provider-sse.test.ts` | Arbitrary byte-boundary SSE framing and EOF behavior | 3 |
| `packages/daemon/test/provider-host.test.ts` | Credential/header injection, ready, URL, retries, timeout, abort, redaction | 4 |
| `docs/1 High-Level Design/1 High-Level Design.md` | Synchronize credential reference semantics | 5 |
| `docs/2 Detailed Design Specification/2 Detailed Design Specification.md` | Synchronize driver options and provider-runtime decisions | 5 |

## Fixed Interface Decisions

```ts
// packages/core/src/providers/types.ts
import type { LlmAdapter } from "../loop/types.js";

export interface ModelDescriptor {
  id: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
  pricing?: { input: number; output: number; currency: string };
}

export interface ProviderDescriptor {
  id: string;
  dialect: string;
  baseUrl: string;
  auth: { type: "apiKey" | "oauth"; credentialRef: string };
  headers?: Record<string, string>;
  models: ModelDescriptor[];
}

export interface Credential {
  type: "apiKey" | "oauth";
  value: string;
  expiresAt?: string;
}

export interface Credentials {
  get(credentialRef: string): Promise<Credential | undefined>;
  refresh(credentialRef: string): Promise<Credential>;
}

export interface ProviderSelection {
  provider: ProviderDescriptor;
  model: ModelDescriptor;
}

export type LlmAdapterFactory = (descriptor: ProviderDescriptor) => LlmAdapter;

export interface ProviderManagement {
  registerProvider(descriptor: ProviderDescriptor): void;
  registerDialect(name: string, factory: LlmAdapterFactory): void;
  get(providerId: string): ProviderDescriptor | undefined;
  select(providerId: string, modelId: string): ProviderSelection | undefined;
  createAdapter(providerId: string): LlmAdapter;
  list(): ProviderDescriptor[];
}

export function createProviderManagement(): ProviderManagement;
```

- Registration validates non-empty provider/dialect/credential identifiers, non-empty model identifiers when models are present, pricing currency, unique model IDs inside one provider, finite positive context/output limits, known or empty modalities, a non-negative finite pricing pair, header names/values without CR/LF, and an absolute HTTP(S) `baseUrl` without URL credentials, query, or fragment. An empty `models` array is valid and represents a provider with no selectable model. Failures are `PiscesError("config.invalid", "Invalid provider configuration")`; messages do not include the descriptor or auth reference.
- Duplicate provider IDs and duplicate dialect names are rejected with the same stable code and message. Registering an adapter dialect later is allowed. Unknown dialect at `createAdapter` is `config.invalid`.
- `get`, `select`, and `list` return structured clones. `list` sorts providers and models by UTF-16 code-unit ID order; `select` returns `undefined` for either a missing provider or missing model.
- `createAdapter` reads the current descriptor, requires its dialect, and invokes the registered factory on every call. It returns a fresh adapter so concurrent turns do not share parser state. The factory receives a clone and cannot mutate the catalog.

```ts
// packages/core/src/providers/openai-chat.ts
export const OPENAI_CHAT_DIALECT = "openai-chat";

export interface OpenAiChatAdapterOptions {
  path?: string;                 // default "/chat/completions"
  maxToolNameLength?: number;    // default 64
}

export function createOpenAiChatAdapter(options?: OpenAiChatAdapterOptions): LlmAdapter;
export const openAiChatAdapterFactory: LlmAdapterFactory;
```

- Request bodies are JSON for OpenAI-compatible Chat Completions. `path` must be an absolute path beginning with `/`, without scheme or authority. The adapter sets no credential headers or base URL; `ProviderHost` supplies those.
- `model`, `messages`, `tools`, `stream`, `n`, `functions`, and `function_call` are reserved keys and are removed from `request.parameters` before provider-specific fields are spread. The adapter always produces one choice, assigns `model` and `messages`, assigns `tools` only when the core request has declarations, and assigns `stream: true`; extension parameters cannot replace or inject these fields or select the unsupported legacy function-call mode.
- Requests default to `stream_options: {include_usage:true}`. If `request.parameters.stream_options` is an object, its fields are merged over that default so the provider-specific request can explicitly override usage behavior without changing the core fields.
- This first dialect accepts text output only. A `parameters.modalities` value containing anything other than `"text"`, or a response `delta.audio`, is rejected as an invalid response instead of being silently discarded.
- `openAiChatAdapterFactory` ignores the descriptor and returns `createOpenAiChatAdapter()`. It has the `LlmAdapterFactory` shape so later service assembly can register it as `OPENAI_CHAT_DIALECT` without an inline wrapper.
- `system`, `user`, and assistant `text` blocks are flattened to a string content field in source order; multiple text blocks concatenate with the empty string. All system messages are emitted, including duplicate and historical `source="instruction"` material. Stored `reasoning` blocks are omitted from Chat Completions requests, matching the stateless API rule that reasoning items are never included in model context. Each assistant tool call becomes `{id,type:"function",function:{name:encodeWireName(call.name),arguments:JSON.stringify(call.arguments)}}`, and an assistant message with no text uses `content:null`; each core `role="tool"` message expands one wire message per nested `toolResult`, with `tool_call_id` and recursively concatenated textual content. System/user content cannot contain tool calls/results, assistant content cannot contain results, tool content accepts only non-empty-id results with textual descendants, and non-JSON tool arguments fail before a request is returned.
- Tool declarations serialize as `{type:"function",function:{name:wireName,description,parameters}}`; `execute`, source, and the original `EntryName` never appear in the body. Every encoded name must be at most `maxToolNameLength`; failure is `PiscesError("provider.invalid_response", "Tool name exceeds provider limit")` before the request is returned.
- `buildRequest` resets parser state for the new step. `parseChunk` accepts either one SSE data payload or one complete non-streaming Chat Completions JSON body, ignores `[DONE]`, emits text deltas and optional `reasoning_content`/`reasoning` deltas from compatible providers, accumulates tool-call fragments by numeric index until a finish reason, decodes names with `decodeWireName`, parses argument JSON, and emits usage and exactly one stop reason. An empty `choices` array is valid for the final usage chunk and emits only usage. Empty tool arguments mean `{}`; malformed JSON/names/events fail as `PiscesError("provider.invalid_response", "Provider returned an invalid response")`.
- A complete non-streaming response reads `choices[0].message` and its final `finish_reason`; its `tool_calls` array position defines call order because complete tool calls do not carry the streaming `index`. It passes through the same content, usage, wire-name, argument, and stop validation as streamed deltas, while compatible `message.reasoning_content`/`message.reasoning` is optional.
- OpenAI finish reasons map `stop`, `tool_calls`, `length`, and `content_filter` to the existing `StopReason` values. An explicit provider refusal produces `provider.refusal` with `"Provider refused the request"`; other provider/error objects and unknown finish reasons use the invalid-response error above.

```ts
// packages/daemon/src/provider/provider-host.ts
import type {
  Credentials,
  ExecuteProvider,
  ProviderManagement,
} from "@pisces/core";

export interface ProviderHost {
  execute(providerId: string): ExecuteProvider;
  ready(providerId: string): Promise<boolean>;
}

export interface ProviderHostOptions {
  providers: ProviderManagement;
  credentials: Credentials;
  fetch?: typeof fetch;
  timeoutMs?: number;             // default 60_000
  maxAttempts?: number;           // default 3
  retryBaseDelayMs?: number;      // default 250
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export function createProviderHost(options: ProviderHostOptions): ProviderHost;
```

- Unknown providers fail when the returned iterable is consumed with `PiscesError("config.invalid", "Invalid provider configuration")`. `ready(providerId)` is true exactly when the provider exists, has at least one model, and `Credentials.get(auth.credentialRef)` returns a matching, non-expired credential without throwing. It does not refresh OAuth or make network calls.
- Execution obtains the descriptor at iterable start. A missing/wrong/expired API-key credential fails as `PiscesError("provider.transport", "Provider credential is unavailable")`. Expired OAuth credentials are refreshed before the request. A missing credential may be refreshed only when its declared auth type is OAuth. Refresh failures use the same safe credential error.
- Descriptor headers are copied first, then `WireRequest.headers` overrides them. `content-type: application/json` is defaulted when absent; authorization is assigned last as `Bearer <credential.value>` and cannot be overridden. Request bodies are reused byte-for-byte across attempts.
- `baseUrl` and `WireRequest.path` are joined without dropping a base path such as `/v1`; absolute wire paths and cross-origin results are rejected as `PiscesError("provider.invalid_response", "Provider request URL is invalid")`.
- A 429 or 5xx consumes/cancels any response body and retries only while attempts remain. Exhaustion and every other non-2xx status throw `PiscesError("provider.invalid_response", "Provider returned an invalid HTTP response")`, which contains no body/header/status detail. The Host handles HTTP status and transport only. Every 2xx response body is handed unchanged to the adapter, including a top-level provider business error or refusal payload; the Host must not parse or reinterpret that payload. Network/fetch/body-read failures throw `provider.transport` with the fixed message `Provider transport failed`. Attempt timeout throws `provider.timeout` with `Provider request timed out`. An outer abort preserves its original reason and is never converted or retried. Before consuming any successful response, the host rechecks the outer and attempt signals so a fetch that ignores abort cannot still yield data.
- A response whose media type is `text/event-stream` after case-insensitive MIME parsing is incrementally framed by `sse.ts`, including parameters such as `charset=utf-8`; other successful responses are read whole and yielded as one string. Once a successful response is returned, any later body failure is final and never retried.
- Normalized provider errors do not retain the raw fetch, body, header, or credential exception as `cause`; only fixed code and message values leave the host.
- Default `sleep` resolves after a signal-aware timer; tests inject an immediate recording sleep. Invalid option values fail with `TypeError` at factory creation.

---

### Task 0: Close interrupted provider iterators

**Files:**
- Modify: `packages/core/src/loop/driver.ts`
- Test: `packages/core/test/loop-provider-lifecycle.test.ts`

**Interfaces:**
- Consumes: existing `AgentLoopDriver`, `RunTurnInput`, `LlmAdapter`, and `ExecuteProvider`.
- Produces: no signature change. Preserves all existing turn results and error codes while guaranteeing provider iterator cleanup.

- [ ] **Step 1: Write a parser-failure cleanup test.**

Reuse the existing loop test harness with an `ExecuteProvider` that yields one chunk and records a `finally` cleanup:

```ts
let closed = 0;
const execute: ExecuteProvider = async function* () {
  try {
    yield "frame";
    await new Promise(() => {});
  } finally {
    closed++;
  }
};
const adapter: LlmAdapter = {
  dialect: "failing",
  buildRequest: () => ({ path: "/", body: "" }),
  parseChunk: () => {
    throw new PiscesError("provider.invalid_response", "Provider returned an invalid response");
  },
};

const result = await driver.run(runInput({ adapter, execute }));
expect(result).toMatchObject({
  reason: "failed",
  error: { code: "provider.invalid_response" },
});
expect(closed).toBe(1);
```

Also cover a `turn.delta` publication failure and cancellation after the first chunk. Each must return the existing terminal reason/code and close once.

- [ ] **Step 2: Run the red cleanup tests.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-provider-lifecycle.test.ts`

Expected: FAIL because the current manual iterator loop never calls `return()` on failure.

- [ ] **Step 3: Implement iterator cleanup without changing the error.**

Track whether `iterator.next()` returned `done`. Wrap chunk consumption in `try/finally`; when not done and `iterator.return` exists, await it in the `finally`. Ignore cleanup failure so parse, abort, storage, or publication failure remains terminal.

- [ ] **Step 4: Add normal-completion and cleanup-failure tests.**

Assert a natural `done` result does not receive an extra `return()`, and an `iterator.return()` rejection does not replace an already observed invalid-response error. A successful completed turn must remain `reason:"completed"` with its prior committed nodes unchanged.

- [ ] **Step 5: Verify green and commit.**

Run: `node_modules/.bin/vitest run packages/core/test/loop-provider-lifecycle.test.ts packages/core/test/loop-failures.test.ts packages/core/test/loop-control.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/loop/driver.ts packages/core/test/loop-provider-lifecycle.test.ts`

Expected: all commands exit 0.

```bash
git status --short
git add packages/core/src/loop/driver.ts packages/core/test/loop-provider-lifecycle.test.ts
git commit -m "fix(core): close interrupted provider streams"
```

### Task 1: Provider contracts and deterministic management

**Files:**
- Create: `packages/core/src/providers/types.ts`
- Create: `packages/core/src/providers/management.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/providers-management.test.ts`

**Interfaces:**
- Consumes: `LlmAdapter`, `PiscesError`, and existing core type conventions.
- Produces: every type and factory declared in the core “Fixed Interface Decisions” block above.

- [ ] **Step 1: Write descriptor-validation failing tests.**

```ts
test("rejects duplicate provider ids and duplicate model ids with a safe config error", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor());
  expect(() => providers.registerProvider(descriptor())).toThrowError(
    expect.objectContaining({ code: "config.invalid", message: "Invalid provider configuration" }),
  );
  expect(() =>
    createProviderManagement().registerProvider(
      descriptor({ models: [model("m"), model("m")] }),
    ),
  ).toThrowError(expect.objectContaining({ code: "config.invalid" }));
});
```

Also cover empty IDs, non-HTTP or credential-bearing base URLs, CR/LF header injection, zero/NaN limits, duplicate modalities, negative pricing, an empty currency, and a credential reference appearing nowhere in a thrown message.

```ts
test("registers a provider with no models", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor({ id: "empty", models: [] }));
  expect(providers.list()).toEqual([
    expect.objectContaining({ id: "empty", models: [] }),
  ]);
  expect(providers.select("empty", "missing")).toBeUndefined();
});
```

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-management.test.ts`

Expected: FAIL because the provider modules do not exist.

- [ ] **Step 3: Implement immutable descriptor registration and validation.**

Store private structured clones. Validate before any mutation, then replace the map entry only after the complete descriptor is valid. Keep configuration errors fixed and safe.

- [ ] **Step 4: Write lookup, cloning, and determinism failing tests.**

```ts
test("selects models deterministically and isolates all descriptor state", () => {
  const providers = createProviderManagement();
  const input = descriptor({ id: "z", models: [model("y"), model("x")] });
  providers.registerProvider(input);
  (input.headers as Record<string, string>).authorization = "secret";
  input.models[0]!.id = "mutated";

  expect(providers.select("z", "x")?.model.id).toBe("x");
  expect(providers.list().map((item) => item.id)).toEqual(["z"]);
  expect(providers.list()[0]!.models.map((item) => item.id)).toEqual(["x", "y"]);
  expect(providers.select("z", "missing")).toBeUndefined();
  const leaked = providers.get("z")!;
  leaked.models[0]!.id = "changed";
  expect(providers.get("z")!.models.map((item) => item.id)).toEqual(["x", "y"]);
});
```

- [ ] **Step 5: Run the red lookup test.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-management.test.ts`

Expected: FAIL because `select`, sorted listing, or clone behavior is incomplete.

- [ ] **Step 6: Implement `get`, `select`, and sorted `list`.**

- [ ] **Step 7: Write dialect-lifecycle failing tests.**

```ts
test("creates a fresh adapter for every request without exposing descriptor mutation", () => {
  const providers = createProviderManagement();
  providers.registerProvider(descriptor({ dialect: "d" }));
  const seen: ProviderDescriptor[] = [];
  providers.registerDialect("d", (value) => {
    seen.push(value);
    return fakeAdapter();
  });
  const first = providers.createAdapter("p");
  const second = providers.createAdapter("p");
  expect(first).not.toBe(second);
  expect(seen).toHaveLength(2);
  seen[0]!.models.length = 0;
  expect(providers.select("p", "m")).toBeDefined();
});
```

Also assert duplicate dialect registration, unknown provider, missing dialect, and a throwing factory map to `config.invalid` without retaining or leaking its raw cause.

- [ ] **Step 8: Run the red lifecycle test.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-management.test.ts`

Expected: FAIL because dialect registration or per-call creation is missing.

- [ ] **Step 9: Implement dialect registration and `createAdapter`.**

- [ ] **Step 10: Export the new core API and verify green.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-management.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/providers packages/core/src/index.ts packages/core/test/providers-management.test.ts`

Expected: all commands exit 0.

- [ ] **Step 11: Commit.**

```bash
git status --short
git add packages/core/src/providers/types.ts packages/core/src/providers/management.ts packages/core/src/index.ts packages/core/test/providers-management.test.ts
git commit -m "feat(core): add provider management"
```

### Task 2: OpenAI-compatible Chat Completions adapter

**Files:**
- Create: `packages/core/src/providers/openai-chat.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/providers-openai-chat.test.ts`

**Interfaces:**
- Consumes: Task 1 provider contracts; `LlmRequest`, `LlmAdapter`, `LlmEvent`, `EntryName`, `ToolCall`, `encodeWireName`, `decodeWireName`, and `PiscesError`.
- Produces: `OPENAI_CHAT_DIALECT`, `OpenAiChatAdapterOptions`, `createOpenAiChatAdapter`, and `openAiChatAdapterFactory`.

- [ ] **Step 1: Write request-mapping failing tests.**

```ts
test("serializes every system message in order without instruction filtering", () => {
  const adapter = createOpenAiChatAdapter();
  const wire = adapter.buildRequest({
    model: "m",
    messages: [
      message("system", "initial"),
      message("user", "hello"),
      message("system", "new instruction"),
      message("system", "second instruction"),
    ],
  });
  expect(JSON.parse(wire.body).messages).toEqual([
    { role: "system", content: "initial" },
    { role: "user", content: "hello" },
    { role: "system", content: "new instruction" },
    { role: "system", content: "second instruction" },
  ]);
});
```

Add a tool/assistant/tool-result request assertion covering encoded function names, detached parameters, absent `reasoning_content`, `tool_calls`, one wire tool message per `toolResult`, `stream_options.include_usage=true`, and concatenation of multiple text blocks. Also pass every reserved key through `parameters` and assert they cannot replace core fields, inject `tools`, request multiple choices, or select legacy functions. Reject non-text `modalities`.

- [ ] **Step 2: Run the red request test.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-openai-chat.test.ts`

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement request construction and codec limits.**

Use path `/chat/completions` by default, return stable Pisces errors for invalid options/request shapes, and enforce the configured maximum before returning a `WireRequest`.

- [ ] **Step 4: Add tool-name-limit and option failing tests.**

```ts
test("rejects an over-limit wire name before any request can be sent", () => {
  const adapter = createOpenAiChatAdapter({ maxToolNameLength: 8 });
  expect(() =>
    adapter.buildRequest({
      model: "m",
      messages: [message("user", "go")],
      tools: [{ name: "pkg#echo" as EntryName, description: "echo", parameters: {} }],
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "provider.invalid_response",
      message: "Tool name exceeds provider limit",
    }),
  );
});
```

Also reject an invalid path, non-positive limit, malformed tool parameters, unsupported block placement, and a tool-result/tool-call pairing that cannot form a valid wire message.

- [ ] **Step 5: Run the red limit test.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-openai-chat.test.ts`

Expected: FAIL until option validation and over-limit detection are implemented.

- [ ] **Step 6: Complete safe option and request-shape validation.**

- [ ] **Step 7: Write response-parser failing tests.**

```ts
test("reconstructs split tool calls, decodes names, and resets between steps", () => {
  const adapter = createOpenAiChatAdapter();
  const wireName = encodeWireName("pkg#echo" as EntryName);
  adapter.buildRequest({ model: "m", messages: [message("user", "first")] });
  expect(adapter.parseChunk(JSON.stringify(choice({
    delta: { tool_calls: [{
      index: 0,
      id: "call_1",
      function: { name: wireName.slice(0, 5), arguments: "{\"text\":" },
    }] },
  })))).toEqual([]);
  expect(adapter.parseChunk(JSON.stringify(choice({
    delta: { tool_calls: [{
      index: 0,
      function: { name: wireName.slice(5), arguments: "\"ok\"}" },
    }] },
    finish_reason: "tool_calls",
  })))).toEqual([
    {
      type: "toolCall",
      call: { id: "call_1", name: "pkg#echo", arguments: { text: "ok" } },
    },
    { type: "stop", reason: "toolCall" },
  ]);
  adapter.buildRequest({ model: "m", messages: [message("user", "second")] });
  expect(adapter.parseChunk("[DONE]")).toEqual([]);
});
```

Add content, reasoning response fields, usage, finish-reason, `[DONE]`, malformed JSON, invalid wire name, invalid argument JSON, audio delta, refusal/error, and duplicate-stop behavior. Add a final usage frame with `choices:[]` and assert it emits usage without invalid-response failure.
Also assert `openAiChatAdapterFactory` can be registered directly under `OPENAI_CHAT_DIALECT` and returns independent adapters.
Add a complete non-streaming Chat Completions response and assert it produces the same content, tool-call, usage, and stop events as the streamed form.

- [ ] **Step 8: Run the red parser test.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-openai-chat.test.ts`

Expected: FAIL because response parsing is not implemented.

- [ ] **Step 9: Implement the stateful per-step parser and safe response errors.**

- [ ] **Step 10: Verify green and commit.**

Run: `node_modules/.bin/vitest run packages/core/test/providers-openai-chat.test.ts packages/core/test/providers-management.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/core/src/providers packages/core/src/index.ts packages/core/test/providers-openai-chat.test.ts`

Expected: all commands exit 0.

```bash
git status --short
git add packages/core/src/providers/openai-chat.ts packages/core/src/index.ts packages/core/test/providers-openai-chat.test.ts
git commit -m "feat(core): add OpenAI-compatible chat dialect"
```

### Task 3: Incremental SSE framing

**Files:**
- Create: `packages/daemon/src/provider/sse.ts`
- Test: `packages/daemon/test/provider-sse.test.ts`

**Interfaces:**
- Produces: `parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string>`, module-local until Task 4 consumes it.

- [ ] **Step 1: Write arbitrary-boundary failing tests.**

```ts
test("frames UTF-8 and CRLF data across arbitrary chunk boundaries", async () => {
  const bytes = new TextEncoder().encode(
    ": comment\r\ndata: first\r\ndata: 中文🐟\r\n\r\n" +
      "event: message\rdata: {\"x\":1}\r\r",
  );
  const stream = streamOf([bytes.slice(0, 1), bytes.slice(1, 7), bytes.slice(7, 31), bytes.slice(31)]);
  expect(await collect(parseSseStream(stream))).toEqual([
    "first\n中文🐟",
    "{\"x\":1}",
  ]);
});
```

Add LF-only input, a multibyte code point split into byte chunks, ignored comments/fields, empty data events, multiple blank lines, dispatch at EOF without a final blank line, and stream-error propagation.

- [ ] **Step 2: Run the red test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/provider-sse.test.ts`

Expected: FAIL because `parseSseStream` does not exist.

- [ ] **Step 3: Implement incremental decoding and SSE event assembly.**

Use one streaming `TextDecoder`, preserve a line buffer, remove only one optional space after `data:`, join multiple data fields with `\n`, dispatch on a blank line, and dispatch a final non-empty event at EOF.

- [ ] **Step 4: Verify green and commit.**

Run: `node_modules/.bin/vitest run packages/daemon/test/provider-sse.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/biome check packages/daemon/src/provider/sse.ts packages/daemon/test/provider-sse.test.ts`

Expected: all commands exit 0.

```bash
git status --short
git add packages/daemon/src/provider/sse.ts packages/daemon/test/provider-sse.test.ts
git commit -m "feat(daemon): frame provider SSE responses"
```

### Task 4: ProviderHost HTTP execution

**Files:**
- Create: `packages/daemon/src/provider/provider-host.ts`
- Modify: `packages/daemon/src/index.ts`
- Test: `packages/daemon/test/provider-host.test.ts`

**Interfaces:**
- Consumes: Task 1 provider/credential contracts and Task 3 `parseSseStream`; core `ExecuteProvider`, `WireRequest`, `PiscesError`.
- Produces: `ProviderHost`, `ProviderHostOptions`, and `createProviderHost`.

- [ ] **Step 1: Write credential, header, URL, and `ready` failing tests.**

```ts
test("injects ordered safe headers, preserves base paths, and reports readiness", async () => {
  const calls: RequestInit[] = [];
  const host = createProviderHost({
    providers,
    credentials: credentialsWith({
      ref: { type: "apiKey", value: "secret-key" },
    }),
    fetch: async (input, init) => {
      expect(String(input)).toBe("https://example.test/v1/chat/completions");
      calls.push(init!);
      return new Response("data: ok\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  expect(await host.ready("p")).toBe(true);
  expect(await collect(host.execute("p")(
    { path: "/chat/completions", body: "{\"x\":1}", headers: { "x-tier": "adapter" } },
  ))).toEqual(["ok"]);
  expect(new Headers(calls[0]!.headers).get("authorization")).toBe("Bearer secret-key");
  expect(new Headers(calls[0]!.headers).get("x-tier")).toBe("adapter");
  expect(new Headers(calls[0]!.headers).get("content-type")).toBe("application/json");
});
```

Also assert missing/non-matching/expired credentials make `ready` false; OAuth refresh; fresh OAuth no refresh; descriptor mutation after host creation is isolated; unknown providers are async failures.

Also register an otherwise ready provider with `models: []` and assert `host.ready(providerId)` is false.

Add a header precedence regression: descriptor headers use `x-tier: descriptor`, adapter headers use `X-Tier: adapter`, and the request sent to fetch contains only `adapter` when inspected through case-insensitive `Headers`. Repeat the same case-insensitive rule for an attempted `AUTHORIZATION` override and assert the Host-injected bearer token wins.

- [ ] **Step 2: Run the red credential test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/provider-host.test.ts`

Expected: FAIL because the host module does not exist.

- [ ] **Step 3: Implement option validation, descriptor lookup, credential resolution, URL composition, header merging, and `ready`.**

- [ ] **Step 4: Write retry and status failing tests.**

```ts
test("retries 429 and 5xx before streaming, then stops after success", async () => {
  const sleeps: number[] = [];
  let attempt = 0;
  const host = hostWithFetch(async () => {
    attempt++;
    if (attempt === 1) return new Response("busy", { status: 429 });
    if (attempt === 2) return new Response("down", { status: 503 });
    return new Response("data: ok\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }, {
    sleep: async (delay) => { sleeps.push(delay); },
  });
  expect(await collect(executeFor(host, "p"))).toEqual(["ok"]);
  expect(attempt).toBe(3);
  expect(sleeps).toEqual([250, 500]);
});
```

Add separate tests for 400/401 (one attempt), exhausted 429/503, a successful first attempt, cancellation during retry backoff (no next fetch), and a response body that errors after yielding SSE data must not retry.

- [ ] **Step 5: Run the red retry test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/provider-host.test.ts`

Expected: FAIL because retries/status handling are incomplete.

- [ ] **Step 6: Implement pre-stream status retry and post-stream terminal handling.**

Cancel retry response bodies, use injected signal-aware sleep, and never re-enter fetch after a successful response stream has begun.

- [ ] **Step 7: Write timeout, abort, non-SSE, and redaction failing tests.**

```ts
test("distinguishes timeout from cancellation and never exposes fetch secrets", async () => {
  vi.useFakeTimers();
  const timedOut = createProviderHost({
    providers,
    credentials,
    timeoutMs: 10,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  const iteration = consumeFailure(timedOut, "p");
  await vi.advanceTimersByTimeAsync(10);
  await expect(iteration).rejects.toMatchObject({
    code: "provider.timeout",
    message: "Provider request timed out",
  });

  const controller = new AbortController();
  const sensitive = new Error("Authorization: Bearer secret-key");
  const cancelled = createProviderHost({
    providers,
    credentials,
    fetch: async () => { throw sensitive; },
  });
  controller.abort("stop");
  await expect(collect(cancelled.execute("p")(request(), controller.signal)))
    .rejects.toBe("stop");

  const failed = createProviderHost({
    providers,
    credentials,
    fetch: async () => { throw sensitive; },
  });
  const failure = await collect(failed.execute("p")(request())).catch((error) => error);
  expect(failure).toMatchObject({
    code: "provider.transport",
    message: "Provider transport failed",
  });
  expect(failure.cause).toBeUndefined();
  expect(JSON.stringify(failure)).not.toContain("secret-key");
});
```

Also assert non-SSE 2xx text is yielded once, a fake fetch that resolves after abort yields nothing, response/header credentials never appear in errors, invalid HTTP response bodies are not exposed, invalid options throw `TypeError`, and consumer early-exit cancels the reader.
Assert `Content-Type: text/event-stream; charset=utf-8` is framed as SSE rather than read as one non-SSE body.
Register `afterEach(() => vi.useRealTimers())` with the test fixture so fake time never leaks into another test.

- [ ] **Step 8: Run the red terminal test.**

Run: `node_modules/.bin/vitest run packages/daemon/test/provider-host.test.ts`

Expected: FAIL until timeout, abort, non-SSE, cleanup, and redaction are implemented.

- [ ] **Step 9: Implement the final execution path and safe error normalization.**

Use a per-attempt abort controller linked to the outer signal, clear all listeners/timers in `finally`, normalize only non-Pisces transport failures, and preserve the outer signal reason.

- [ ] **Step 10: Add an adapter/host boundary integration test.**

Use `createOpenAiChatAdapter()` to build a Chat Completions request, a fake fetch to return two real SSE data frames for text plus stop, and `collect` over `host.execute(providerId)(wire)`. Pass each host chunk to `adapter.parseChunk` and assert:

```ts
expect(events).toEqual([
  { type: "content", delta: "hello" },
  { type: "stop", reason: "stop" },
]);
```

Add a second integration case where a 2xx `application/json` response body is
`{"error":{"message":"secret-provider-detail"}}`. Assert the Host yields the
body unchanged and the adapter maps it to `provider.invalid_response`; the
adapter's safe error must not contain the provider detail.

- [ ] **Step 11: Export the daemon API and verify green.**

Run: `node_modules/.bin/vitest run packages/daemon/test/provider-sse.test.ts packages/daemon/test/provider-host.test.ts`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/tsc -b tsconfig.build.json`

Run: `node_modules/.bin/biome check packages/daemon/src/provider packages/daemon/src/index.ts packages/daemon/test/provider-sse.test.ts packages/daemon/test/provider-host.test.ts`

Expected: all commands exit 0.

- [ ] **Step 12: Commit.**

```bash
git status --short
git add packages/daemon/src/provider/provider-host.ts packages/daemon/src/index.ts packages/daemon/test/provider-host.test.ts
git commit -m "feat(daemon): execute provider streams over HTTP"
```

### Task 5: Synchronize detailed design and run whole-stage verification

**Files:**
- Modify: `docs/1 High-Level Design/1 High-Level Design.md`
- Modify: `docs/2 Detailed Design Specification/2 Detailed Design Specification.md`
- Modify only if an interface name differs during implementation: `packages/core/src/index.ts`, `packages/daemon/src/index.ts`
- Test: full existing suite plus build/lint

**Interfaces:**
- Consumes: Tasks 1–4 complete.
- Produces: documentation matching the implemented `AgentLoopDriverOptions`, provider dialect, credential shape, retry defaults, timeout default, and error mapping.

- [ ] **Step 1: Add a documentation regression check.**

Run:

```bash
rg -n "interface AgentLoopDriverOptions|runExclusive|now\\(\\): string" \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
```

Expected before the edit: the adjacent §4.4.1 option contract is absent or incomplete.

- [ ] **Step 2: Update DDS §4.4.1.**

Add the exact current `AgentLoopDriverOptions` declaration, including:

```ts
interface AgentLoopDriverOptions {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  now(): string;
}
```

- [ ] **Step 3: Update DDS §5.6 with the fixed runtime decisions.**

Document the `openai-chat` built-in dialect, text-only output support, 64-character encoded tool-name limit, omission of stored reasoning from stateless Chat Completions requests, `stream_options.include_usage=true` by default, credential `{type,value,expiresAt?}` shape keyed by `credentialRef`, 60-second per-attempt timeout, three total attempts, 250ms then 500ms deterministic backoff, retry eligibility before stream start, and the final error-code mapping. Explicitly document that an empty model list is valid and produces `ready=false`. Define "provider business error body" as a provider payload returned inside a 2xx HTTP response: the Host yields it unchanged and the adapter interprets it, while non-2xx responses remain HTTP-status errors handled by the Host. Keep the existing statement that all instruction/system messages are included. In HLD §6.5, rename the `Credentials.get/refresh` parameter from `providerId` to `credentialRef`; the descriptor's `auth.credentialRef` is the opaque store key and provider IDs remain a separate selection concept.

- [ ] **Step 4: Run final verification.**

Run: `node_modules/.bin/vitest run`

Run: `node_modules/.bin/tsc -p tsconfig.json`

Run: `node_modules/.bin/tsc -b tsconfig.build.json`

Run: `node_modules/.bin/biome check .`

Run: `rg -n "from \"(node:)?(fs|http|https|net|tls|dgram|dns)|from \"@pisces/(daemon|protocol)\"" packages/core/src`

Expected: all tests pass, both TypeScript commands exit 0, Biome reports no issues, and the core-boundary scan exits 1 with no matches.

- [ ] **Step 5: Inspect the complete diff for secrets and scope.**

Run: `git diff --stat 4096cc1 --`

Run: `git diff 4096cc1 -- packages/core/src packages/core/test packages/daemon/src packages/daemon/test`

Confirm no real keys, network tests, Gateway/Concurrency/active-turn/Extensions changes, generated `dist`, or unrelated edits.

- [ ] **Step 6: Commit the documentation.**

```bash
git status --short
git add 'docs/1 High-Level Design/1 High-Level Design.md' \
  'docs/2 Detailed Design Specification/2 Detailed Design Specification.md'
git commit -m "docs: align provider runtime contracts"
```

## Plan Self-Review

- **Spec coverage:** Provider descriptor/model schema, adapter build/parse, system-message preservation, stateless Chat Completions reasoning behavior, model lookup, credential injection, URL/header composition, HTTP/SSE streaming, usage chunks, retries, timeout/abort, redacted errors, `ready`, wireName limits, and DDS option synchronization each map to a task.
- **Deliberate exclusions:** concrete credential storage, Extensions discovery, Gateway routing, protocol projection, concurrency limits, and active-turn recovery remain subsequent phases required by DDS §5.1–5.5.
- **Type consistency:** `ProviderDescriptor`, `ModelDescriptor`, `Credential`, `Credentials`, `ProviderSelection`, `LlmAdapterFactory`, `ProviderManagement`, `ProviderHost`, and `ProviderHostOptions` use one spelling throughout.
- **Review Focus mapping:** provider iterator cleanup → Task 0; clone/lifecycle → Task 1; all system messages, no request reasoning, usage chunks, and codec/parser state → Task 2; byte-boundary SSE → Task 3; retry boundary, timeout/abort, redaction, and readiness → Task 4; documentation and final evidence → Task 5.
- **Known limitation:** the design did not name a first provider dialect, credential object, timeout, or retry numbers. This plan fixes those implementation decisions explicitly and writes them back into the DDS; later configuration may expose them without changing the core interfaces.

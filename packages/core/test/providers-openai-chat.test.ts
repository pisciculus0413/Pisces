import { expect, test } from "vitest";
import {
  type ContentBlock,
  decodeWireName,
  type EntryName,
  encodeWireName,
  type LlmRequest,
  type Message,
} from "../src/index.js";

function message(role: Message["role"], ...blocks: ContentBlock[]): Message {
  return { role, content: blocks };
}

function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, number>,
): string {
  return JSON.stringify({
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });
}

function finalUsage(
  usage: Record<string, number> = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
): string {
  return JSON.stringify({
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    choices: [],
    usage,
  });
}

test("serializes every system message in order without instruction filtering", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  const wire = adapter.buildRequest({
    model: "m",
    messages: [
      message("system", text("initial")),
      message("user", text("hello")),
      message("system", text("new instruction")),
      message("system", text("second instruction")),
    ],
  });

  expect(JSON.parse(wire.body).messages).toEqual([
    { role: "system", content: "initial" },
    { role: "user", content: "hello" },
    { role: "system", content: "new instruction" },
    { role: "system", content: "second instruction" },
  ]);
});

test("builds Chat Completions messages, tools, and parameters without stored reasoning", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  const toolName = "pkg#echo" as EntryName;
  const request: LlmRequest = {
    model: "core-model",
    messages: [
      message("user", text("hel"), text("lo")),
      message(
        "assistant",
        { type: "reasoning", text: "stored private reasoning" },
        text("working"),
        { type: "toolCall", id: "call_1", name: toolName, arguments: { text: "ok" } },
        { type: "toolCall", id: "call_2", name: toolName, arguments: { text: "two" } },
      ),
      message("tool", {
        type: "toolResult",
        toolCallId: "call_1",
        content: [
          text("first"),
          {
            type: "toolResult",
            toolCallId: "nested",
            content: [{ type: "reasoning", text: "result" }],
          },
        ],
      }),
      message("tool", {
        type: "toolResult",
        toolCallId: "call_2",
        content: [text("second")],
      }),
    ],
    tools: [
      {
        name: toolName,
        description: "Echo text",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
    parameters: {
      model: "injected-model",
      messages: [],
      tools: [],
      stream: false,
      n: 2,
      functions: [],
      function_call: "auto",
      temperature: 0.2,
      modalities: ["text"],
      stream_options: { include_usage: false, extra: true },
    },
  };

  const wire = adapter.buildRequest(request);
  const body = JSON.parse(wire.body);

  expect(wire.path).toBe("/chat/completions");
  expect(body).toEqual({
    temperature: 0.2,
    modalities: ["text"],
    stream_options: { include_usage: false, extra: true },
    model: "core-model",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "working",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: encodeWireName(toolName),
              arguments: '{"text":"ok"}',
            },
          },
          {
            id: "call_2",
            type: "function",
            function: {
              name: encodeWireName(toolName),
              arguments: '{"text":"two"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "first" },
      { role: "tool", tool_call_id: "call_2", content: "second" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: encodeWireName(toolName),
          description: "Echo text",
          parameters: { type: "object", properties: { text: { type: "string" } } },
        },
      },
    ],
    stream: true,
  });
  expect(JSON.stringify(body)).not.toContain("stored private reasoning");

  const toolParameters = request.tools?.[0]?.parameters;
  if (toolParameters) (toolParameters.properties as Record<string, unknown>).text = "mutated";
  const replay = JSON.parse(wire.body);
  expect(replay.tools[0].function.parameters.properties.text).toEqual({ type: "string" });
});

test("rejects an over-limit wire name before returning a request", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter({ maxToolNameLength: 8 });

  expect(() =>
    adapter.buildRequest({
      model: "m",
      messages: [message("user", text("go"))],
      tools: [
        {
          name: "pkg#echo" as EntryName,
          description: "echo",
          parameters: {},
        },
      ],
    }),
  ).toThrowError(
    expect.objectContaining({
      code: "provider.invalid_response",
      message: "Tool name exceeds provider limit",
    }),
  );
});

test("rejects invalid options and unsupported request shapes safely", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");

  for (const options of [
    { path: "chat" },
    { path: "//evil.test/chat" },
    { maxToolNameLength: 0 },
    { maxToolNameLength: 1.5 },
  ]) {
    expect(() => createOpenAiChatAdapter(options)).toThrowError(
      expect.objectContaining({ code: "provider.invalid_response" }),
    );
  }

  const adapter = createOpenAiChatAdapter();
  const invalidMessages: Message[] = [
    message("system", { type: "toolCall", id: "c", name: "pkg#x" as EntryName, arguments: {} }),
    message("user", { type: "toolResult", toolCallId: "c", content: [] }),
    message("assistant", { type: "toolResult", toolCallId: "c", content: [] }),
    message("assistant", null as never),
    message("tool", text("plain text")),
    message("tool", { type: "toolResult", toolCallId: "", content: [text("bad")] }),
  ];

  for (const invalid of invalidMessages) {
    expect(() =>
      adapter.buildRequest({
        model: "m",
        messages: [invalid],
      }),
    ).toThrowError(expect.objectContaining({ code: "provider.invalid_response" }));
  }

  expect(() =>
    adapter.buildRequest({
      model: "m",
      messages: [message("user", text("go"))],
      parameters: { modalities: ["text", "image"] },
    }),
  ).toThrowError(expect.objectContaining({ code: "provider.invalid_response" }));

  expect(() =>
    adapter.buildRequest({
      model: "m",
      messages: [message("user", text("go"))],
      tools: [
        {
          name: "pkg#echo" as EntryName,
          description: "echo",
          parameters: { bad: undefined } as never,
        },
      ],
    }),
  ).toThrowError(expect.objectContaining({ code: "provider.invalid_response" }));
});

test("rejects tool results that do not match outstanding assistant calls exactly once", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  const toolName = "pkg#echo" as EntryName;
  const assistant = message(
    "assistant",
    { type: "toolCall", id: "call_1", name: toolName, arguments: {} },
    { type: "toolCall", id: "call_2", name: toolName, arguments: {} },
  );
  const result = (toolCallId: string): Message =>
    message("tool", { type: "toolResult", toolCallId, content: [text(toolCallId)] });

  const invalidSequences: Message[][] = [
    [result("call_1")],
    [assistant, result("call_2"), result("call_1")],
    [assistant, result("call_1"), result("call_1"), result("call_2")],
    [assistant, result("call_1"), message("user", text("too early"))],
    [assistant, result("call_1"), result("call_2"), result("call_2")],
  ];

  for (const messages of invalidSequences) {
    expect(() =>
      adapter.buildRequest({
        model: "m",
        messages,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "provider.invalid_response",
        message: "Invalid OpenAI chat request",
      }),
    );
  }
});

test("exports the built-in dialect and a reusable factory", async () => {
  const core = await import("../src/index.js");
  const first = core.openAiChatAdapterFactory({
    id: "p",
    dialect: core.OPENAI_CHAT_DIALECT,
    baseUrl: "https://example.test/v1",
    auth: { type: "apiKey", credentialRef: "ref" },
    models: [],
  });
  const second = core.openAiChatAdapterFactory({
    id: "p",
    dialect: core.OPENAI_CHAT_DIALECT,
    baseUrl: "https://example.test/v1",
    auth: { type: "apiKey", credentialRef: "ref" },
    models: [],
  });

  expect(core.OPENAI_CHAT_DIALECT).toBe("openai-chat");
  expect(first.dialect).toBe(core.OPENAI_CHAT_DIALECT);
  expect(first).not.toBe(second);
  expect(decodeWireName(encodeWireName("pkg#echo" as EntryName))).toBe("pkg#echo");
});

test("reconstructs split tool calls and resets parser state between steps", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  const wireName = encodeWireName("pkg#echo" as EntryName);

  adapter.buildRequest({
    model: "m",
    messages: [message("user", text("first"))],
  });
  expect(
    adapter.parseChunk(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: wireName.slice(0, 5), arguments: '{"text":' },
          },
        ],
      }),
    ),
  ).toEqual([]);
  expect(
    adapter.parseChunk(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              function: { name: wireName.slice(5), arguments: '"ok"}' },
            },
          ],
        },
        "tool_calls",
      ),
    ),
  ).toEqual([
    {
      type: "toolCall",
      call: { id: "call_1", name: "pkg#echo", arguments: { text: "ok" } },
    },
    { type: "stop", reason: "toolCall" },
  ]);
  expect(adapter.parseChunk("[DONE]")).toEqual([]);

  adapter.buildRequest({
    model: "m",
    messages: [message("user", text("second"))],
  });
  expect(adapter.parseChunk(chunk({ content: "fresh" }))).toEqual([
    { type: "content", delta: "fresh" },
  ]);
  expect(adapter.parseChunk(chunk({}, "stop"))).toEqual([{ type: "stop", reason: "stop" }]);
});

test("parses text, compatible reasoning, empty-choice usage, and stop", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  adapter.buildRequest({ model: "m", messages: [message("user", text("go"))] });

  expect(
    adapter.parseChunk(
      chunk({
        content: "hello",
        reasoning_content: "thinking",
      }),
    ),
  ).toEqual([
    { type: "content", delta: "hello" },
    { type: "reasoning", delta: "thinking" },
  ]);
  expect(
    adapter.parseChunk(
      chunk({
        reasoning: "more",
      }),
    ),
  ).toEqual([{ type: "reasoning", delta: "more" }]);
  expect(adapter.parseChunk(finalUsage())).toEqual([
    {
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    },
  ]);
  expect(adapter.parseChunk(chunk({}, "stop"))).toEqual([{ type: "stop", reason: "stop" }]);
  expect(adapter.parseChunk("[DONE]")).toEqual([]);
});

test("emits accumulated tool calls when the supplied finish reason differs", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  const wireName = encodeWireName("pkg#echo" as EntryName);
  adapter.buildRequest({ model: "m", messages: [message("user", text("go"))] });

  adapter.parseChunk(
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: wireName, arguments: "" },
        },
      ],
    }),
  );
  expect(adapter.parseChunk(chunk({}, "stop"))).toEqual([
    {
      type: "toolCall",
      call: { id: "call_1", name: "pkg#echo", arguments: {} },
    },
    { type: "stop", reason: "stop" },
  ]);
});

test.each([
  ["length", "length"],
  ["content_filter", "contentFilter"],
] as const)("maps finish reason %s to %s", async (finishReason, expected) => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  adapter.buildRequest({ model: "m", messages: [message("user", text("go"))] });

  expect(adapter.parseChunk(chunk({}, finishReason))).toEqual([{ type: "stop", reason: expected }]);
});

test("parses a complete non-streaming Chat Completions response", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");
  const adapter = createOpenAiChatAdapter();
  const toolName = "pkg#echo" as EntryName;
  adapter.buildRequest({ model: "m", messages: [message("user", text("go"))] });

  expect(
    adapter.parseChunk(
      JSON.stringify({
        id: "chatcmpl_full",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "hello",
              reasoning_content: "why",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: encodeWireName(toolName),
                    arguments: '{"text":"ok"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    ),
  ).toEqual([
    { type: "content", delta: "hello" },
    { type: "reasoning", delta: "why" },
    {
      type: "toolCall",
      call: { id: "call_1", name: "pkg#echo", arguments: { text: "ok" } },
    },
    {
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    },
    { type: "stop", reason: "toolCall" },
  ]);
});

test("rejects unsafe or malformed responses without leaking provider details", async () => {
  const { createOpenAiChatAdapter } = await import("../src/index.js");

  const invalidResponse = expect.objectContaining({
    code: "provider.invalid_response",
    message: "Provider returned an invalid response",
  });
  const cases: Array<{ frames: string[]; expected?: unknown }> = [
    { frames: ["{"] },
    { frames: [JSON.stringify({ error: { message: "secret-provider-detail" } })] },
    { frames: [chunk({}, "unknown_finish")] },
    { frames: [chunk({ audio: { data: "secret-audio" } })] },
    {
      frames: [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "not-a-wire-name", arguments: "{}" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
    },
    {
      frames: [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: encodeWireName("pkg#echo" as EntryName), arguments: "{" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
    },
    { frames: [chunk({}, "tool_calls")] },
    { frames: [chunk({}, "stop"), chunk({}, "stop")] },
    {
      frames: [
        chunk({}, "stop"),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "late_call",
              function: { name: encodeWireName("pkg#echo" as EntryName), arguments: "{}" },
            },
          ],
        }),
      ],
    },
    {
      frames: [
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: null, tool_calls: [] },
              finish_reason: "tool_calls",
            },
          ],
        }),
      ],
    },
  ];

  for (const testCase of cases) {
    const adapter = createOpenAiChatAdapter();
    adapter.buildRequest({ model: "m", messages: [message("user", text("go"))] });
    let failure: unknown;
    try {
      for (const frame of testCase.frames) adapter.parseChunk(frame);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject(invalidResponse);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain("secret-provider-detail");
    expect(String(failure)).not.toContain("secret-audio");
  }

  const refusal = createOpenAiChatAdapter();
  refusal.buildRequest({ model: "m", messages: [message("user", text("go"))] });
  expect(() => refusal.parseChunk(chunk({ refusal: "provider says no" }))).toThrowError(
    expect.objectContaining({
      code: "provider.refusal",
      message: "Provider refused the request",
    }),
  );
});

import type { LlmRequest } from "../context/types.js";
import type { LlmAdapter, LlmEvent } from "../loop/types.js";
import type { ContentBlock, EntryName, Message, StopReason, ToolCall, Usage } from "../messages.js";
import { decodeWireName, encodeWireName } from "../tools/wire-name.js";
import { type JsonObject, type JsonValue, PiscesError } from "../types.js";
import type { LlmAdapterFactory } from "./types.js";

export const OPENAI_CHAT_DIALECT = "openai-chat";

const DEFAULT_PATH = "/chat/completions";
const DEFAULT_MAX_TOOL_NAME_LENGTH = 64;
const INVALID_OPTIONS = "Invalid OpenAI chat adapter options";
const INVALID_REQUEST = "Invalid OpenAI chat request";
const INVALID_RESPONSE = "Provider returned an invalid response";
const TOOL_NAME_LIMIT = "Tool name exceeds provider limit";
const RESERVED_PARAMETERS = new Set([
  "model",
  "messages",
  "tools",
  "stream",
  "n",
  "functions",
  "function_call",
]);

export interface OpenAiChatAdapterOptions {
  path?: string;
  maxToolNameLength?: number;
}

type WireMessage = Record<string, JsonValue>;

function fail(code: string, message: string): never {
  throw new PiscesError(code, message);
}

function invalidOptions(): never {
  fail("provider.invalid_response", INVALID_OPTIONS);
}

function invalidRequest(): never {
  fail("provider.invalid_response", INVALID_REQUEST);
}

function invalidResponse(): never {
  fail("provider.invalid_response", INVALID_RESPONSE);
}

function hasInvalidPathCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || character === "\\") return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isRecord(value)) {
    const clone: JsonObject = {};
    for (const [key, entry] of Object.entries(value))
      clone[key] = cloneJsonValue(entry as JsonValue);
    return clone;
  }
  return value;
}

function assertJsonObject(value: unknown): asserts value is JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) invalidRequest();
}

function validateOptions(options: OpenAiChatAdapterOptions | undefined): {
  path: string;
  maxToolNameLength: number;
} {
  const path = options?.path ?? DEFAULT_PATH;
  const maxToolNameLength = options?.maxToolNameLength ?? DEFAULT_MAX_TOOL_NAME_LENGTH;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    hasInvalidPathCharacter(path)
  )
    invalidOptions();
  let url: URL;
  try {
    url = new URL(path, "https://adapter.invalid");
  } catch {
    invalidOptions();
  }
  if (url.origin !== "https://adapter.invalid") invalidOptions();
  if (!Number.isSafeInteger(maxToolNameLength) || maxToolNameLength <= 0) invalidOptions();
  return { path, maxToolNameLength };
}

function encodeToolName(name: string, maxLength: number): string {
  const encoded = encodeWireName(name as EntryName);
  if (encoded.length > maxLength) fail("provider.invalid_response", TOOL_NAME_LIMIT);
  return encoded;
}

function flattenTextContent(blocks: ContentBlock[], role: string): string {
  let content = "";
  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== "string") invalidRequest();
    if (block.type === "text" && typeof block.text === "string") content += block.text;
    else if (block.type === "reasoning" && typeof block.text === "string") continue;
    else invalidRequest();
  }
  if (role === "tool" && blocks.length === 0) invalidRequest();
  return content;
}

function stringifyArguments(value: JsonValue): string {
  if (!isJsonValue(value)) invalidRequest();
  try {
    return JSON.stringify(value);
  } catch {
    invalidRequest();
  }
}

function mapToolResult(block: Extract<ContentBlock, { type: "toolResult" }>): WireMessage {
  if (typeof block.toolCallId !== "string" || !block.toolCallId || !Array.isArray(block.content))
    invalidRequest();
  const flatten = (blocks: ContentBlock[]): string => {
    let content = "";
    for (const nested of blocks) {
      if (!isRecord(nested) || typeof nested.type !== "string") invalidRequest();
      if (nested.type === "text" && typeof nested.text === "string") content += nested.text;
      else if (nested.type === "reasoning" && typeof nested.text === "string") continue;
      else if (nested.type === "toolResult" && Array.isArray(nested.content))
        content += flatten(nested.content);
      else invalidRequest();
    }
    return content;
  };
  return {
    role: "tool",
    tool_call_id: block.toolCallId,
    content: flatten(block.content),
  };
}

function mapMessage(message: Message, maxToolNameLength: number): WireMessage[] {
  if (!isRecord(message) || !Array.isArray(message.content)) invalidRequest();
  if (message.role === "system" || message.role === "user") {
    return [
      {
        role: message.role,
        content: flattenTextContent(message.content, message.role),
      },
    ];
  }
  if (message.role === "assistant") {
    let content = "";
    const calls: JsonValue[] = [];
    for (const block of message.content) {
      if (!isRecord(block)) invalidRequest();
      const candidate = block as unknown as Record<string, unknown>;
      if (typeof candidate.type !== "string") invalidRequest();
      if (candidate.type === "text" && typeof candidate.text === "string")
        content += candidate.text;
      else if (candidate.type === "reasoning" && typeof candidate.text === "string") continue;
      else if (
        candidate.type === "toolCall" &&
        typeof candidate.id === "string" &&
        candidate.id &&
        typeof candidate.name === "string" &&
        candidate.name
      ) {
        calls.push({
          id: candidate.id,
          type: "function",
          function: {
            name: encodeToolName(candidate.name, maxToolNameLength),
            arguments: stringifyArguments(candidate.arguments as JsonValue),
          },
        });
      } else invalidRequest();
    }
    return [
      {
        role: "assistant",
        content: content.length ? content : null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
    ];
  }
  if (message.role === "tool") {
    if (!message.content.length) invalidRequest();
    return message.content.map((block) => {
      if (!isRecord(block) || block.type !== "toolResult") invalidRequest();
      return mapToolResult(block as unknown as Extract<ContentBlock, { type: "toolResult" }>);
    });
  }
  invalidRequest();
}

function assistantToolCallIds(message: Message): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const block of message.content) {
    if (!isRecord(block)) invalidRequest();
    const candidate = block as unknown as Record<string, unknown>;
    if (candidate.type !== "toolCall") continue;
    if (
      typeof candidate.id !== "string" ||
      !candidate.id ||
      typeof candidate.name !== "string" ||
      !candidate.name ||
      seen.has(candidate.id)
    )
      invalidRequest();
    seen.add(candidate.id);
    ids.push(candidate.id);
  }
  return ids;
}

function mapMessages(messages: Message[], maxToolNameLength: number): WireMessage[] {
  const mapped: WireMessage[] = [];
  let pendingToolCallIds: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) invalidRequest();
    if (message.role !== "tool") {
      if (pendingToolCallIds.length) invalidRequest();
      mapped.push(...mapMessage(message, maxToolNameLength));
      if (message.role === "assistant") pendingToolCallIds = assistantToolCallIds(message);
      continue;
    }
    if (!message.content.length || !pendingToolCallIds.length) invalidRequest();
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "toolResult") invalidRequest();
      const result = mapToolResult(
        block as unknown as Extract<ContentBlock, { type: "toolResult" }>,
      );
      const toolCallId = result.tool_call_id;
      if (typeof toolCallId !== "string" || pendingToolCallIds[0] !== toolCallId) invalidRequest();
      pendingToolCallIds.shift();
      mapped.push(result);
    }
  }
  if (pendingToolCallIds.length) invalidRequest();
  return mapped;
}

function mapTools(request: LlmRequest, maxToolNameLength: number): JsonValue[] | undefined {
  if (request.tools === undefined) return undefined;
  if (!Array.isArray(request.tools)) invalidRequest();
  if (!request.tools.length) return undefined;
  return request.tools.map((tool) => {
    if (
      !isRecord(tool) ||
      typeof tool.name !== "string" ||
      !tool.name ||
      typeof tool.description !== "string"
    )
      invalidRequest();
    assertJsonObject(tool.parameters);
    return {
      type: "function",
      function: {
        name: encodeToolName(tool.name, maxToolNameLength),
        description: tool.description,
        parameters: cloneJsonValue(tool.parameters),
      },
    };
  });
}

function mapParameters(request: LlmRequest): JsonObject {
  if (request.parameters === undefined) return {};
  assertJsonObject(request.parameters);
  const mapped: JsonObject = {};
  for (const [key, value] of Object.entries(request.parameters)) {
    if (!RESERVED_PARAMETERS.has(key)) mapped[key] = cloneJsonValue(value);
  }
  const modalities = mapped.modalities;
  if (
    modalities !== undefined &&
    (!Array.isArray(modalities) || !modalities.every((value) => value === "text"))
  )
    invalidRequest();
  const configuredStreamOptions = mapped.stream_options;
  if (configuredStreamOptions !== undefined && !isRecord(configuredStreamOptions)) invalidRequest();
  const streamOptions: JsonObject = { include_usage: true };
  if (configuredStreamOptions)
    Object.assign(streamOptions, cloneJsonValue(configuredStreamOptions as JsonObject));
  mapped.stream_options = streamOptions;
  return mapped;
}

function buildRequest(
  request: LlmRequest,
  path: string,
  maxToolNameLength: number,
): { path: string; body: string } {
  if (!isRecord(request) || typeof request.model !== "string" || !request.model.trim())
    invalidRequest();
  if (!Array.isArray(request.messages)) invalidRequest();
  const messages = mapMessages(request.messages, maxToolNameLength);
  const tools = mapTools(request, maxToolNameLength);
  const parameters = mapParameters(request);
  const body = {
    ...parameters,
    model: request.model,
    messages,
    ...(tools ? { tools } : {}),
    stream: true,
  };
  return { path, body: JSON.stringify(body) };
}

interface ToolCallState {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface ParserState {
  stopped: boolean;
  toolCalls: Map<number, ToolCallState>;
}

function freshParserState(): ParserState {
  return { stopped: false, toolCalls: new Map() };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseUsage(value: unknown): Usage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) invalidResponse();
  if (
    !isNonNegativeInteger(value.prompt_tokens) ||
    !isNonNegativeInteger(value.completion_tokens) ||
    (value.total_tokens !== undefined && !isNonNegativeInteger(value.total_tokens))
  )
    invalidResponse();
  return {
    inputTokens: value.prompt_tokens,
    outputTokens: value.completion_tokens,
    ...(value.total_tokens !== undefined ? { totalTokens: value.total_tokens } : {}),
  };
}

function parseFinishReason(value: unknown): StopReason | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "stop") return "stop";
  if (value === "tool_calls") return "toolCall";
  if (value === "length") return "length";
  if (value === "content_filter") return "contentFilter";
  invalidResponse();
}

function parseArguments(value: string): JsonValue {
  if (!value.length) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isJsonValue(parsed)) invalidResponse();
    return parsed;
  } catch (error) {
    if (error instanceof PiscesError) throw error;
    invalidResponse();
  }
}

function decodeToolName(value: string, maxLength: number): EntryName {
  if (!value.length || value.length > maxLength) invalidResponse();
  const decoded = decodeWireName(value);
  if (!decoded) invalidResponse();
  return decoded;
}

function parseToolCall(value: unknown, maxToolNameLength: number): ToolCall {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) invalidResponse();
  if (value.type !== undefined && value.type !== "function") invalidResponse();
  if (!isRecord(value.function)) invalidResponse();
  const { name, arguments: argumentsText } = value.function;
  if (typeof name !== "string" || typeof argumentsText !== "string") invalidResponse();
  return {
    id: value.id,
    name: decodeToolName(name, maxToolNameLength),
    arguments: parseArguments(argumentsText),
  };
}

function applyToolDeltas(value: unknown, state: ParserState): void {
  if (!Array.isArray(value)) invalidResponse();
  for (const fragment of value) {
    if (!isRecord(fragment) || !isNonNegativeInteger(fragment.index)) invalidResponse();
    if (fragment.type !== undefined && fragment.type !== "function") invalidResponse();
    if (!isRecord(fragment.function)) invalidResponse();
    const { id } = fragment;
    const { name, arguments: argumentsText } = fragment.function;
    if (id !== undefined && (typeof id !== "string" || !id)) invalidResponse();
    if (name !== undefined && typeof name !== "string") invalidResponse();
    if (argumentsText !== undefined && typeof argumentsText !== "string") invalidResponse();

    let accumulated = state.toolCalls.get(fragment.index);
    if (!accumulated) {
      accumulated = { index: fragment.index, id: "", name: "", arguments: "" };
      state.toolCalls.set(fragment.index, accumulated);
    }
    if (id !== undefined) {
      if (accumulated.id && accumulated.id !== id) invalidResponse();
      accumulated.id = id;
    }
    if (name !== undefined) accumulated.name += name;
    if (argumentsText !== undefined) accumulated.arguments += argumentsText;
  }
}

function finalizeStreamingToolCalls(state: ParserState, maxToolNameLength: number): ToolCall[] {
  if (!state.toolCalls.size) invalidResponse();
  return [...state.toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) =>
      parseToolCall(
        {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        },
        maxToolNameLength,
      ),
    );
}

function extractTextAndReasoning(value: Record<string, unknown>, events: LlmEvent[]): void {
  if (value.refusal !== undefined && value.refusal !== null) {
    if (typeof value.refusal !== "string") invalidResponse();
    if (value.refusal.length) fail("provider.refusal", "Provider refused the request");
  }
  if (value.audio !== undefined && value.audio !== null) invalidResponse();
  for (const key of ["content", "reasoning_content", "reasoning"] as const) {
    const delta = value[key];
    if (delta === undefined || delta === null) continue;
    if (typeof delta !== "string") invalidResponse();
    if (!delta.length) continue;
    if (key === "content") events.push({ type: "content", delta });
    else events.push({ type: "reasoning", delta });
  }
}

function parseStreamingChoice(
  value: unknown,
  state: ParserState,
  maxToolNameLength: number,
): { events: LlmEvent[]; finishReason: StopReason | undefined } {
  if (!isRecord(value) || (value.index !== undefined && value.index !== 0)) invalidResponse();
  if (!isRecord(value.delta)) invalidResponse();
  if (state.stopped && value.delta.tool_calls !== undefined) invalidResponse();
  const events: LlmEvent[] = [];
  extractTextAndReasoning(value.delta, events);
  if (value.delta.tool_calls !== undefined) applyToolDeltas(value.delta.tool_calls, state);
  const finishReason = parseFinishReason(value.finish_reason);
  if (finishReason && events.length && state.stopped) invalidResponse();
  if (finishReason && state.stopped) invalidResponse();
  if (finishReason && (finishReason === "toolCall" || state.toolCalls.size > 0))
    events.push(
      ...finalizeStreamingToolCalls(state, maxToolNameLength).map((call) => ({
        type: "toolCall" as const,
        call,
      })),
    );
  return { events, finishReason };
}

function parseCompleteChoice(
  value: unknown,
  state: ParserState,
  maxToolNameLength: number,
): { events: LlmEvent[]; finishReason: StopReason | undefined } {
  if (!isRecord(value) || (value.index !== undefined && value.index !== 0)) invalidResponse();
  if (!isRecord(value.message)) invalidResponse();
  const message = value.message;
  const events: LlmEvent[] = [];
  extractTextAndReasoning(message, events);
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) invalidResponse();
    events.push(
      ...message.tool_calls.map((call) => ({
        type: "toolCall" as const,
        call: parseToolCall(call, maxToolNameLength),
      })),
    );
  }
  const finishReason = parseFinishReason(value.finish_reason);
  if (
    finishReason === "toolCall" &&
    (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
  )
    invalidResponse();
  if (finishReason && state.stopped) invalidResponse();
  return { events, finishReason };
}

function parseChatChunk(chunk: string, state: ParserState, maxToolNameLength: number): LlmEvent[] {
  try {
    const trimmed = chunk.trim();
    if (!trimmed) invalidResponse();
    if (trimmed === "[DONE]") return [];
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed) || parsed.error !== undefined) invalidResponse();
    if (!Array.isArray(parsed.choices)) invalidResponse();
    const usage = parseUsage(parsed.usage);

    if (parsed.choices.length === 0) {
      if (!usage) invalidResponse();
      return [{ type: "usage", usage }];
    }
    if (parsed.choices.length !== 1) invalidResponse();
    const choice = parsed.choices[0];
    const isComplete = isRecord(choice) && choice.message !== undefined;
    const result = isComplete
      ? parseCompleteChoice(choice, state, maxToolNameLength)
      : parseStreamingChoice(choice, state, maxToolNameLength);
    if (state.stopped && result.events.some((event) => event.type !== "usage")) invalidResponse();
    const events = [...result.events];
    if (usage) events.push({ type: "usage", usage });
    if (result.finishReason) {
      if (state.stopped) invalidResponse();
      state.stopped = true;
      events.push({ type: "stop", reason: result.finishReason });
    }
    return events;
  } catch (error) {
    if (error instanceof PiscesError) throw error;
    invalidResponse();
  }
}

export function createOpenAiChatAdapter(options?: OpenAiChatAdapterOptions): LlmAdapter {
  const validated = validateOptions(options);
  let parserState = freshParserState();
  return {
    dialect: OPENAI_CHAT_DIALECT,
    buildRequest(request) {
      parserState = freshParserState();
      return buildRequest(request, validated.path, validated.maxToolNameLength);
    },
    parseChunk(chunk) {
      return parseChatChunk(chunk, parserState, validated.maxToolNameLength);
    },
  };
}

export const openAiChatAdapterFactory: LlmAdapterFactory = () => createOpenAiChatAdapter();

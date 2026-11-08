import type { Context, LlmRequest, SessionEventClock } from "../context/types.js";
import type { EventBus } from "../events.js";
import type { StopReason, ToolCall, TurnId, Usage } from "../messages.js";
import type { NodeId, SessionId, SessionMeta, Sessions } from "../sessions/types.js";
import type { Tools } from "../tools/types.js";

export interface WireRequest {
  path: string;
  body: string;
  headers?: Record<string, string>;
}

export type LlmEvent =
  | { type: "content"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "toolCall"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: StopReason }
  | { type: "error"; code: string; message: string; retryable?: boolean };

export interface LlmAdapter {
  readonly dialect: string;
  buildRequest(request: LlmRequest): WireRequest;
  parseChunk(chunk: string): LlmEvent[];
}

export type ExecuteProvider = (request: WireRequest, signal?: AbortSignal) => AsyncIterable<string>;

export interface RunTurnInput {
  sessionId: SessionId;
  turnId: TurnId;
  meta: SessionMeta;
  context: Context;
  sessions: Sessions;
  tools: Tools;
  adapter: LlmAdapter;
  execute: ExecuteProvider;
  events: EventBus;
  eventClock: SessionEventClock;
  contextWindow: number;
  maxOutput: number;
  nodeId?: NodeId;
  signal: AbortSignal;
}

export type TurnReason = "completed" | "cancelled" | "failed";

export interface TurnResult {
  sessionId: SessionId;
  turnId: TurnId;
  reason: TurnReason;
  error?: { code: string; message: string };
}

export interface AgentLoopDriver {
  run(input: RunTurnInput): Promise<TurnResult>;
  cancel(turnId: TurnId): Promise<boolean>;
}

export interface AgentLoopDriverOptions {
  runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T>;
  now(): string;
}

export type AgentLoopDriverFactory = (options: AgentLoopDriverOptions) => AgentLoopDriver;

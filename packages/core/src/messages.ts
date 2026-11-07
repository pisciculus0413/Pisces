import type { NodeId } from "./sessions/types.js";
import type { Brand, JsonObject, JsonValue } from "./types.js";

export type EntryName = Brand<"EntryName">;
export type TurnId = Brand<"TurnId">;

export interface ToolCall {
  id: string; // 本次工具调用的 id，由供应商或适配器产生
  name: EntryName; // package#name，不是条目 id
  arguments: JsonValue; // 已解析的工具参数
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  code?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | ({ type: "toolCall" } & ToolCall)
  | {
      type: "toolResult";
      toolCallId: string;
      content: ContentBlock[];
      isError?: boolean;
      code?: string;
      synthetic?: "interrupted";
    };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}

export interface DefinitionSnapshot {
  name: EntryName;
  kind: "tool" | "wrapper";
  description: string;
  parameters: JsonObject;
  configHash?: string; // wrapper 合并配置的哈希
  definitionHash: string;
}

export interface DeclarationPayload {
  toggle: EntryName[];
  definitions?: DefinitionSnapshot[];
}

export interface CompactionPayload {
  from: NodeId;
  to: NodeId;
  summary: string;
}

export interface CancelPayload {
  turnId: TurnId;
  reason: string;
  at: NodeId;
}

export type ControlPayload = DeclarationPayload | CompactionPayload | CancelPayload;

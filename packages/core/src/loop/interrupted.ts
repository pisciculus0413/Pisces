import type { ContentBlock } from "../messages.js";

export const INTERRUPTED_TOOL_RESULT_TEXT = "结果未知，可能已部分生效，请核验";

export function createInterruptedToolResult(
  toolCallId: string,
): Extract<ContentBlock, { type: "toolResult" }> {
  return {
    type: "toolResult",
    toolCallId,
    content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
    synthetic: "interrupted",
  };
}

import type { ContentBlock } from "../messages.js";

function invalidContent(): never {
  throw new TypeError("Invalid JSON content");
}

export function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) invalidContent();
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    invalidContent();
  if (Object.getOwnPropertySymbols(value).length) invalidContent();
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) invalidContent();
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) invalidContent();
      validateJson(value[index], ancestors);
    }
  } else {
    for (const item of Object.values(value)) validateJson(item, ancestors);
  }
  ancestors.delete(value);
}

export function validateContent(content: ContentBlock[]): void {
  if (!Array.isArray(content)) invalidContent();
  for (const block of content) {
    if (!block || typeof block !== "object") invalidContent();
    switch (block.type) {
      case "text":
      case "reasoning":
        if (typeof block.text !== "string") invalidContent();
        break;
      case "toolCall":
        if (
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          typeof block.name !== "string" ||
          block.name.length === 0 ||
          !("arguments" in block)
        )
          invalidContent();
        break;
      case "toolResult":
        if (
          typeof block.toolCallId !== "string" ||
          block.toolCallId.length === 0 ||
          (block.isError !== undefined && typeof block.isError !== "boolean") ||
          (block.code !== undefined && typeof block.code !== "string") ||
          (block.synthetic !== undefined && block.synthetic !== "interrupted")
        )
          invalidContent();
        validateContent(block.content);
        break;
      default:
        invalidContent();
    }
  }
}

const MAX_CONTENT_BYTES = 262144;
const TRUNCATED = "\n[truncated]";
const bytes = (content: ContentBlock[]) => new TextEncoder().encode(JSON.stringify(content)).length;

/** Only newly resolved source/skill content is truncated; arguments remain intact. */
export function sourceContent(value: ContentBlock[]): ContentBlock[] {
  validateJson(value);
  validateContent(value);
  const content = structuredClone(value);
  if (bytes(content) <= MAX_CONTENT_BYTES) return content;
  const texts: { text: string }[] = [];
  function collect(blocks: ContentBlock[]) {
    for (const block of blocks) {
      if (block.type === "text" || block.type === "reasoning") texts.push(block);
      else if (block.type === "toolResult") collect(block.content);
    }
  }
  collect(content);
  // Keep earlier text when multiple blocks must be shortened.
  for (const block of texts.reverse()) {
    const points = Array.from(block.text);
    if (!points.length) continue;
    block.text = TRUNCATED;
    if (bytes(content) > MAX_CONTENT_BYTES) continue;
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      block.text = points.slice(0, middle).join("") + TRUNCATED;
      if (bytes(content) <= MAX_CONTENT_BYTES) low = middle;
      else high = middle - 1;
    }
    block.text = points.slice(0, low).join("") + TRUNCATED;
    return content;
  }
  throw new TypeError("Source content exceeds 256 KiB after text truncation");
}

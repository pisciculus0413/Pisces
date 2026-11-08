import { validateContent, validateJson } from "../context/content.js";
import type { ContentBlock } from "../messages.js";

const MAX_CONTENT_BYTES = 262144;
const TRUNCATED = "\n[truncated]";
const bytes = (content: ContentBlock[]) => new TextEncoder().encode(JSON.stringify(content)).length;

export function limitDriverContent(value: ContentBlock[]): ContentBlock[] {
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

  return content;
}

import { type NodeId, PiscesError, type SessionMeta, type SessionNode } from "@pisces/core";

export interface NodePosition {
  parentId: NodeId;
  offset: number;
  length: number;
}
export interface SessionIndex {
  positions: Map<NodeId, NodePosition>;
  commit: number;
  last: NodeId;
}
export const corrupt = (message: string, cause?: unknown) =>
  new PiscesError("storage.corrupt", message, { cause });
export function assertSessionId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
    throw new TypeError("Invalid session id");
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const timestamp = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function denseArray(value: unknown, valid: (item: unknown) => boolean): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !valid(value[index])) return false;
  }
  return true;
}
function jsonValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    denseArray(value, jsonValue) ||
    (object(value) && Object.values(value).every(jsonValue))
  );
}
function content(value: unknown): boolean {
  if (!object(value)) return false;
  switch (value.type) {
    case "text":
    case "reasoning":
      return typeof value.text === "string";
    case "toolCall":
      return nonempty(value.id) && nonempty(value.name) && jsonValue(value.arguments);
    case "toolResult":
      return (
        nonempty(value.toolCallId) &&
        denseArray(value.content, content) &&
        (value.isError === undefined || typeof value.isError === "boolean") &&
        (value.code === undefined || typeof value.code === "string") &&
        (value.synthetic === undefined || value.synthetic === "interrupted")
      );
    default:
      return false;
  }
}
export function validMeta(value: unknown, id: string): value is SessionMeta {
  return (
    object(value) &&
    value.id === id &&
    nonempty(value.model) &&
    nonempty(value.provider) &&
    nonempty(value.workspace) &&
    timestamp(value.createdAt) &&
    value.schemaVersion === 1
  );
}
export function validNode(value: unknown): value is SessionNode {
  if (
    !object(value) ||
    !nonempty(value.id) ||
    !nonempty(value.parentId) ||
    !timestamp(value.createdAt) ||
    value.schemaVersion !== 1 ||
    typeof value.source !== "string" ||
    !denseArray(value.content, content) ||
    (value.synthetic !== undefined && value.synthetic !== "interrupted")
  )
    return false;
  if (value.kind === "agent")
    return ["system", "user", "assistant", "tool"].includes(value.role as string);
  if (
    value.kind !== "control" ||
    !["declaration", "compaction", "cancel"].includes(value.role as string)
  )
    return false;
  const block: unknown = value.content[0];
  if (
    value.content.length !== 1 ||
    !object(block) ||
    block.type !== "text" ||
    typeof block.text !== "string"
  )
    return false;
  try {
    return object(JSON.parse(block.text));
  } catch {
    return false;
  }
}
export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw corrupt("Invalid UTF-8", cause);
  }
}
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decode(bytes));
  } catch (cause) {
    throw corrupt("Invalid JSON", cause);
  }
}
export function parseCommit(bytes: Uint8Array, size: number): number {
  for (const byte of bytes) if (byte > 0x7f) throw corrupt("Invalid commit boundary");
  const text = decode(bytes);
  if (!/^(0|[1-9][0-9]*)\n?$/.test(text)) throw corrupt("Invalid commit boundary");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0 || value > size)
    throw corrupt("Invalid commit boundary");
  return value;
}
export function buildIndex(bytes: Buffer): SessionIndex {
  if (!bytes.length || bytes[bytes.length - 1] !== 10)
    throw corrupt("Commit is not a line boundary");
  const positions = new Map<NodeId, NodePosition>();
  let offset = 0;
  let last: NodeId | undefined;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset) + 1;
    const line = decode(bytes.subarray(offset, end));
    if (line.trim()) {
      const node = parseJson(bytes.subarray(offset, end));
      if (!validNode(node)) throw corrupt("Invalid session node");
      if (
        positions.has(node.id) ||
        (positions.size === 0 ? node.parentId !== node.id : !positions.has(node.parentId))
      )
        throw corrupt("Invalid session topology");
      positions.set(node.id, { parentId: node.parentId, offset, length: end - offset });
      last = node.id;
    }
    offset = end;
  }
  if (!last) throw corrupt("Empty session");
  return { positions, commit: bytes.length, last };
}
export function encodeBatch(
  nodes: SessionNode[],
  previous?: SessionIndex,
): { bytes: Buffer; index: SessionIndex } {
  if (!Array.isArray(nodes) || !nodes.length) throw new TypeError("Empty node batch");
  const positions = new Map(previous?.positions);
  let offset = previous?.commit ?? 0;
  const chunks: Buffer[] = [];
  let parent: NodeId | undefined;
  for (const node of nodes) {
    if (!validNode(node) || positions.has(node.id))
      throw new TypeError("Invalid or duplicate node");
    if (parent !== undefined && node.parentId !== parent)
      throw new TypeError("Discontinuous node batch");
    if (parent === undefined) {
      if (previous ? !positions.has(node.parentId) : node.parentId !== node.id) {
        if (previous) throw new PiscesError("session.node_not_found", "Parent node not in session");
        throw new TypeError("Invalid root node");
      }
    }
    const bytes = Buffer.from(`${JSON.stringify(node)}\n`);
    positions.set(node.id, { parentId: node.parentId, offset, length: bytes.length });
    offset += bytes.length;
    chunks.push(bytes);
    parent = node.id;
  }
  return {
    bytes: Buffer.concat(chunks),
    index: { positions, commit: offset, last: parent as NodeId },
  };
}

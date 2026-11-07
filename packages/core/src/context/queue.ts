import type { ContentBlock } from "../messages.js";
import { PiscesError } from "../types.js";
import type { Context, QueueEntry, QueueEntryId, QueueEntryInput } from "./types.js";

interface QueueDeps {
  newId(): QueueEntryId;
  now(): string;
  onChange(): void;
}

type Queue = Pick<Context, "enqueue" | "edit" | "remove" | "clear" | "confirm" | "unconfirm"> & {
  snapshot(): QueueEntry[];
  consume(ids: ReadonlySet<QueueEntryId>): boolean;
};

function invalidControl(): never {
  throw new PiscesError("queue.invalid_control", "Invalid queue entry");
}

function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) invalidControl();
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    invalidControl();
  if (Object.getOwnPropertySymbols(value).length) invalidControl();
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) invalidControl();
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) invalidControl();
      validateJson(value[index], ancestors);
    }
  } else {
    for (const item of Object.values(value)) validateJson(item, ancestors);
  }
  ancestors.delete(value);
}

function validateContent(content: ContentBlock[]): void {
  if (!Array.isArray(content)) invalidControl();
  for (const block of content) {
    if (!block || typeof block !== "object") invalidControl();
    switch (block.type) {
      case "text":
      case "reasoning":
        if (typeof block.text !== "string") invalidControl();
        break;
      case "toolCall":
        if (
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          typeof block.name !== "string" ||
          block.name.length === 0 ||
          !("arguments" in block)
        )
          invalidControl();
        break;
      case "toolResult":
        if (
          typeof block.toolCallId !== "string" ||
          block.toolCallId.length === 0 ||
          (block.isError !== undefined && typeof block.isError !== "boolean") ||
          (block.code !== undefined && typeof block.code !== "string") ||
          (block.synthetic !== undefined && block.synthetic !== "interrupted")
        )
          invalidControl();
        validateContent(block.content);
        break;
      default:
        invalidControl();
    }
  }
}

function validateInput(entry: QueueEntryInput): void {
  if (!entry || typeof entry !== "object") invalidControl();
  validateJson(entry.content);
  validateContent(entry.content);
  if (!Array.isArray(entry.content) || typeof entry.source !== "string") invalidControl();
  if (entry.kind === "agent") {
    if (!["system", "user", "assistant", "tool"].includes(entry.role)) invalidControl();
    return;
  }
  if (entry.kind !== "control" || entry.role !== "declaration") invalidControl();
  const block = entry.content[0];
  if (entry.content.length !== 1 || block?.type !== "text") invalidControl();
  let payload: unknown;
  try {
    payload = JSON.parse(block.text);
  } catch {
    invalidControl();
  }
  // Task 3 replaces this basic check with the shared declaration parser.
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) invalidControl();
  const toggle = (payload as { toggle?: unknown }).toggle;
  if (
    !Array.isArray(toggle) ||
    toggle.some((name) => typeof name !== "string" || !/^[^#\s]+#[^#\s]+$/u.test(name))
  )
    invalidControl();
}

function validateSize(entries: QueueEntry[]): void {
  const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  if (entries.some((entry) => byteLength(entry) > 262144))
    throw new PiscesError("queue.entry_too_large", "Queue entry exceeds 256 KiB");
  if (byteLength(entries) > 1048576)
    throw new PiscesError("queue.too_large", "Queue exceeds 1 MiB");
}

export function createQueue({ newId, now, onChange }: QueueDeps): Queue {
  let entries: QueueEntry[] = [];

  function find(id: QueueEntryId): QueueEntry {
    const entry = entries.find((entry) => entry.id === id);
    if (!entry) throw new PiscesError("queue.entry_not_found", "Queue entry not found");
    return entry;
  }

  function replace(candidate: QueueEntry[]): void {
    validateSize(candidate);
    entries = candidate;
    onChange();
  }

  return {
    snapshot: () => structuredClone(entries),
    enqueue(inputs) {
      if (!inputs.length) return [];
      for (const input of inputs) validateInput(input);
      const added = inputs.map(
        (input): QueueEntry => ({
          kind: input.kind,
          role: input.role,
          content: structuredClone(input.content),
          source: input.source,
          id: newId(),
          createdAt: now(),
        }),
      );
      replace([...entries, ...added]);
      return added.map((entry) => entry.id);
    },
    edit(id, content: ContentBlock[]) {
      const entry = find(id);
      if (entry.confirmedAt !== undefined)
        throw new PiscesError("queue.entry_locked", "Queue entry is confirmed", {
          data: { reason: "confirmed" },
        });
      if (entry.kind !== "agent") invalidControl();
      validateInput({ ...entry, content });
      replace(
        entries.map((current) =>
          current.id === id ? { ...current, content: structuredClone(content) } : current,
        ),
      );
    },
    remove(id) {
      find(id);
      replace(entries.filter((entry) => entry.id !== id));
    },
    clear() {
      const ids = entries.map((entry) => entry.id);
      if (ids.length) replace([]);
      return ids;
    },
    confirm() {
      if (entries.every((entry) => entry.confirmedAt !== undefined)) return;
      const confirmedAt = now();
      replace(
        entries.map((entry) =>
          entry.confirmedAt === undefined ? { ...entry, confirmedAt } : entry,
        ),
      );
    },
    unconfirm() {
      if (entries.every((entry) => entry.confirmedAt === undefined)) return;
      replace(
        entries.map((entry) => {
          const { confirmedAt: _, ...unconfirmed } = entry;
          return unconfirmed;
        }),
      );
    },
    consume(ids) {
      const remaining = entries.filter((entry) => !ids.has(entry.id));
      if (remaining.length === entries.length) return false;
      entries = remaining;
      return true;
    },
  };
}

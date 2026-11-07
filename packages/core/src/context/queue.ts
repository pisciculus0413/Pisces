import type { ContentBlock } from "../messages.js";
import { PiscesError } from "../types.js";
import { validateContent, validateJson } from "./content.js";
import { parseDeclaration } from "./declarations.js";
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

function validateInput(entry: QueueEntryInput): void {
  if (!entry || typeof entry !== "object") invalidControl();
  try {
    validateJson(entry.content);
    validateContent(entry.content);
  } catch {
    invalidControl();
  }
  if (!Array.isArray(entry.content) || typeof entry.source !== "string") invalidControl();
  if (entry.kind === "agent") {
    if (!["system", "user", "assistant", "tool"].includes(entry.role)) invalidControl();
    return;
  }
  if (entry.kind !== "control" || entry.role !== "declaration") invalidControl();
  parseDeclaration(entry.content, "queue");
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

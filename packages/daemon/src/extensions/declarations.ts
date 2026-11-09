import {
  applyDeclarations,
  type ContentBlock,
  type ContextEntryKind,
  type DefinitionSnapshot,
  type EntryName,
  PiscesError,
  type QueueEntryInput,
  type SelectionView,
  type SessionNodeDraft,
} from "@pisces/core";
import type { ExtensionBinding } from "./types.js";

const INVALID = "Invalid declaration";
const INVALID_ENTRY = "Invalid queue entry";
const UNKNOWN_ENTRY = "Unknown declaration entry";
const KIND_CHANGED = "Declaration changes a known entry kind";
const MISSING_DEFINITION = "Missing frozen declaration definition";

type HistoricalKind = "tool" | "wrapper" | "content";

const isEntryName = (value: unknown): value is EntryName =>
  typeof value === "string" && /^[^#\s]+#[^#\s]+$/u.test(value);

function fail(code: "queue.invalid_control" | "queue.duplicate_name", message: string): never {
  throw new PiscesError(code, message);
}

function compareNames(left: EntryName, right: EntryName): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cloneBlocks(content: readonly ContentBlock[]): ContentBlock[] {
  try {
    return structuredClone([...content]);
  } catch {
    return fail("queue.invalid_control", INVALID_ENTRY);
  }
}

// Client declarations are exactly one text block holding {"toggle": ["package#name"]}.
function parseToggle(content: readonly ContentBlock[]): EntryName[] {
  if (content.length !== 1) fail("queue.invalid_control", INVALID);
  const block = content[0];
  if (block === undefined || block.type !== "text") fail("queue.invalid_control", INVALID);
  let payload: unknown;
  try {
    payload = JSON.parse(block.text);
  } catch {
    fail("queue.invalid_control", INVALID);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    fail("queue.invalid_control", INVALID);
  const keys = Object.keys(payload);
  // Inline definitions (even empty) and unknown keys are never accepted from clients.
  if (keys.length !== 1 || keys[0] !== "toggle") fail("queue.invalid_control", INVALID);
  const toggle = (payload as { toggle?: unknown }).toggle;
  if (!Array.isArray(toggle) || !toggle.every(isEntryName)) fail("queue.invalid_control", INVALID);
  const names = toggle as EntryName[];
  if (new Set(names).size !== names.length) fail("queue.duplicate_name", INVALID);
  return [...names];
}

interface ParsedInput {
  entry: QueueEntryInput;
  toggle?: EntryName[];
}

function parseInput(value: unknown): ParsedInput {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("queue.invalid_control", INVALID_ENTRY);
  const record = value as Record<string, unknown>;
  const { kind, role, source, content } = record;
  if (typeof source !== "string" || !Array.isArray(content))
    fail("queue.invalid_control", INVALID_ENTRY);
  const blocks = content as ContentBlock[];
  if (kind === "control") {
    if (role !== "declaration") fail("queue.invalid_control", INVALID);
    return {
      entry: { kind: "control", role: "declaration", source, content: cloneBlocks(blocks) },
      toggle: parseToggle(blocks),
    };
  }
  if (kind !== "agent") fail("queue.invalid_control", INVALID_ENTRY);
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool")
    fail("queue.invalid_control", INVALID_ENTRY);
  return { entry: { kind: "agent", role, source, content: cloneBlocks(blocks) } };
}

const evidenceKind = (view: SelectionView, name: EntryName): HistoricalKind | undefined => {
  const definition = view.definitions.find((candidate) => candidate.name === name);
  if (definition !== undefined) return definition.kind;
  return view.contentNames.includes(name) ? "content" : undefined;
};

const comparableKind = (kind: ContextEntryKind | undefined): HistoricalKind | undefined => {
  if (kind === "tool" || kind === "wrapper") return kind;
  if (kind === "skill" || kind === "context") return "content";
  return undefined;
};

// Pure preflight: evidence and kind checks run before any snapshot is chosen.
function reviewedSnapshot(
  binding: ExtensionBinding,
  view: SelectionView,
  selected: ReadonlySet<EntryName>,
  name: EntryName,
): DefinitionSnapshot | undefined {
  const current = binding.entries.kind(name);
  const historical = view.definitions.find((definition) => definition.name === name);
  const evidence = evidenceKind(view, name);
  if (current === undefined && evidence === undefined) fail("queue.invalid_control", UNKNOWN_ENTRY);
  if (evidence !== undefined && selected.has(name)) {
    const mapped = comparableKind(current);
    if (mapped !== undefined && mapped !== evidence) fail("queue.invalid_control", KIND_CHANGED);
  }
  if (current === "tool" || current === "wrapper") {
    // A changed kind keeps the reviewed old snapshot; it never adopts the new type.
    if (historical !== undefined && historical.kind !== current) return structuredClone(historical);
    // Content-only evidence on a closing toggle keeps old evidence: attach no new-type snapshot.
    if (historical === undefined && evidence === "content" && !selected.has(name)) return undefined;
    const frozen = binding.inventory.entries.find((entry) => entry.name === name)?.definition;
    if (frozen === undefined || frozen.name !== name || frozen.kind !== current)
      fail("queue.invalid_control", MISSING_DEFINITION);
    return structuredClone(frozen);
  }
  return historical === undefined ? undefined : structuredClone(historical);
}

/**
 * Atomically validates one batch of agent inputs and client toggle declarations.
 * Synchronous and side-effect free: no ids, timestamps, disk, or extension modules.
 * Every available tool/wrapper toggle carries its full snapshot, open or closed,
 * except a closing toggle whose only evidence is content: no new-kind snapshot.
 */
export function enrichQueueEntries(
  binding: ExtensionBinding,
  view: SelectionView,
  pending: readonly QueueEntryInput[],
  inputs: readonly unknown[],
): QueueEntryInput[] {
  const parsedInputs = inputs.map(parseInput);
  const declarations = parsedInputs.filter(
    (input): input is ParsedInput & { toggle: EntryName[] } => input.toggle !== undefined,
  );
  // Core owns the XOR: persisted view, then queued declarations, then this batch.
  const queued = pending.length === 0 ? view : applyDeclarations(view, pending);
  const effective: SelectionView =
    declarations.length === 0
      ? queued
      : applyDeclarations(
          queued,
          declarations.map((declaration) => declaration.entry as SessionNodeDraft),
        );
  const selected = new Set(effective.selection);
  const snapshots = new Map<EntryName, DefinitionSnapshot | undefined>();
  for (const declaration of declarations) {
    for (const name of declaration.toggle) {
      if (snapshots.has(name)) continue;
      snapshots.set(name, reviewedSnapshot(binding, view, selected, name));
    }
  }
  return parsedInputs.map((input) => {
    if (input.toggle === undefined) return input.entry;
    const definitions: DefinitionSnapshot[] = [];
    for (const name of input.toggle) {
      const definition = snapshots.get(name);
      if (definition !== undefined) definitions.push(structuredClone(definition));
    }
    definitions.sort((left, right) => compareNames(left.name, right.name));
    const payload =
      definitions.length === 0
        ? { toggle: [...input.toggle] }
        : { toggle: [...input.toggle], definitions };
    return { ...input.entry, content: [{ type: "text", text: JSON.stringify(payload) }] };
  });
}

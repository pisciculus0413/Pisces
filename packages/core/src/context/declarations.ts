import type {
  ContentBlock,
  DeclarationPayload,
  DefinitionSnapshot,
  EntryName,
} from "../messages.js";
import type { SessionNodeDraft } from "../sessions/types.js";
import { PiscesError } from "../types.js";
import { validateJson } from "./content.js";
import type { SelectionState } from "./types.js";

export const isEntryName = (value: unknown): value is EntryName =>
  typeof value === "string" && /^[^#\s]+#[^#\s]+$/u.test(value);

export function validDefinition(value: unknown): value is DefinitionSnapshot {
  if (value === null || typeof value !== "object") return false;
  const definition = value as Partial<DefinitionSnapshot>;
  try {
    validateJson(definition.parameters);
  } catch {
    return false;
  }
  return (
    isEntryName(definition.name) &&
    (definition.kind === "tool" || definition.kind === "wrapper") &&
    typeof definition.description === "string" &&
    definition.parameters !== null &&
    typeof definition.parameters === "object" &&
    !Array.isArray(definition.parameters) &&
    typeof definition.definitionHash === "string" &&
    definition.definitionHash.length > 0 &&
    (definition.configHash === undefined ||
      (typeof definition.configHash === "string" && definition.configHash.length > 0))
  );
}

export function parseDeclaration(
  content: ContentBlock[],
  origin: "queue" | "storage",
): DeclarationPayload {
  const fail = (duplicate = false): never => {
    throw new PiscesError(
      origin === "storage"
        ? "storage.corrupt"
        : duplicate
          ? "queue.duplicate_name"
          : "queue.invalid_control",
      "Invalid declaration",
    );
  };
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== "text" ||
    typeof content[0].text !== "string"
  )
    fail();
  let payload: unknown;
  try {
    payload = JSON.parse((content[0] as { text: string }).text);
  } catch {
    fail();
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) fail();
  const { toggle, definitions } = payload as DeclarationPayload;
  if (!Array.isArray(toggle) || !toggle.every(isEntryName)) fail();
  if (new Set(toggle).size !== toggle.length) fail(true);
  if (
    definitions !== undefined &&
    (!Array.isArray(definitions) || !definitions.every(validDefinition))
  )
    fail();
  return payload as DeclarationPayload;
}

export function declarationPayloads(
  nodes: readonly SessionNodeDraft[],
  origin: "queue" | "storage",
): DeclarationPayload[] {
  const payloads: DeclarationPayload[] = [];
  for (const node of nodes)
    if (node.kind === "control" && node.role === "declaration")
      payloads.push(parseDeclaration(node.content, origin));
  return payloads;
}

const isContentNode = (node: SessionNodeDraft) =>
  node.kind === "agent" && node.role === "system" && isEntryName(node.source);

/** Accumulated branch evidence shared by every pure replay consumer. */
export interface ReplayState {
  selection: Set<EntryName>;
  definitions: Map<EntryName, DefinitionSnapshot>;
  contentNames: Set<EntryName>;
}

export function createReplayState(): ReplayState {
  return { selection: new Set(), definitions: new Map(), contentNames: new Set() };
}

/** Single XOR/definition application used by both replay and pending application. */
export function applyDeclarationPayload(state: ReplayState, payload: DeclarationPayload): void {
  for (const name of payload.toggle) {
    if (state.selection.has(name)) state.selection.delete(name);
    else state.selection.add(name);
  }
  for (const definition of payload.definitions ?? [])
    state.definitions.set(definition.name, structuredClone(definition));
}

export function replayNodes(
  nodes: readonly SessionNodeDraft[],
  origin: "queue" | "storage",
): ReplayState {
  const state = createReplayState();
  for (const payload of declarationPayloads(nodes, origin)) applyDeclarationPayload(state, payload);
  for (const node of nodes)
    if (isContentNode(node)) state.contentNames.add(node.source as EntryName);
  return state;
}

export function replayDeclarations(nodes: readonly SessionNodeDraft[]): {
  selection: SelectionState;
  definitions: Map<EntryName, DefinitionSnapshot>;
} {
  const { selection, definitions } = replayNodes(nodes, "storage");
  return { selection: [...selection].sort(), definitions };
}

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

export function replayDeclarations(nodes: readonly SessionNodeDraft[]): {
  selection: SelectionState;
  definitions: Map<EntryName, DefinitionSnapshot>;
} {
  const selected = new Set<EntryName>();
  const definitions = new Map<EntryName, DefinitionSnapshot>();
  for (const node of nodes) {
    if (node.kind !== "control" || node.role !== "declaration") continue;
    const payload = parseDeclaration(node.content, "storage");
    for (const name of payload.toggle) {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
    }
    for (const definition of payload.definitions ?? [])
      definitions.set(definition.name, structuredClone(definition));
  }
  return { selection: [...selected].sort(), definitions };
}

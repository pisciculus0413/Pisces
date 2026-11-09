import type { DefinitionSnapshot, EntryName } from "../messages.js";
import type { SessionNodeDraft } from "../sessions/types.js";
import type { EffectiveEntry } from "../tools/types.js";
import { PiscesError } from "../types.js";
import {
  applyDeclarationPayload,
  createReplayState,
  declarationPayloads,
  type ReplayState,
  replayNodes,
  validDefinition,
} from "./declarations.js";
import type { ContextEntries, SelectionState } from "./types.js";

/** Frozen branch view: XOR selection plus historical kind evidence. */
export interface SelectionView {
  selection: SelectionState;
  definitions: DefinitionSnapshot[];
  contentNames: EntryName[];
}

export interface SelectionEvaluation {
  effective: EffectiveEntry[];
  executionSelection: SelectionState;
  contentSelection: SelectionState;
  unresolvedSources: EntryName[];
}

function compareNames(left: EntryName, right: EntryName): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function freeze(state: ReplayState): SelectionView {
  return {
    selection: [...state.selection].sort(),
    definitions: [...state.definitions.values()]
      .map((definition) => structuredClone(definition))
      .sort((left, right) => compareNames(left.name, right.name)),
    contentNames: [...state.contentNames].sort(),
  };
}

export function replaySelection(branch: readonly SessionNodeDraft[]): SelectionView {
  return freeze(replayNodes(branch, "storage"));
}

/**
 * Overlays pending declarations on a frozen view. A conflicting kind is only
 * rejected when the declaration leaves the name selected (a reopen under a new
 * type); a closing toggle discards the new-kind definition and keeps old
 * evidence. No historical definition is overwritten before this check.
 */
export function applyDeclarations(
  view: SelectionView,
  pending: readonly SessionNodeDraft[],
): SelectionView {
  const payloads = declarationPayloads(pending, "queue");
  const known = new Map<EntryName, "tool" | "wrapper" | "content">();
  for (const name of view.contentNames) known.set(name, "content");
  for (const definition of view.definitions) known.set(definition.name, definition.kind);
  const state = createReplayState();
  for (const name of view.selection) state.selection.add(name);
  for (const definition of view.definitions)
    state.definitions.set(definition.name, structuredClone(definition));
  for (const name of view.contentNames) state.contentNames.add(name);
  for (const payload of payloads) {
    applyDeclarationPayload(state, { toggle: payload.toggle });
    const accepted: DefinitionSnapshot[] = [];
    for (const definition of payload.definitions ?? []) {
      const evidence = known.get(definition.name);
      if (evidence !== undefined && evidence !== definition.kind) {
        if (state.selection.has(definition.name))
          throw new PiscesError("queue.invalid_control", "Declaration changes a known entry kind", {
            data: { name: definition.name },
          });
        // Closing is allowed: discard the new-kind definition, keep old evidence.
        continue;
      }
      known.set(definition.name, definition.kind);
      accepted.push(definition);
    }
    applyDeclarationPayload(state, { toggle: [], definitions: accepted });
  }
  return freeze(state);
}

function corrupted(name: EntryName): never {
  throw new PiscesError("storage.corrupt", "Missing or invalid frozen definition", {
    data: { name },
  });
}

function frozenDefinition(
  definition: DefinitionSnapshot | undefined,
  name: EntryName,
): DefinitionSnapshot {
  if (!validDefinition(definition) || definition.name !== name) corrupted(name);
  return definition;
}

function effectiveEntry(definition: DefinitionSnapshot, stale: boolean): EffectiveEntry {
  return {
    name: definition.name,
    definitionHash: definition.definitionHash,
    ...(definition.configHash === undefined ? {} : { configHash: definition.configHash }),
    stale,
  };
}

/**
 * Pure eligibility projection. Without `entries.matchesDefinition` this keeps
 * the historical projection/error semantics (manual injection never goes stale).
 */
export function evaluateSelection(
  view: SelectionView,
  entries: ContextEntries,
): SelectionEvaluation {
  const definitions = new Map(view.definitions.map((definition) => [definition.name, definition]));
  const contentNames = new Set(view.contentNames);
  const effective: EffectiveEntry[] = [];
  const executionSelection: EntryName[] = [];
  const contentSelection: EntryName[] = [];
  const unresolvedSources: EntryName[] = [];
  const matchesDefinition = entries.matchesDefinition;
  for (const name of [...new Set(view.selection)].sort()) {
    const kind = entries.kind(name);
    const definition = definitions.get(name);
    if (!matchesDefinition) {
      if (kind === "context" || kind === "skill") {
        contentSelection.push(name);
        effective.push({ name, stale: false });
        continue;
      }
      if (kind !== "tool" && kind !== "wrapper") corrupted(name);
      const frozen = frozenDefinition(definition, name);
      if (frozen.kind !== kind) corrupted(name);
      executionSelection.push(name);
      effective.push(effectiveEntry(frozen, false));
      continue;
    }
    if (definition !== undefined) {
      const frozen = frozenDefinition(definition, name);
      if (kind === frozen.kind && matchesDefinition(frozen)) {
        executionSelection.push(name);
        effective.push(effectiveEntry(frozen, false));
      } else effective.push(effectiveEntry(frozen, true));
      continue;
    }
    if (contentNames.has(name) || kind === "context" || kind === "skill") {
      contentSelection.push(name);
      effective.push({ name, stale: false });
      continue;
    }
    if (kind === "tool" || kind === "wrapper") corrupted(name);
    unresolvedSources.push(name);
    effective.push({ name, stale: true });
  }
  return { effective, executionSelection, contentSelection, unresolvedSources };
}

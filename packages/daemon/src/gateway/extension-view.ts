import {
  type EffectiveEntry,
  type EntryInfo,
  evaluateSelection,
  type SelectionView,
} from "@pisces/core";
import type { ExtensionBinding } from "../extensions/types.js";
import type { EntriesSnapshotResult, EntrySnapshot } from "./protocol.js";

function snapshotEntry(info: EntryInfo): EntrySnapshot {
  const definition = info.definition;
  return {
    name: info.name,
    kind: info.type,
    ...(info.description === undefined ? {} : { description: info.description }),
    ...(definition === undefined ? {} : { parameters: definition.parameters }),
    ...(info.definitionHash === undefined ? {} : { definitionHash: info.definitionHash }),
    ...(definition?.configHash === undefined ? {} : { configHash: definition.configHash }),
  };
}

/**
 * Pure projection for `entries.snapshot`: inventory entries are reduced to protocol fields and
 * eligibility comes from the frozen branch view. A queued toggle is never applied here, so a
 * pending declaration cannot leak into `selection` or `effective`. The result is a deep clone.
 */
export function extensionSnapshot(
  binding: ExtensionBinding | undefined,
  view: SelectionView,
): EntriesSnapshotResult {
  const entries = binding === undefined ? [] : binding.inventory.entries.map(snapshotEntry);
  const effective: EffectiveEntry[] =
    binding === undefined ? [] : evaluateSelection(view, binding.entries).effective;
  return structuredClone({ entries, selection: view.selection, effective });
}

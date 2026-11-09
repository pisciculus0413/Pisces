import { realpath } from "node:fs/promises";
import {
  type EntryName,
  PiscesError,
  type QueueEntryInput,
  replaySelection,
  type SelectionView,
} from "@pisces/core";
import { enrichQueueEntries } from "../extensions/declarations.js";
import type { ExtensionBinding, ExtensionConfig, Extensions } from "../extensions/types.js";
import { CREATE_ENTRY_SOURCE, type CreateSessionParams } from "./protocol.js";

const ENTRY_NAME = /^[^#\s]+#[^#\s]+$/u;
// One fixed, safe wire error for every extension-service failure: no message, cause,
// path, or configuration value from the service is ever forwarded.
const SAFE_CODE = "config.invalid";
const SAFE_MESSAGE = "Invalid extension configuration";
// Declarations arrive with fixed safe messages from the pure Core/helper validators.
const ENRICHMENT_CODES = new Set(["queue.invalid_control", "queue.duplicate_name"]);

/** Resolved host inputs; the Gateway still validates the model registration. */
export interface PreparedExtensionSession {
  binding: ExtensionBinding;
  workspace: string;
  provider: string | undefined;
  model: string | undefined;
  extensions: EntryName[];
}

function serviceFailure(): never {
  throw new PiscesError(SAFE_CODE, SAFE_MESSAGE);
}

function enrichmentFailure(error: unknown): never {
  if (error instanceof PiscesError && ENRICHMENT_CODES.has(error.code)) throw error;
  serviceFailure();
}

async function readGlobalDefaults(extensions: Extensions): Promise<ExtensionConfig> {
  try {
    return await extensions.readGlobalConfig();
  } catch {
    serviceFailure();
  }
}

/** Runs discovery and file reads for one binding; never imports extension modules. */
export async function prepareBinding(
  extensions: Extensions,
  workspace: string,
): Promise<ExtensionBinding> {
  try {
    return await extensions.prepare(workspace);
  } catch {
    serviceFailure();
  }
}

async function workspaceResolves(workspace: string): Promise<boolean> {
  try {
    await realpath(workspace);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepare for an already-persisted session, whose workspace may have disappeared since it was
 * created. The binding reports an unresolvable workspace with its generic configuration error,
 * so that one case is split out into the existing safe workspace code; every other failure keeps
 * the fixed configuration error. History for such a session stays unavailable until the
 * workspace returns (not degraded here).
 */
export async function preparePersistedBinding(
  extensions: Extensions,
  workspace: string,
): Promise<ExtensionBinding> {
  try {
    return await extensions.prepare(workspace);
  } catch {
    if (!(await workspaceResolves(workspace)))
      throw new PiscesError("session.invalid_workspace", "Invalid workspace");
    serviceFailure();
  }
}

function resolveNames(names: readonly EntryName[]): EntryName[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (!ENTRY_NAME.test(name))
      throw new PiscesError("queue.invalid_control", "Invalid extension name");
    if (seen.has(name)) throw new PiscesError("queue.duplicate_name", "Duplicate extension name");
    seen.add(name);
  }
  return [...names];
}

/**
 * Pure orchestration for a new session: resolve workspace/provider/model/extensions and
 * freeze one binding. Allocates no session id, writes nothing, and runs no plugin code.
 * `defaultWorkspace` comes only from the global layer; an explicit workspace always wins.
 * provider/model are an explicit pair, or the configured pair; a lone value never borrows
 * the other from configuration. An explicit extensions array (including `[]`) replaces the
 * configured list, so `[]` disables every default.
 */
export async function prepareExtensionSession(
  extensions: Extensions,
  params: CreateSessionParams,
  validateWorkspace: (workspace: string) => Promise<boolean>,
): Promise<PreparedExtensionSession> {
  const global = await readGlobalDefaults(extensions);
  const workspace = params.workspace ?? global.defaultWorkspace;
  if (workspace === undefined)
    throw new PiscesError("session.workspace_required", "Workspace is required");
  if (!(await validateWorkspace(workspace)))
    throw new PiscesError("session.invalid_workspace", "Invalid workspace");

  const binding = await prepareBinding(extensions, workspace);

  const hasProvider = params.provider !== undefined;
  const hasModel = params.model !== undefined;
  if (hasProvider !== hasModel)
    throw new PiscesError("session.model_required", "Provider and model are required");
  const provider = hasProvider ? params.provider : binding.config.defaultProvider;
  const model = hasModel ? params.model : binding.config.defaultModel;
  if (provider === undefined || model === undefined)
    throw new PiscesError("session.model_required", "Provider and model are required");

  return {
    binding,
    workspace: binding.workspace,
    provider,
    model,
    extensions: resolveNames(params.extensions ?? binding.config.extensions ?? []),
  };
}

/**
 * Narrows the published `string | undefined` pair: `prepareExtensionSession` throws
 * `session.model_required` instead of resolving a lone provider or model.
 */
export function resolvedModelPair(prepared: PreparedExtensionSession): {
  provider: string;
  model: string;
} {
  return { provider: prepared.provider as string, model: prepared.model as string };
}

/** Validates and enriches one batch against a frozen binding, atomically and in memory. */
export function enrichForBinding(
  binding: ExtensionBinding,
  view: SelectionView,
  pending: readonly QueueEntryInput[],
  inputs: readonly unknown[],
): QueueEntryInput[] {
  try {
    return enrichQueueEntries(binding, view, pending, inputs);
  } catch (error) {
    enrichmentFailure(error);
  }
}

/** The single declaration that a non-empty initial selection contributes to the queue. */
export function initialDeclarationEntries(
  binding: ExtensionBinding,
  extensions: readonly EntryName[],
): QueueEntryInput[] {
  if (extensions.length === 0) return [];
  return enrichForBinding(
    binding,
    replaySelection([]),
    [],
    [
      {
        kind: "control",
        role: "declaration",
        source: CREATE_ENTRY_SOURCE,
        content: [{ type: "text", text: JSON.stringify({ toggle: [...extensions] }) }],
      },
    ],
  );
}

import { dirname, resolve } from "node:path";
import { PiscesError } from "@pisces/core";
import {
  type ExtensionListingEntry,
  type ListExtensionsOptions,
  listExtensions,
} from "@pisces/daemon";
import { type CommandIo, processIo } from "./commands.js";

/**
 * The `extensions list` command.
 *
 * Discovery is the daemon's own pass: it reads manifests, sidecars and skill
 * bodies only, never importing tool, wrapper or context modules and never
 * reading credentials. Issues are reported on stderr with a fixed label; they
 * do not change the exit code. A malformed config layer fails the whole command
 * before anything is printed.
 */

const MESSAGES: Readonly<Record<string, string>> = {
  "config.invalid": "Invalid extension configuration",
  "config.unknown_key": "Unknown extension configuration key",
};

const FALLBACK_MESSAGE = MESSAGES["config.invalid"] ?? "";

export interface ExtensionsListOptions {
  /** Resolved global configuration file; its directory holds `extensions/`. */
  configPath: string;
  /** Workspace directory; the workspace source is only listed when given. */
  workspace?: string;
  json?: boolean;
  io?: CommandIo;
  /** Overrides the built-in directory; a test seam, not exposed on the CLI. */
  builtinDir?: string;
}

/** Fixed-width columns keep the human listing readable without extra formatting. */
function humanRows(entries: readonly ExtensionListingEntry[]): string[] {
  let nameWidth = 0;
  let typeWidth = 0;
  for (const entry of entries) {
    nameWidth = Math.max(nameWidth, entry.name.length);
    typeWidth = Math.max(typeWidth, entry.type.length);
  }
  return entries.map((entry) => {
    // `origin` is the last column, so it needs no padding.
    const head = [entry.name.padEnd(nameWidth), entry.type.padEnd(typeWidth), entry.origin].join(
      " ",
    );
    return entry.description === undefined ? head : `${head} ${entry.description}`;
  });
}

export async function extensionsList(options: ExtensionsListOptions): Promise<number> {
  const io = options.io ?? processIo;

  const request: ListExtensionsOptions = { configDir: dirname(options.configPath) };
  if (options.workspace !== undefined) request.workspace = resolve(options.workspace);
  if (options.builtinDir !== undefined) request.builtinDir = options.builtinDir;

  try {
    const listing = await listExtensions(request);
    for (const issue of listing.issues) io.err(`extensions.invalid: ${issue.source}`);
    if (listing.entries.length === 0) {
      io.out("no extensions");
      return 0;
    }
    if (options.json === true) {
      io.out(JSON.stringify({ entries: listing.entries }));
      return 0;
    }
    for (const row of humanRows(listing.entries)) io.out(row);
    return 0;
  } catch (error) {
    const code = error instanceof PiscesError ? error.code : "config.invalid";
    io.err(`error: ${code}: ${MESSAGES[code] ?? FALLBACK_MESSAGE}`);
    return 2;
  }
}

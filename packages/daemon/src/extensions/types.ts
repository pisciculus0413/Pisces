import type {
  ContentBlock,
  ContextEntries,
  ContextSourceRegistry,
  EntryInfo,
  EntryName,
  JsonObject,
  Skills,
  Tools,
} from "@pisces/core";

export interface ExtensionsOptions {
  configDir: string;
  builtinDir?: string;
}

export interface ExtensionConfig {
  defaults?: { provider: string; model: string };
  defaultWorkspace?: string;
  extensions?: EntryName[];
  entryConfig?: Record<string, JsonObject>;
}

export interface ExtensionIssue {
  code: "extensions.invalid" | "extensions.duplicate" | "extensions.unsupported_contribution";
  source: string;
  name?: EntryName;
}

/** Which discovery source contributed an entry; never part of the public `EntryInfo.source`. */
export type ExtensionOrigin = "builtin" | "config" | "workspace";

export interface ListExtensionsOptions {
  configDir: string;
  /**
   * Exact global config file to read; when absent `<configDir>/config.json` is
   * used. `configDir` still selects `<configDir>/extensions`.
   */
  configPath?: string;
  builtinDir?: string;
  /** Workspace root; when absent the workspace source and layer are not read. */
  workspace?: string;
}

/** Read-only projection of a discovered entry, safe to print. */
export interface ExtensionListingEntry {
  name: EntryName;
  type: EntryInfo["type"];
  origin: ExtensionOrigin;
  description?: string;
}

export interface ExtensionListing {
  entries: ExtensionListingEntry[];
  issues: ExtensionIssue[];
}

export interface WrapperConfigSpec {
  defaults: JsonObject;
  schema: JsonObject;
}

export interface DiscoveredEntry {
  info: EntryInfo;
  origin: ExtensionOrigin;
  packageRoot: string;
  entryPath: string;
  entryDigest: string;
  wrapperConfig?: JsonObject;
  wrapperConfigSpec?: WrapperConfigSpec;
  skillContent?: ContentBlock[];
}

export interface Inventory {
  hash: string;
  entries: EntryInfo[];
}

export interface DiscoveryResult {
  inventory: Inventory;
  records: ReadonlyMap<EntryName, DiscoveredEntry>;
  issues: ExtensionIssue[];
}

/** One frozen per-session view; internal records and loader stay private. */
export interface ExtensionBinding {
  workspace: string;
  config: ExtensionConfig;
  inventory: Inventory;
  issues: readonly ExtensionIssue[];
  entries: ContextEntries;
  skills: Skills;
  sources: ContextSourceRegistry;
  tools: Tools;
}

export interface Extensions {
  readGlobalConfig(): Promise<ExtensionConfig>;
  prepare(workspace: string): Promise<ExtensionBinding>;
}

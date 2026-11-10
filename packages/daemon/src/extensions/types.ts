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

export interface WrapperConfigSpec {
  defaults: JsonObject;
  schema: JsonObject;
}

export interface DiscoveredEntry {
  info: EntryInfo;
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

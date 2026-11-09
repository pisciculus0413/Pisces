import type { ContentBlock, EntryInfo, EntryName, JsonObject } from "@pisces/core";

export interface ExtensionsOptions {
  configDir: string;
  builtinDir?: string;
}

export interface ExtensionConfig {
  defaultWorkspace?: string;
  defaultProvider?: string;
  defaultModel?: string;
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

import type { EntryName, JsonObject } from "@pisces/core";

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

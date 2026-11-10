import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type EntryName, type JsonObject, type JsonValue, PiscesError } from "@pisces/core";
import type { ExtensionConfig } from "./types.js";

const INVALID = "Invalid extension configuration";
const UNKNOWN_KEY = "Unknown extension configuration key";

export type ConfigScope = "global" | "workspace";

const ENTRY_NAME = /^[^#\s]+#[^#\s]+$/u;
// CLI-owned keys are accepted and skipped in the global scope only: the CLI validator owns their
// semantics and the daemon never reads them.
const CLI_KEYS = new Set(["dataDir", "providers", "templatesDir"]);

function invalid(): never {
  throw new PiscesError("config.invalid", INVALID);
}

function unknownKey(): never {
  throw new PiscesError("config.unknown_key", UNKNOWN_KEY);
}

function rethrowKnown(error: unknown): never {
  if (error instanceof PiscesError) throw error;
  invalid();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEntryName = (value: unknown): value is EntryName =>
  typeof value === "string" && ENTRY_NAME.test(value);

const isNotFound = (error: unknown): boolean => isRecord(error) && error.code === "ENOENT";

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyJson(value: unknown): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) invalid();
      return value;
    case "object":
      break;
    default:
      invalid();
  }
  if (Array.isArray(value)) return value.map((item) => copyJson(item));
  if (!isRecord(value)) invalid();
  const result: JsonObject = {};
  for (const key of Object.keys(value)) define(result, key, copyJson(value[key]));
  return result;
}

function parseEntryConfig(value: unknown): Record<string, JsonObject> {
  if (!isRecord(value)) invalid();
  const result: Record<string, JsonObject> = {};
  for (const key of Object.keys(value)) {
    if (!isEntryName(key)) invalid();
    const entry = value[key];
    if (!isRecord(entry)) invalid();
    define(result, key, copyJson(entry));
  }
  return result;
}

function parseDefaults(value: unknown): { provider: string; model: string } {
  if (!isRecord(value)) invalid();
  for (const key of Object.keys(value)) {
    if (key !== "provider" && key !== "model") invalid();
  }
  const provider = value.provider;
  const model = value.model;
  if (typeof provider !== "string" || provider.length === 0) invalid();
  if (typeof model !== "string" || model.length === 0) invalid();
  return { provider, model };
}

function parseLayer(raw: unknown, scope: ConfigScope): ExtensionConfig {
  if (!isRecord(raw)) invalid();
  const config: ExtensionConfig = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (CLI_KEYS.has(key)) {
      if (scope === "global") continue;
      unknownKey();
    }
    if (key === "defaultWorkspace" && scope === "workspace") unknownKey();
    switch (key) {
      case "defaults":
        config.defaults = parseDefaults(value);
        break;
      case "defaultWorkspace":
        if (typeof value !== "string" || !isAbsolute(value)) invalid();
        config.defaultWorkspace = value;
        break;
      case "extensions":
        if (!Array.isArray(value) || !value.every(isEntryName)) invalid();
        config.extensions = [...value];
        break;
      case "entryConfig":
        config.entryConfig = parseEntryConfig(value);
        break;
      default:
        unknownKey();
    }
  }
  return config;
}

/** Pure layer parser shared with the CLI; CLI keys are skipped in the global scope. */
export function parseExtensionConfig(value: unknown, scope: ConfigScope): ExtensionConfig {
  try {
    return parseLayer(value, scope);
  } catch (error) {
    rethrowKnown(error);
  }
}

/** Pure text parser shared with the CLI; malformed JSON is a fixed `config.invalid`. */
export function parseExtensionConfigText(text: string, scope: ConfigScope): ExtensionConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid();
  }
  return parseExtensionConfig(raw, scope);
}

function mergeJson(base: JsonObject, patch: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of Object.keys(base)) define(result, key, copyJson(base[key]));
  for (const key of Object.keys(patch)) {
    const incoming = copyJson(patch[key]);
    const previous = Object.getOwnPropertyDescriptor(result, key)?.value;
    if (isRecord(previous) && isRecord(incoming)) {
      define(result, key, mergeJson(previous as JsonObject, incoming as JsonObject));
      continue;
    }
    define(result, key, incoming);
  }
  return result;
}

export async function readConfigLayer(path: string, scope: ConfigScope): Promise<ExtensionConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    invalid();
  }
  try {
    return parseExtensionConfigText(text, scope);
  } catch (error) {
    rethrowKnown(error);
  }
}

export function mergeConfigLayers(layers: readonly ExtensionConfig[]): ExtensionConfig {
  try {
    return mergeLayers(layers);
  } catch (error) {
    rethrowKnown(error);
  }
}

function mergeLayers(layers: readonly ExtensionConfig[]): ExtensionConfig {
  const result: ExtensionConfig = {};
  const entries = new Map<string, JsonObject>();
  let hasEntryConfig = false;
  for (const layer of layers) {
    if (layer.defaultWorkspace !== undefined) result.defaultWorkspace = layer.defaultWorkspace;
    if (layer.defaults !== undefined) result.defaults = { ...layer.defaults };
    if (layer.extensions !== undefined) result.extensions = [...layer.extensions];
    if (layer.entryConfig === undefined) continue;
    hasEntryConfig = true;
    for (const key of Object.keys(layer.entryConfig)) {
      const incoming = layer.entryConfig[key];
      if (incoming === undefined) invalid();
      const previous = entries.get(key);
      if (previous === undefined) {
        entries.set(key, copyJson(incoming) as JsonObject);
        continue;
      }
      entries.set(key, mergeJson(previous, incoming));
    }
  }
  if (hasEntryConfig) {
    const merged: Record<string, JsonObject> = {};
    for (const [key, value] of entries) define(merged, key, value);
    result.entryConfig = merged;
  }
  return result;
}

export async function readGlobalConfig(configDir: string): Promise<ExtensionConfig> {
  return readConfigLayer(join(configDir, "config.json"), "global");
}

export async function readWorkspaceConfig(
  configDir: string,
  workspace: string,
  globalConfigPath?: string,
): Promise<ExtensionConfig> {
  const global =
    globalConfigPath === undefined
      ? await readGlobalConfig(configDir)
      : await readConfigLayer(globalConfigPath, "global");
  const local = await readConfigLayer(join(workspace, ".pisces", "config.json"), "workspace");
  return mergeConfigLayers([global, local]);
}

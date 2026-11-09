import type { ContentBlock, EntryName, JsonObject, JsonValue } from "@pisces/core";
import { Ajv } from "ajv";
import { mergeConfigLayers } from "./config.js";
import { canonicalJson, sha256 } from "./hash.js";
import type { WrapperConfigSpec } from "./types.js";

export type EntryKind = "tool" | "wrapper" | "skill" | "context";

export interface ClientContribution {
  id: string;
  entry: string;
}

export interface PackageManifest {
  tools?: string[];
  wrappers?: string[];
  skills?: string[];
  context?: string[];
  providers?: string[];
  clients?: ClientContribution[];
}

export interface EntrySidecar {
  name?: string;
  description?: string;
  parameters?: JsonObject;
  config?: WrapperConfigSpec;
}

export const SIDECAR_SUFFIX = ".meta.json";
export const SKILL_FILE = "SKILL.md";

const MANIFEST_KEYS = new Set(["tools", "wrappers", "skills", "context", "providers", "clients"]);
const SIDECAR_KEYS = new Set(["name", "description", "parameters", "config"]);
const CONFIG_KEYS = new Set(["defaults", "schema"]);
const SCRIPT_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const PACKAGE_NAME = /^(?:@[^/\s#]+\/)?[^/\s#]+$/u;
const NAME_PART = /^[^#\s]+$/u;

// Fixed options: draft-07 via the default meta-schema, no remote schema loading and no
// executable validators. Compilation failures are treated as invalid extension metadata.
// A fresh instance per compilation keeps no schema cache alive across sessions.
const AJV_OPTIONS = { allErrors: false, strict: false, validateFormats: false } as const;

export class InvalidMetadataError extends Error {
  constructor() {
    super("Invalid extension metadata");
    this.name = "InvalidMetadataError";
  }
}

function invalid(): never {
  throw new InvalidMetadataError();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isEntryNamePart(value: string): boolean {
  return NAME_PART.test(value);
}

export function isValidPackageName(value: string): boolean {
  return PACKAGE_NAME.test(value) && !value.startsWith(".");
}

export function isScriptFile(name: string): boolean {
  return SCRIPT_FILE.test(name) && !name.endsWith(".d.ts");
}

export function entryBaseName(kind: EntryKind, fileName: string): string {
  const base = kind === "skill" ? fileName : fileName.replace(SCRIPT_FILE, "");
  if (base.length === 0 || !isEntryNamePart(base)) invalid();
  return base;
}

export function packageEntryName(packageName: string, part: string): EntryName {
  if (!isValidPackageName(packageName) || !isEntryNamePart(part)) invalid();
  return `${packageName}#${part}` as EntryName;
}

export function parsePackageJson(text: string): { name: string; manifest?: PackageManifest } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!isRecord(raw)) invalid();
  const name = raw.name;
  if (typeof name !== "string" || !isValidPackageName(name)) invalid();
  if (!Object.hasOwn(raw, "pisces")) return { name };
  return { name, manifest: parseManifest(raw.pisces) };
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) invalid();
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function parseClients(value: unknown): ClientContribution[] {
  if (!Array.isArray(value)) invalid();
  const result: ClientContribution[] = [];
  for (const item of value) {
    if (!isRecord(item)) invalid();
    for (const key of Object.keys(item)) {
      if (key !== "id" && key !== "entry") invalid();
    }
    const { id, entry } = item;
    if (typeof id !== "string" || id.length === 0) invalid();
    if (typeof entry !== "string" || entry.length === 0) invalid();
    result.push({ id, entry });
  }
  return result;
}

export function parseManifest(value: unknown): PackageManifest {
  if (!isRecord(value)) invalid();
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) invalid();
  }
  const manifest: PackageManifest = {};
  if (Object.hasOwn(value, "tools")) manifest.tools = parseStringArray(value.tools);
  if (Object.hasOwn(value, "wrappers")) manifest.wrappers = parseStringArray(value.wrappers);
  if (Object.hasOwn(value, "skills")) manifest.skills = parseStringArray(value.skills);
  if (Object.hasOwn(value, "context")) manifest.context = parseStringArray(value.context);
  if (Object.hasOwn(value, "providers")) manifest.providers = parseStringArray(value.providers);
  if (Object.hasOwn(value, "clients")) manifest.clients = parseClients(value.clients);
  return manifest;
}

export function parseSidecar(text: string, kind: EntryKind): EntrySidecar {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid();
  }
  if (!isRecord(raw)) invalid();
  for (const key of Object.keys(raw)) {
    if (!SIDECAR_KEYS.has(key)) invalid();
  }
  const sidecar: EntrySidecar = {};
  if (Object.hasOwn(raw, "name")) {
    const name = raw.name;
    if (typeof name !== "string" || !isEntryNamePart(name)) invalid();
    sidecar.name = name;
  }
  if (Object.hasOwn(raw, "description")) {
    if (typeof raw.description !== "string") invalid();
    sidecar.description = raw.description;
  }
  if (Object.hasOwn(raw, "parameters")) {
    if (kind !== "tool" && kind !== "wrapper") invalid();
    if (!isRecord(raw.parameters)) invalid();
    sidecar.parameters = structuredClone(raw.parameters) as JsonObject;
  }
  if (Object.hasOwn(raw, "config")) {
    if (kind !== "wrapper") invalid();
    sidecar.config = parseWrapperConfig(raw.config);
  }
  return sidecar;
}

function parseWrapperConfig(value: unknown): WrapperConfigSpec {
  if (!isRecord(value)) invalid();
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) invalid();
  }
  if (!Object.hasOwn(value, "defaults") || !Object.hasOwn(value, "schema")) invalid();
  const { defaults, schema } = value;
  if (!isRecord(defaults) || !isRecord(schema)) invalid();
  return {
    defaults: structuredClone(defaults) as JsonObject,
    schema: structuredClone(schema) as JsonObject,
  };
}

export function normalizeWrapperSpec(config: WrapperConfigSpec | undefined): WrapperConfigSpec {
  if (config === undefined) return { defaults: {}, schema: {} };
  return {
    defaults: structuredClone(config.defaults),
    schema: structuredClone(config.schema),
  };
}

export type WrapperValidator = (value: JsonObject) => boolean;

export function compileWrapperSchema(schema: JsonObject): WrapperValidator | undefined {
  try {
    const validate = new Ajv(AJV_OPTIONS).compile(schema);
    return (value: JsonObject) => validate(value) === true;
  } catch {
    return undefined;
  }
}

export function mergeWrapperConfig(defaults: JsonObject, override: JsonObject): JsonObject {
  const merged = mergeConfigLayers([
    { entryConfig: { "wrapper#config": defaults } },
    { entryConfig: { "wrapper#config": override } },
  ]);
  return merged.entryConfig?.["wrapper#config"] ?? {};
}

function definitionFields(
  name: EntryName,
  kind: "tool" | "wrapper",
  description: string,
  parameters: JsonObject,
  entryDigest: string,
): JsonObject {
  const fields: JsonObject = {
    description,
    entry: entryDigest,
    kind,
    name,
    parameters: structuredClone(parameters),
  };
  return fields;
}

export function definitionHashFor(
  name: EntryName,
  kind: "tool" | "wrapper",
  description: string,
  parameters: JsonObject,
  entryDigest: string,
): string {
  return sha256(canonicalJson(definitionFields(name, kind, description, parameters, entryDigest)));
}

export interface InventoryDescriptor {
  name: EntryName;
  type: EntryKind;
  digest: string;
  configHash?: string;
}

export function inventoryHashFor(descriptors: readonly InventoryDescriptor[]): string {
  const items: JsonValue[] = descriptors.map((descriptor) => {
    const item: JsonObject = {
      digest: descriptor.digest,
      name: descriptor.name,
      type: descriptor.type,
    };
    if (descriptor.configHash !== undefined) item.configHash = descriptor.configHash;
    return item;
  });
  return sha256(canonicalJson(items));
}

export function configHashFor(config: JsonObject): string {
  return sha256(canonicalJson(config));
}

export function skillContentFor(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (value instanceof Map) {
    // Maps cannot be frozen against writes; callers receive a fresh copy instead.
    return value;
  } else {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

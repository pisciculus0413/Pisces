import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PiscesError } from "@pisces/core";

export interface CliModelConfig {
  id: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
}

export interface CliProviderConfig {
  id: string;
  baseUrl: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  models: CliModelConfig[];
}

export interface CliConfig {
  dataDir: string;
  providers: CliProviderConfig[];
  defaults?: { provider: string; model: string };
  /** Absolute directory holding `<id>.json` templates; absent means no templates. */
  templatesDir?: string;
}

const INVALID_MESSAGE = "Invalid configuration";
const CONFIG_KEYS = ["dataDir", "providers", "defaults", "templatesDir"] as const;
const PROVIDER_KEYS = ["id", "baseUrl", "apiKeyEnv", "headers", "models"] as const;
const MODEL_KEYS = ["id", "contextWindow", "maxOutput", "modalities"] as const;
const DEFAULTS_KEYS = ["provider", "model"] as const;
const MODALITIES = ["text", "image", "audio"] as const;
const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type UnknownRecord = Record<string, unknown>;
type Modality = (typeof MODALITIES)[number];

function invalid(): never {
  throw new PiscesError("config.invalid", INVALID_MESSAGE);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: UnknownRecord, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid();
  }
}

function assertUnique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) invalid();
}

function parseIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") invalid();
  return value;
}

function parseDataDir(value: unknown): string {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) invalid();
  return value;
}

function isModality(value: unknown): value is Modality {
  return typeof value === "string" && (MODALITIES as readonly string[]).includes(value);
}

function parseModalities(value: unknown): Modality[] {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const modalities: Modality[] = [];
  for (const item of value) {
    if (!isModality(item)) invalid();
    modalities.push(item);
  }
  return modalities;
}

function parseLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) invalid();
  return value;
}

function parseBaseUrl(value: unknown): string {
  if (typeof value !== "string") invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") invalid();
  if (url.hostname === "") invalid();
  if (url.username !== "" || url.password !== "") invalid();
  if (url.search !== "" || url.hash !== "") invalid();
  return value;
}

function parseApiKeyEnv(value: unknown): string {
  if (typeof value !== "string" || !API_KEY_ENV_PATTERN.test(value)) invalid();
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) invalid();
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (key.trim() === "" || hasControlCharacter(key)) invalid();
    if (typeof header !== "string" || hasControlCharacter(header)) invalid();
    headers[key] = header;
  }
  return headers;
}

function parseModel(value: unknown): CliModelConfig {
  if (!isRecord(value)) invalid();
  assertKeys(value, MODEL_KEYS);
  return {
    id: parseIdentifier(value.id),
    contextWindow: parseLimit(value.contextWindow),
    maxOutput: parseLimit(value.maxOutput),
    modalities: parseModalities(value.modalities),
  };
}

function parseModels(value: unknown): CliModelConfig[] {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const models = value.map(parseModel);
  assertUnique(models.map((model) => model.id));
  return models;
}

function parseProvider(value: unknown): CliProviderConfig {
  if (!isRecord(value)) invalid();
  assertKeys(value, PROVIDER_KEYS);
  const provider: CliProviderConfig = {
    id: parseIdentifier(value.id),
    baseUrl: parseBaseUrl(value.baseUrl),
    apiKeyEnv: parseApiKeyEnv(value.apiKeyEnv),
    models: parseModels(value.models),
  };
  if (value.headers !== undefined) provider.headers = parseHeaders(value.headers);
  return provider;
}

function parseProviders(value: unknown): CliProviderConfig[] {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const providers = value.map(parseProvider);
  assertUnique(providers.map((provider) => provider.id));
  return providers;
}

function parseDefaults(
  value: unknown,
  providers: readonly CliProviderConfig[],
): { provider: string; model: string } {
  if (!isRecord(value)) invalid();
  assertKeys(value, DEFAULTS_KEYS);
  const providerId = parseIdentifier(value.provider);
  const modelId = parseIdentifier(value.model);
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) invalid();
  if (!provider.models.some((model) => model.id === modelId)) invalid();
  return { provider: providerId, model: modelId };
}

function homeDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (home === undefined || home === "") invalid();
  return home;
}

function expandHome(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value !== "string") return value;
  if (value !== "~" && !value.startsWith("~/")) return value;
  const home = homeDir(env);
  return value === "~" ? home : join(home, value.slice(2));
}

function applyEnvironmentDefaults(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (!isRecord(value)) return value;
  const dataDir =
    value.dataDir === undefined ? defaultDataDir(env) : expandHome(value.dataDir, env);
  const templatesDir =
    value.templatesDir === undefined ? {} : { templatesDir: expandHome(value.templatesDir, env) };
  return { ...value, dataDir, ...templatesDir };
}

export function defaultDataDir(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME;
  if (stateHome === undefined || stateHome === "") {
    return join(homeDir(env), ".local", "state", "pisces");
  }
  return join(stateHome, "pisces");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME;
  if (configHome === undefined || configHome === "") {
    return join(homeDir(env), ".config", "pisces", "config.json");
  }
  return join(configHome, "pisces", "config.json");
}

export function parseConfig(value: unknown): CliConfig {
  if (!isRecord(value)) invalid();
  assertKeys(value, CONFIG_KEYS);
  const providers = parseProviders(value.providers);
  const config: CliConfig = {
    dataDir: parseDataDir(value.dataDir),
    providers,
  };
  if (value.defaults !== undefined) config.defaults = parseDefaults(value.defaults, providers);
  if (value.templatesDir !== undefined) config.templatesDir = parseDataDir(value.templatesDir);
  return config;
}

async function readConfigText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    invalid();
  }
}

export async function loadConfig(path: string): Promise<CliConfig> {
  const text = await readConfigText(path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  return parseConfig(applyEnvironmentDefaults(value, process.env));
}

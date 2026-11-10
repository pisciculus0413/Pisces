import type { ModelInfo, ProviderInfo } from "@pisces/daemon";
import { type Client, ClientError, connectClient, UNREACHABLE_MESSAGE } from "./client.js";
import { type CommandIo, processIo } from "./commands.js";
import { loadConfig } from "./config.js";
import { socketPathFor } from "./lifecycle.js";

/**
 * The read-only `provider list` and `models list` commands.
 *
 * Both resolve the data directory exactly like the lifecycle commands, open
 * one short-lived protocol connection, send `provider.list` and close. No local
 * provider definition is read and no credential, header, base URL or pricing
 * value reaches human output; `pricing` appears only in JSON output (`provider
 * list --json` raw echo and `models list --json`), never in human output.
 * Provider definitions are the daemon's view, so `ready` and the model list
 * are never computed here.
 */

const CONFIG_MESSAGE = "Invalid configuration";
const PROTOCOL_MESSAGE = "Invalid response from daemon";
const PROVIDER_NOT_FOUND_MESSAGE = "Unknown provider";

const MODALITIES = ["text", "image", "audio"] as const;
type Modality = (typeof MODALITIES)[number];

export interface ProvidersClient {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  close(): void;
}

/** The only production seam: tests inject a fake client factory. */
export interface ProvidersDeps {
  connect(socketPath: string, timeoutMs?: number): Promise<ProvidersClient>;
}

export const productionProvidersDeps: ProvidersDeps = {
  connect: (socketPath, timeoutMs) => connectClient(socketPath, timeoutMs),
};

export interface ProvidersOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
  json?: boolean;
}

export interface ModelsOptions extends ProvidersOptions {
  provider?: string;
}

type FlattenedModel = ModelInfo & { provider: string };

function invalidResponse(): never {
  throw new ClientError("client.protocol", PROTOCOL_MESSAGE);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isNonEmptyText = (value: unknown): value is string => isText(value) && value.trim() !== "";

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isModality = (value: unknown): value is Modality =>
  (MODALITIES as readonly unknown[]).includes(value);

function parsePricing(value: unknown): NonNullable<ModelInfo["pricing"]> {
  if (!isRecord(value)) invalidResponse();
  const { input, output, currency } = value;
  if (!isNonNegativeFinite(input) || !isNonNegativeFinite(output) || !isNonEmptyText(currency)) {
    invalidResponse();
  }
  return { input, output, currency };
}

/** Builds a fresh model so unexpected daemon fields can never reach output. */
function parseModel(value: unknown): ModelInfo {
  if (!isRecord(value)) invalidResponse();
  const { id, contextWindow, maxOutput, modalities } = value;
  if (
    !isNonEmptyText(id) ||
    !isPositiveInteger(contextWindow) ||
    !isPositiveInteger(maxOutput) ||
    !Array.isArray(modalities)
  ) {
    invalidResponse();
  }
  const seen = new Set<Modality>();
  const parsed: Modality[] = [];
  for (const modality of modalities) {
    if (!isModality(modality) || seen.has(modality)) invalidResponse();
    seen.add(modality);
    parsed.push(modality);
  }
  const model: ModelInfo = { id, contextWindow, maxOutput, modalities: parsed };
  if (value.pricing !== undefined) model.pricing = parsePricing(value.pricing);
  return model;
}

function parseProvider(value: unknown): ProviderInfo {
  if (!isRecord(value)) invalidResponse();
  const { id, ready, models } = value;
  if (!isNonEmptyText(id) || typeof ready !== "boolean" || !Array.isArray(models)) {
    invalidResponse();
  }
  return { id, ready, models: models.map(parseModel) };
}

function parseProviders(result: unknown): ProviderInfo[] {
  if (!isRecord(result) || !Array.isArray(result.providers)) invalidResponse();
  return result.providers.map(parseProvider);
}

/** Resolves `dataDir` the same way lifecycle commands do, or prints `config.invalid`. */
async function resolveDataDir(
  options: ProvidersOptions,
  io: CommandIo,
): Promise<string | undefined> {
  let dataDir: string;
  try {
    const config = await loadConfig(options.configPath);
    dataDir = options.dataDir ?? config.dataDir;
  } catch {
    io.err(`error: config.invalid: ${CONFIG_MESSAGE}`);
    return undefined;
  }
  return dataDir;
}

async function withClient(
  options: ProvidersOptions,
  deps: ProvidersDeps,
  run: (client: ProvidersClient, io: CommandIo) => Promise<number>,
): Promise<number> {
  const io = options.io ?? processIo;
  const dataDir = await resolveDataDir(options, io);
  if (dataDir === undefined) return 2;

  let client: Client;
  try {
    client = await deps.connect(socketPathFor(dataDir));
  } catch {
    io.err(`error: daemon.unreachable: ${UNREACHABLE_MESSAGE}`);
    return 1;
  }

  try {
    return await run(client, io);
  } catch (error) {
    if (error instanceof ClientError) {
      io.err(`error: ${error.code}: ${error.message}`);
    } else {
      io.err(`error: client.protocol: ${PROTOCOL_MESSAGE}`);
    }
    return 1;
  } finally {
    client.close();
  }
}

/** Lexicographic provider order; each provider keeps its daemon model order. */
function flattenModels(providers: readonly ProviderInfo[]): FlattenedModel[] {
  const sorted = [...providers].sort((left, right) => {
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
  const models: FlattenedModel[] = [];
  for (const provider of sorted) {
    for (const model of provider.models) models.push({ provider: provider.id, ...model });
  }
  return models;
}

function selectProvider(providers: readonly ProviderInfo[], providerId: string): ProviderInfo[] {
  const matching = providers.filter((provider) => provider.id === providerId);
  if (matching.length === 0) {
    throw new ClientError("provider.not_found", PROVIDER_NOT_FOUND_MESSAGE);
  }
  return matching;
}

function modelLine(model: FlattenedModel): string {
  return `${model.provider}/${model.id}  context=${model.contextWindow}  maxOutput=${model.maxOutput}  modalities=${model.modalities.join(",")}`;
}

export async function providerList(
  options: ProvidersOptions,
  deps: ProvidersDeps = productionProvidersDeps,
): Promise<number> {
  return await withClient(options, deps, async (client, io) => {
    const result = await client.request("provider.list", {});
    if (options.json === true) {
      io.out(JSON.stringify(result));
      return 0;
    }
    for (const provider of parseProviders(result)) {
      const state = provider.ready ? "ready" : "unready";
      io.out(`${provider.id}  ${state}  models=${provider.models.length}`);
    }
    return 0;
  });
}

export async function modelsList(
  options: ModelsOptions,
  deps: ProvidersDeps = productionProvidersDeps,
): Promise<number> {
  return await withClient(options, deps, async (client, io) => {
    const result = await client.request("provider.list", {});
    // Validation is unconditional: a malformed result must never be printed,
    // including as JSON, and a failed filter must produce no partial output.
    const providers = parseProviders(result);
    const selected =
      options.provider === undefined ? providers : selectProvider(providers, options.provider);
    const models = flattenModels(selected);
    if (options.json === true) {
      io.out(JSON.stringify({ models }));
      return 0;
    }
    if (models.length === 0) {
      io.out("no models");
      return 0;
    }
    for (const model of models) io.out(modelLine(model));
    return 0;
  });
}

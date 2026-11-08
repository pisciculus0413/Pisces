import type { LlmAdapter } from "../loop/types.js";
import { PiscesError } from "../types.js";
import type {
  LlmAdapterFactory,
  ModelDescriptor,
  ProviderDescriptor,
  ProviderManagement,
  ProviderSelection,
} from "./types.js";

const INVALID_CONFIGURATION = "Invalid provider configuration";

function invalid(): never {
  throw new PiscesError("config.invalid", INVALID_CONFIGURATION);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateBaseUrl(value: unknown): void {
  if (!isNonEmptyString(value)) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid();
}

function validateHeaders(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) invalid();
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      !isNonEmptyString(name) ||
      typeof headerValue !== "string" ||
      /[\r\n]/.test(name) ||
      /[\r\n]/.test(headerValue)
    )
      invalid();
  }
}

function validateModel(value: unknown, seenIds: Set<string>): void {
  if (!isRecord(value)) invalid();
  if (!isNonEmptyString(value.id) || seenIds.has(value.id)) invalid();
  seenIds.add(value.id);
  if (!isPositiveFinite(value.contextWindow) || !isPositiveFinite(value.maxOutput)) invalid();
  if (!Array.isArray(value.modalities)) invalid();
  const modalities = new Set<string>();
  for (const modality of value.modalities) {
    if (modality !== "text" && modality !== "image" && modality !== "audio") invalid();
    if (modalities.has(modality)) invalid();
    modalities.add(modality);
  }
  if (value.pricing !== undefined) {
    if (!isRecord(value.pricing)) invalid();
    if (
      !isNonNegativeFinite(value.pricing.input) ||
      !isNonNegativeFinite(value.pricing.output) ||
      !isNonEmptyString(value.pricing.currency)
    )
      invalid();
  }
}

function validateDescriptor(value: unknown): asserts value is ProviderDescriptor {
  if (!isRecord(value)) invalid();
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.dialect)) invalid();
  validateBaseUrl(value.baseUrl);
  if (!isRecord(value.auth)) invalid();
  if (
    (value.auth.type !== "apiKey" && value.auth.type !== "oauth") ||
    !isNonEmptyString(value.auth.credentialRef)
  )
    invalid();
  validateHeaders(value.headers);
  if (!Array.isArray(value.models)) invalid();
  const seenIds = new Set<string>();
  for (const model of value.models) validateModel(model, seenIds);
}

function cloneModel(value: ModelDescriptor): ModelDescriptor {
  return {
    id: value.id,
    contextWindow: value.contextWindow,
    maxOutput: value.maxOutput,
    modalities: [...value.modalities],
    ...(value.pricing
      ? {
          pricing: {
            input: value.pricing.input,
            output: value.pricing.output,
            currency: value.pricing.currency,
          },
        }
      : {}),
  };
}

function cloneDescriptor(value: ProviderDescriptor): ProviderDescriptor {
  return {
    id: value.id,
    dialect: value.dialect,
    baseUrl: value.baseUrl,
    auth: { ...value.auth },
    ...(value.headers ? { headers: { ...value.headers } } : {}),
    models: value.models.map(cloneModel),
  };
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedCloneDescriptor(value: ProviderDescriptor): ProviderDescriptor {
  const clone = cloneDescriptor(value);
  clone.models.sort((left, right) => compareNames(left.id, right.id));
  return clone;
}

function validateAdapter(value: unknown, dialect: string): asserts value is LlmAdapter {
  if (!isRecord(value)) invalid();
  if (
    !isNonEmptyString(value.dialect) ||
    value.dialect !== dialect ||
    typeof value.buildRequest !== "function" ||
    typeof value.parseChunk !== "function"
  )
    invalid();
}

export function createProviderManagement(): ProviderManagement {
  const descriptors = new Map<string, ProviderDescriptor>();
  const dialects = new Map<string, LlmAdapterFactory>();

  return {
    registerProvider(value) {
      validateDescriptor(value);
      if (descriptors.has(value.id)) invalid();
      descriptors.set(value.id, cloneDescriptor(value));
    },

    registerDialect(name, factory) {
      if (!isNonEmptyString(name) || typeof factory !== "function" || dialects.has(name)) invalid();
      dialects.set(name, factory);
    },

    get(providerId) {
      const descriptor = descriptors.get(providerId);
      return descriptor ? sortedCloneDescriptor(descriptor) : undefined;
    },

    select(providerId, modelId): ProviderSelection | undefined {
      const descriptor = descriptors.get(providerId);
      if (!descriptor) return undefined;
      const model = descriptor.models.find((candidate) => candidate.id === modelId);
      if (!model) return undefined;
      return {
        provider: sortedCloneDescriptor(descriptor),
        model: cloneModel(model),
      };
    },

    createAdapter(providerId): LlmAdapter {
      const descriptor = descriptors.get(providerId);
      if (!descriptor) invalid();
      const factory = dialects.get(descriptor.dialect);
      if (!factory) invalid();
      try {
        const adapter: unknown = factory(cloneDescriptor(descriptor));
        validateAdapter(adapter, descriptor.dialect);
        return adapter;
      } catch {
        invalid();
      }
    },

    list() {
      return [...descriptors.values()]
        .sort((left, right) => compareNames(left.id, right.id))
        .map(sortedCloneDescriptor);
    },
  };
}

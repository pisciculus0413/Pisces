import type { LlmAdapter } from "../loop/types.js";

export interface ModelDescriptor {
  id: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
  pricing?: {
    input: number;
    output: number;
    currency: string;
  };
}

export interface ProviderDescriptor {
  id: string;
  dialect: string;
  baseUrl: string;
  auth: {
    type: "apiKey" | "oauth";
    credentialRef: string;
  };
  headers?: Record<string, string>;
  models: ModelDescriptor[];
}

export interface Credential {
  type: "apiKey" | "oauth";
  value: string;
  expiresAt?: string;
}

export interface Credentials {
  get(credentialRef: string): Promise<Credential | undefined>;
  refresh(credentialRef: string): Promise<Credential>;
}

export interface ProviderSelection {
  provider: ProviderDescriptor;
  model: ModelDescriptor;
}

export type LlmAdapterFactory = (descriptor: ProviderDescriptor) => LlmAdapter;

export interface ProviderManagement {
  registerProvider(descriptor: ProviderDescriptor): void;
  registerDialect(name: string, factory: LlmAdapterFactory): void;
  get(providerId: string): ProviderDescriptor | undefined;
  select(providerId: string, modelId: string): ProviderSelection | undefined;
  createAdapter(providerId: string): LlmAdapter;
  list(): ProviderDescriptor[];
}

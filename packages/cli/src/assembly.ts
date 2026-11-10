import {
  createProviderManagement,
  openAiChatAdapterFactory,
  type ProviderDescriptor,
  type ProviderManagement,
} from "@pisces/core";
import { createProviderHost, type StartDaemonOptions } from "@pisces/daemon";
import type { CliConfig, CliProviderConfig } from "./config.js";
import { createEnvCredentials } from "./credentials.js";

/** The CLI exposes exactly one wire dialect; it is not configurable. */
const DIALECT = "openai-chat";

function toDescriptor(provider: CliProviderConfig): ProviderDescriptor {
  return {
    id: provider.id,
    dialect: DIALECT,
    baseUrl: provider.baseUrl,
    auth: { type: "apiKey", credentialRef: provider.id },
    ...(provider.headers ? { headers: { ...provider.headers } } : {}),
    models: provider.models.map((model) => ({
      id: model.id,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
      modalities: [...model.modalities],
    })),
  };
}

export function buildProviders(config: CliConfig): ProviderManagement {
  const providers = createProviderManagement();
  providers.registerDialect(DIALECT, openAiChatAdapterFactory);
  for (const provider of config.providers) providers.registerProvider(toDescriptor(provider));
  return providers;
}

export function buildDaemonOptions(
  config: CliConfig,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  templatesDir: string | undefined = config.templatesDir,
): StartDaemonOptions {
  const providers = buildProviders(config);
  const credentials = createEnvCredentials(config, env);
  return {
    dataDir,
    providers,
    providerHost: createProviderHost({ providers, credentials }),
    ...(config.defaults ? { defaults: config.defaults } : {}),
    ...(templatesDir !== undefined ? { templates: { configDir: templatesDir } } : {}),
  };
}

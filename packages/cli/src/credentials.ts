import { type Credential, type Credentials, PiscesError } from "@pisces/core";
import type { CliConfig, CliProviderConfig } from "./config.js";

/** Fixed code: the environment is the only credential source, so refresh cannot succeed. */
const REFRESH_FAILURE_CODE = "provider.credentials_unavailable";
const REFRESH_FAILURE_MESSAGE = "Credentials could not be refreshed";

/**
 * Credentials backed exclusively by the environment variable named in the config.
 *
 * The environment is an explicit parameter so callers control what the child sees;
 * no lookup ever touches `process.env` here.
 */
export function createEnvCredentials(config: CliConfig, env: NodeJS.ProcessEnv): Credentials {
  const providers = new Map<string, CliProviderConfig>();
  for (const provider of config.providers) providers.set(provider.id, provider);

  return {
    async get(credentialRef): Promise<Credential | undefined> {
      const provider = providers.get(credentialRef);
      if (provider === undefined) return undefined;
      const value = env[provider.apiKeyEnv];
      if (value === undefined || value === "") return undefined;
      return { type: "apiKey", value };
    },

    async refresh(): Promise<Credential> {
      throw new PiscesError(REFRESH_FAILURE_CODE, REFRESH_FAILURE_MESSAGE);
    },
  };
}

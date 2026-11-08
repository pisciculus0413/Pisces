import {
  type Credential,
  type Credentials,
  type ExecuteProvider,
  PiscesError,
  type ProviderDescriptor,
  type ProviderManagement,
  type WireRequest,
} from "@pisces/core";
import { parseSseStream } from "./sse.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

const INVALID_CONFIGURATION = "Invalid provider configuration";
const INVALID_URL = "Provider request URL is invalid";
const INVALID_HEADERS = "Provider request headers are invalid";
const INVALID_HTTP_RESPONSE = "Provider returned an invalid HTTP response";
const TRANSPORT_FAILURE = "Provider transport failed";
const TIMEOUT_FAILURE = "Provider request timed out";
const CREDENTIAL_FAILURE = "Provider credential is unavailable";

export interface ProviderHost {
  execute(providerId: string): ExecuteProvider;
  ready(providerId: string): Promise<boolean>;
}

export interface ProviderHostOptions {
  providers: ProviderManagement;
  credentials: Credentials;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface AttemptSignal {
  signal: AbortSignal;
  dispose(): void;
  throwIfInterrupted(): void;
}

function invalidConfiguration(): never {
  throw new PiscesError("config.invalid", INVALID_CONFIGURATION);
}

function invalidUrl(): never {
  throw new PiscesError("provider.invalid_response", INVALID_URL);
}

function invalidHeaders(): never {
  throw new PiscesError("provider.invalid_response", INVALID_HEADERS);
}

function invalidHttpResponse(): never {
  throw new PiscesError("provider.invalid_response", INVALID_HTTP_RESPONSE);
}

function transportFailure(): PiscesError {
  return new PiscesError("provider.transport", TRANSPORT_FAILURE);
}

function timeoutFailure(): PiscesError {
  return new PiscesError("provider.timeout", TIMEOUT_FAILURE);
}

function credentialFailure(): never {
  throw new PiscesError("provider.transport", CREDENTIAL_FAILURE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateOptions(options: ProviderHostOptions): void {
  if (
    !isRecord(options) ||
    !isRecord(options.providers) ||
    typeof options.providers.get !== "function" ||
    !isRecord(options.credentials) ||
    typeof options.credentials.get !== "function" ||
    typeof options.credentials.refresh !== "function" ||
    (options.fetch !== undefined && typeof options.fetch !== "function") ||
    (options.now !== undefined && typeof options.now !== "function") ||
    (options.sleep !== undefined && typeof options.sleep !== "function")
  )
    throw new TypeError("Invalid provider host options");

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  if (
    !isPositiveInteger(timeoutMs) ||
    !isPositiveInteger(maxAttempts) ||
    !isNonNegativeInteger(retryBaseDelayMs)
  )
    throw new TypeError("Invalid provider host options");
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createAttemptSignal(outer: AbortSignal | undefined, timeoutMs: number): AttemptSignal {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;

  const forwardAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) forwardAbort();
  else outer?.addEventListener("abort", forwardAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      outer?.removeEventListener("abort", forwardAbort);
    },
    throwIfInterrupted() {
      if (outer?.aborted) throw outer.reason;
      if (timedOut) throw timeoutFailure();
    },
  };
}

function credentialExpired(value: Record<string, unknown>, currentTime: number): boolean {
  if (value.expiresAt === undefined) return false;
  if (typeof value.expiresAt !== "string") return true;
  const expiresAt = Date.parse(value.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= currentTime;
}

function hasExpectedType(value: unknown, type: Credential["type"]): value is Credential {
  return (
    isRecord(value) &&
    value.type === type &&
    typeof value.value === "string" &&
    value.value.length > 0
  );
}

function usableCredential(
  value: unknown,
  descriptor: ProviderDescriptor,
  currentTime: number,
): value is Credential {
  return (
    hasExpectedType(value, descriptor.auth.type) &&
    !credentialExpired(value as unknown as Record<string, unknown>, currentTime)
  );
}

async function resolveCredential(
  descriptor: ProviderDescriptor,
  credentials: Credentials,
  now: () => number,
): Promise<Credential> {
  let credential: unknown;
  try {
    credential = await credentials.get(descriptor.auth.credentialRef);
  } catch {
    credentialFailure();
  }

  if (usableCredential(credential, descriptor, now())) return credential;

  const existing = isRecord(credential) ? credential : undefined;
  const shouldRefresh =
    descriptor.auth.type === "oauth" &&
    (credential === undefined ||
      credential === null ||
      (existing?.type === "oauth" && credentialExpired(existing, now())));
  if (!shouldRefresh) credentialFailure();

  try {
    const refreshed: unknown = await credentials.refresh(descriptor.auth.credentialRef);
    if (!usableCredential(refreshed, descriptor, now())) credentialFailure();
    return refreshed;
  } catch {
    credentialFailure();
  }
}

function providerUrl(baseUrl: string, path: string): string {
  if (
    typeof baseUrl !== "string" ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\")
  )
    invalidUrl();

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    invalidUrl();
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    invalidUrl();

  let result: URL;
  try {
    const basePath = base.pathname.replace(/\/+$/, "");
    result = new URL(`${base.origin}${basePath}${path}`);
  } catch {
    invalidUrl();
  }
  if (result.origin !== base.origin || result.username || result.password || result.hash)
    invalidUrl();
  return result.toString();
}

function requestHeaders(
  descriptor: ProviderDescriptor,
  request: WireRequest,
  credential: Credential,
): Headers {
  const headers = new Headers();
  try {
    for (const [name, value] of Object.entries(descriptor.headers ?? {})) {
      if (typeof value !== "string") invalidHeaders();
      headers.set(name, value);
    }
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (typeof value !== "string") invalidHeaders();
      headers.set(name, value);
    }
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${credential.value}`);
  } catch (error) {
    if (error instanceof PiscesError) throw error;
    invalidHeaders();
  }
  return headers;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Status and transport decisions do not depend on cleanup success.
  }
}

function normalizedTransportError(error: unknown): PiscesError {
  return error instanceof PiscesError ? error : transportFailure();
}

function isSse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  if (!contentType) return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

async function* responseChunks(response: Response, attempt: AttemptSignal): AsyncGenerator<string> {
  if (isSse(response)) {
    if (!response.body) invalidHttpResponse();
    for await (const chunk of parseSseStream(response.body)) {
      attempt.throwIfInterrupted();
      yield chunk;
    }
    attempt.throwIfInterrupted();
    return;
  }

  const body = await response.text();
  attempt.throwIfInterrupted();
  attempt.dispose();
  yield body;
}

export function createProviderHost(options: ProviderHostOptions): ProviderHost {
  validateOptions(options);

  const providers = options.providers;
  const credentials = options.credentials;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  return {
    async ready(providerId) {
      try {
        const descriptor = providers.get(providerId);
        if (!descriptor || descriptor.models.length === 0) return false;
        const credential = await credentials.get(descriptor.auth.credentialRef);
        return usableCredential(credential, descriptor, now());
      } catch {
        return false;
      }
    },

    execute(providerId) {
      return async function* (request, outerSignal) {
        if (outerSignal?.aborted) throw outerSignal.reason;
        const descriptor = providers.get(providerId);
        if (!descriptor) invalidConfiguration();
        const credential = await resolveCredential(descriptor, credentials, now);
        if (outerSignal?.aborted) throw outerSignal.reason;

        const url = providerUrl(descriptor.baseUrl, request.path);
        const headers = requestHeaders(descriptor, request, credential);

        for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
          if (outerSignal?.aborted) throw outerSignal.reason;
          const attempt = createAttemptSignal(outerSignal, timeoutMs);
          let retry = false;

          try {
            let response: Response;
            try {
              response = await fetchImpl(url, {
                method: "POST",
                headers,
                body: request.body,
                signal: attempt.signal,
              });
            } catch (error) {
              attempt.throwIfInterrupted();
              throw normalizedTransportError(error);
            }
            attempt.throwIfInterrupted();

            if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
              await cancelResponse(response);
              retry = attemptNumber < maxAttempts;
              if (!retry) invalidHttpResponse();
            } else if (response.status < 200 || response.status > 299) {
              await cancelResponse(response);
              invalidHttpResponse();
            } else {
              yield* responseChunks(response, attempt);
              return;
            }
          } catch (error) {
            attempt.throwIfInterrupted();
            throw normalizedTransportError(error);
          } finally {
            attempt.dispose();
          }

          if (retry) {
            const delayMs = retryBaseDelayMs * 2 ** (attemptNumber - 1);
            try {
              await sleep(delayMs, outerSignal);
            } catch (error) {
              if (outerSignal?.aborted) throw outerSignal.reason;
              throw normalizedTransportError(error);
            }
            if (outerSignal?.aborted) throw outerSignal.reason;
          }
        }

        invalidHttpResponse();
      };
    },
  };
}

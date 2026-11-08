import type {
  ContextEntries,
  ContextSourceRegistry,
  EngineEvent,
  EventBus,
  JsonValue,
  NodeId,
  ProviderManagement,
  QueueEntryId,
  SessionId,
  Skills,
  Tools,
  TurnId,
} from "@pisces/core";
import { PiscesError } from "@pisces/core";
import type { ProviderHost } from "../provider/provider-host.js";
import type { Concurrency } from "../runtime/concurrency.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { ActiveTurnStore } from "./active-turn.js";
import type {
  GatewayRequest,
  GatewayResponse,
  ModelInfo,
  ProviderInfo,
  ProviderListResult,
  SessionDefaults,
} from "./protocol.js";

export interface GatewayDeps {
  store: SessionStore;
  providers: ProviderManagement;
  providerHost: ProviderHost;
  concurrency: Concurrency;
  events: EventBus;
  markers: ActiveTurnStore;
  defaults?: SessionDefaults;
  createTools?: () => Tools;
  entries?: ContextEntries;
  skills?: Skills;
  sources?: ContextSourceRegistry;
  validateWorkspace?: (workspace: string) => Promise<boolean>;
  newSessionId?: () => SessionId;
  newTurnId?: () => TurnId;
  newQueueEntryId?: () => QueueEntryId;
  newNodeId?: () => NodeId;
  now?: () => string;
}

export interface Gateway {
  handle(request: GatewayRequest): Promise<GatewayResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelInfo(model: {
  id: string;
  contextWindow: number;
  maxOutput: number;
  modalities: ("text" | "image" | "audio")[];
  pricing?: { input: number; output: number; currency: string };
}): ModelInfo {
  return {
    id: model.id,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    modalities: [...model.modalities],
    ...(model.pricing
      ? {
          pricing: {
            input: model.pricing.input,
            output: model.pricing.output,
            currency: model.pricing.currency,
          },
        }
      : {}),
  };
}

export function createGateway(deps: GatewayDeps): Gateway {
  const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    async "provider.list"(): Promise<ProviderListResult> {
      const providers: ProviderInfo[] = [];
      for (const descriptor of deps.providers.list()) {
        providers.push({
          id: descriptor.id,
          ready:
            descriptor.models.length > 0 ? await deps.providerHost.ready(descriptor.id) : false,
          models: descriptor.models.map(modelInfo),
        });
      }
      return { providers };
    },
  };

  // No session runtimes exist until the turn routes are added; every session is unknown.
  const handler = (event: EngineEvent): void => {
    if (event.sessionId === undefined) return;
  };
  deps.events.subscribe(handler);

  return {
    async handle(request) {
      if (!isRecord(request.params))
        return {
          id: request.id,
          error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
        };

      const route = handlers[request.method];
      if (!route)
        return {
          id: request.id,
          error: { code: "protocol.unknown_method", message: "Unknown protocol method" },
        };

      try {
        return { id: request.id, result: (await route(request.params)) as JsonValue };
      } catch (error) {
        if (error instanceof PiscesError)
          return { id: request.id, error: { code: error.code, message: error.message } };
        return {
          id: request.id,
          error: { code: "internal.error", message: "Internal error" },
        };
      }
    },
  };
}

import { type JsonValue, negotiateVersion, PROTOCOL_VERSION } from "@pisces/protocol";
import type { Gateway } from "../gateway/gateway.js";
import type { GatewayResponse, ProtocolError } from "../gateway/protocol.js";

/** Idle pre-hello clients are dropped after this long. */
const DEFAULT_PRE_HELLO_TIMEOUT_MS = 5000;

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });

const INVALID_JSON = { code: "protocol.invalid_json", message: "Invalid JSON frame" };
const INVALID_REQUEST = { code: "protocol.invalid_request", message: "Invalid request parameters" };
const HELLO_REQUIRED = {
  code: "protocol.hello_required",
  message: "protocol.hello is required before other methods",
};
const VERSION_MISMATCH = {
  code: "protocol.version_mismatch",
  message: "No compatible protocol version",
};
const INTERNAL_ERROR = { code: "internal.error", message: "Internal error" };

const failure = (id: string, error: ProtocolError): GatewayResponse => ({ id, error });

export interface DispatcherOptions {
  gateway: Pick<Gateway, "handle">;
  connectionId?: string;
  /** Synchronously enqueue a response; throws when the connection cannot accept it. */
  send: (response: GatewayResponse) => void;
  /** Close this connection immediately. */
  close: () => void;
  /** Close this connection after already queued frames have been flushed. */
  flushAndClose: () => void;
  preHelloTimeoutMs?: number;
  serverVersion?: string;
}

export interface Dispatcher {
  /** Handle one complete NDJSON frame. */
  accept(line: Uint8Array): void;
  /** Reject new frames before they enter the pending set. */
  quiesce(): void;
  /** Resolve once every admitted Gateway operation has settled. */
  pending(): Promise<void>;
  /** Stop timers and ignore new frames; admitted operations stay tracked. */
  dispose(): void;
}

interface Envelope {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

type Validated = { ok: true; envelope: Envelope } | { ok: false; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEnvelope(value: unknown): Validated {
  if (!isRecord(value)) return { ok: false, id: "" };
  const id = value.id;
  // An unusable id cannot be correlated, so responses use the documented empty sentinel.
  if (typeof id !== "string") return { ok: false, id: "" };
  const method = value.method;
  if (typeof method !== "string") return { ok: false, id };
  const params = value.params;
  if (!isRecord(params)) return { ok: false, id };
  return { ok: true, envelope: { id, method, params } };
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const serverVersion = options.serverVersion ?? PROTOCOL_VERSION;
  const preHelloTimeoutMs = Math.max(1, options.preHelloTimeoutMs ?? DEFAULT_PRE_HELLO_TIMEOUT_MS);
  let disposed = false;
  let quiescing = false;
  let helloComplete = false;
  let inFlight = 0;
  const pendingWaiters: (() => void)[] = [];

  const preHelloTimer = setTimeout(() => {
    if (disposed || helloComplete) return;
    disposed = true;
    options.close();
  }, preHelloTimeoutMs);
  preHelloTimer.unref?.();

  function clearPreHelloTimer(): void {
    clearTimeout(preHelloTimer);
  }

  function respond(response: GatewayResponse): boolean {
    if (disposed) return false;
    try {
      options.send(response);
      return true;
    } catch {
      disposed = true;
      clearPreHelloTimer();
      options.close();
      return false;
    }
  }

  function complete(): void {
    inFlight -= 1;
    if (inFlight > 0) return;
    for (const resolve of pendingWaiters.splice(0)) resolve();
  }

  async function run(envelope: Envelope): Promise<void> {
    let response: GatewayResponse;
    try {
      response = await options.gateway.handle(
        {
          id: envelope.id,
          method: envelope.method,
          params: envelope.params as unknown as JsonValue,
        },
        options.connectionId,
      );
    } catch {
      response = failure(envelope.id, INTERNAL_ERROR);
    }
    respond(response);
  }

  function dispatch(envelope: Envelope): void {
    inFlight += 1;
    void run(envelope).finally(complete);
  }

  function handshake(envelope: Envelope): void {
    if (helloComplete) {
      respond(failure(envelope.id, INVALID_REQUEST));
      return;
    }
    const versions = envelope.params.versions;
    if (!Array.isArray(versions) || !versions.every((entry) => typeof entry === "string")) {
      respond(failure(envelope.id, INVALID_REQUEST));
      return;
    }
    const version = negotiateVersion(versions, serverVersion);
    clearPreHelloTimer();
    if (version === undefined) {
      const sent = respond(failure(envelope.id, VERSION_MISMATCH));
      disposed = true;
      if (sent) options.flushAndClose();
      return;
    }
    helloComplete = true;
    respond({ id: envelope.id, result: { version, compatible: true } });
  }

  return {
    accept(line) {
      if (disposed || quiescing) return;

      let text: string;
      try {
        text = FATAL_UTF8.decode(line);
      } catch {
        respond(failure("", INVALID_JSON));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        respond(failure("", INVALID_JSON));
        return;
      }

      const validated = validateEnvelope(parsed);
      if (!validated.ok) {
        respond(failure(validated.id, INVALID_REQUEST));
        return;
      }

      const envelope = validated.envelope;
      if (envelope.method === "protocol.hello") {
        handshake(envelope);
        return;
      }
      if (!helloComplete) {
        respond(failure(envelope.id, HELLO_REQUIRED));
        return;
      }
      dispatch(envelope);
    },

    quiesce() {
      quiescing = true;
    },

    pending() {
      if (inFlight === 0) return Promise.resolve();
      return new Promise<void>((resolve) => pendingWaiters.push(resolve));
    },

    dispose() {
      disposed = true;
      clearPreHelloTimer();
    },
  };
}

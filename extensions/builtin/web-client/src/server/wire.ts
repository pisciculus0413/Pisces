import { connect } from "node:net";
import {
  createNdjsonDecoder,
  encodeFrame,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} from "@pisces/protocol";

/**
 * The bridge's only upstream: one NDJSON connection to the daemon socket.
 *
 * Requests are multiplexed by id so every browser tab shares a single upstream
 * connection; event frames are handed to every registered listener, which is
 * how SSE streams get their data. Errors carry stable codes only — the raw
 * socket error, the daemon's message and any cause stay inside this module.
 */

export interface WireEvent {
  event: string;
  data: unknown;
}

export interface WireClient {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Returns an unsubscribe function; the listener sees every event frame. */
  onEvent(listener: (event: WireEvent) => void): () => void;
  close(): void;
}

export const UNREACHABLE_CODE = "daemon.unreachable";
export const TIMEOUT_CODE = "daemon.timeout";
export const INVALID_RESPONSE_CODE = "protocol.invalid_response";
export const INVALID_RESPONSE_MESSAGE = "Invalid response from daemon";

const UNREACHABLE_MESSAGE = "Daemon is not reachable";
const TIMEOUT_MESSAGE = "Daemon did not respond";

export const DEFAULT_TIMEOUT_MS = 15_000;

export class WireError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
}

const unreachable = (): WireError => new WireError(UNREACHABLE_CODE, UNREACHABLE_MESSAGE);

/** Everything `request` can reject with: a transport failure or a daemon error code. */
export type WireRequestError = WireError | ProtocolError;

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: WireRequestError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A request error from the daemon keeps its protocol code; the bridge forwards it. */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

export async function connectWire(
  socketPath: string,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WireClient> {
  const socket = connect(socketPath);
  const waiters = new Map<string, Waiter>();
  const listeners = new Set<(event: WireEvent) => void>();
  let closed = false;
  let nextId = 0;

  const failAll = (error: WireRequestError): void => {
    for (const [, waiter] of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };

  const onFrame = (line: Uint8Array): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    if (typeof frame.event === "string") {
      for (const listener of listeners) listener({ event: frame.event, data: frame.data });
      return;
    }
    if (typeof frame.id !== "string") return;
    const waiter = waiters.get(frame.id);
    if (waiter === undefined) return;
    waiters.delete(frame.id);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    const error = frame.error;
    if (isRecord(error)) {
      waiter.reject(
        new ProtocolError(
          typeof error.code === "string" ? error.code : "internal.error",
          typeof error.message === "string" ? error.message : "Daemon reported an error",
        ),
      );
      return;
    }
    waiter.resolve(frame.result);
  };

  const decoder = createNdjsonDecoder(onFrame);
  socket.on("data", (chunk: Buffer) => decoder.push(chunk));
  socket.on("error", () => {
    // Terminal failure is reported once through the close handler.
  });
  socket.on("close", () => {
    closed = true;
    failAll(unreachable());
    listeners.clear();
  });

  const write = (value: unknown): void => {
    if (closed) throw unreachable();
    socket.write(encodeFrame(value, MAX_FRAME_BYTES));
  };

  const request = (
    method: string,
    params: unknown = {},
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> => {
    if (closed) return Promise.reject(unreachable());
    nextId += 1;
    const id = `web-${nextId}`;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              waiters.delete(id);
              reject(new WireError(TIMEOUT_CODE, TIMEOUT_MESSAGE));
            }, timeoutMs)
          : undefined;
      waiters.set(id, { resolve, reject, timer });
      try {
        write({ id, method, params });
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        waiters.delete(id);
        reject(error instanceof WireError ? error : unreachable());
      }
    });
  };

  await new Promise<void>((resolve, reject) => {
    const fail = (): void => reject(unreachable());
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("connect", () => {
      socket.removeListener("error", fail);
      socket.removeListener("close", fail);
      resolve();
    });
  }).catch((error: unknown) => {
    socket.destroy();
    throw error instanceof WireError ? error : unreachable();
  });

  const handshake = await request("protocol.hello", { versions: [PROTOCOL_VERSION] }).catch(
    (error: unknown) => {
      socket.destroy();
      throw error instanceof WireError ? error : unreachable();
    },
  );
  if (!isRecord(handshake) || handshake.compatible !== true) {
    socket.destroy();
    throw unreachable();
  }

  return {
    request,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      failAll(unreachable());
      listeners.clear();
      socket.destroy();
    },
  };
}

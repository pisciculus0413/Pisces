import { connect, type Socket } from "node:net";
import {
  createNdjsonDecoder,
  encodeFrame,
  type JsonValue,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ProtocolEvent,
} from "@pisces/protocol";

/**
 * Minimal one-connection protocol client for the CLI.
 *
 * The daemon speaks NDJSON over a Unix socket and requires `protocol.hello`
 * before any other method. This client performs that handshake once, then
 * routes responses to waiters by request id and daemon-pushed `{event, data}`
 * frames to registered listeners. Every failure is reported as a `ClientError`
 * with a fixed code and message, so no raw socket or parser error ever reaches
 * the terminal.
 */

/** Default budget for connecting and for each individual request. */
export const CLIENT_TIMEOUT_MS = 5000;

/** Per-request override of the connection's default budget. */
export interface RequestOptions {
  timeoutMs?: number;
}

/** Fixed text printed for an unreachable or handshake-failing daemon. */
export const UNREACHABLE_MESSAGE = "Daemon is not reachable";

const TIMEOUT_MESSAGE = "Daemon did not respond";
const CLOSED_MESSAGE = "Client is closed";
const PROTOCOL_MESSAGE = "Invalid response from daemon";

const HELLO_METHOD = "protocol.hello";
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
/** Requests are bounded by the frame cap, not the response cap. */
const MAX_REQUEST_BYTES = MAX_FRAME_BYTES - 1;

/** A protocol, transport or timeout failure with a stable code and safe message. */
export class ClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClientError";
    this.code = code;
  }
}

export type EventListener = (event: ProtocolEvent) => void;

export interface Client {
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  /**
   * Registers a listener for daemon-pushed event frames. Returns an unsubscribe
   * function that removes only this listener and is safe to call repeatedly.
   * A throwing listener is caught and ignored, so it can neither stop the other
   * listeners nor break the connection.
   */
  onEvent(listener: EventListener): () => void;
  close(): void;
}

interface Waiter {
  resolve(value: unknown): void;
  reject(error: ClientError): void;
  timer: NodeJS.Timeout;
}

const unreachable = (): ClientError => new ClientError("daemon.unreachable", UNREACHABLE_MESSAGE);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Connects and completes the handshake; the socket is released on every failure. */
export async function connectClient(
  socketPath: string,
  timeoutMs: number = CLIENT_TIMEOUT_MS,
): Promise<Client> {
  const socket = await openSocket(socketPath, timeoutMs);
  const client = createClient(socket, timeoutMs);
  try {
    const result = await client.request(HELLO_METHOD, { versions: [PROTOCOL_VERSION] });
    if (!isRecord(result) || result.compatible !== true) throw unreachable();
  } catch (error) {
    client.close();
    throw error instanceof ClientError ? error : unreachable();
  }
  return client;
}

/** Resolves with a connected socket; every other outcome is `daemon.unreachable`. */
function openSocket(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: Socket | undefined;

    const finish = (error?: ClientError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        // Listeners stay attached: removing the pending `error` guard would
        // leave a window where a socket error crashes the process.
        if (socket !== undefined) resolve(socket);
        return;
      }
      if (socket !== undefined) {
        socket.removeAllListeners();
        socket.on("error", () => {});
        socket.destroy();
      }
      reject(error);
    };

    const timer = setTimeout(() => finish(unreachable()), Math.max(1, timeoutMs));

    try {
      socket = connect(socketPath);
    } catch {
      finish(unreachable());
      return;
    }

    socket.once("connect", () => finish());
    socket.once("error", () => finish(unreachable()));
  });
}

function createClient(socket: Socket, timeoutMs: number): Client {
  let nextId = 0;
  let closed = false;
  const waiters = new Map<string, Waiter>();
  const listeners = new Set<EventListener>();

  /** A listener failure stays local: the rest of the set and the client live on. */
  const deliver = (event: ProtocolEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Listener errors are deliberately ignored.
      }
    }
  };

  const failAll = (error: ClientError): void => {
    for (const [id, waiter] of waiters) {
      waiters.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    listeners.clear();
    failAll(new ClientError("client.closed", CLOSED_MESSAGE));
    socket.removeAllListeners();
    socket.on("error", () => {});
    socket.destroy();
  };

  /** A frame the client cannot understand ends the connection; the daemon is unusable. */
  const protocolFailure = (): void => {
    if (closed) return;
    closed = true;
    listeners.clear();
    failAll(new ClientError("client.protocol", PROTOCOL_MESSAGE));
    socket.removeAllListeners();
    socket.on("error", () => {});
    socket.destroy();
  };

  const handleLine = (line: Uint8Array): void => {
    if (closed) return;
    let value: unknown;
    try {
      value = JSON.parse(FATAL_UTF8.decode(line));
    } catch {
      protocolFailure();
      return;
    }
    if (!isRecord(value)) {
      protocolFailure();
      return;
    }
    if (typeof value.id !== "string") {
      if (typeof value.event === "string" && isRecord(value.data)) {
        // `JSON.parse` only yields JSON values, so the cast is sound.
        deliver({ event: value.event, data: value.data as JsonValue });
        return;
      }
      protocolFailure();
      return;
    }
    const waiter = waiters.get(value.id);
    if (waiter === undefined) return;
    waiters.delete(value.id);
    clearTimeout(waiter.timer);
    const failure = value.error;
    if (
      isRecord(failure) &&
      typeof failure.code === "string" &&
      typeof failure.message === "string"
    ) {
      waiter.reject(new ClientError(failure.code, failure.message));
      return;
    }
    if (!("result" in value)) {
      protocolFailure();
      return;
    }
    waiter.resolve(value.result);
  };

  const decoder = createNdjsonDecoder(handleLine);

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    try {
      decoder.push(chunk);
    } catch {
      protocolFailure();
    }
  });
  socket.once("error", () => close());
  socket.once("close", () => close());

  return {
    request(method, params = {}, options = {}) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new ClientError("client.closed", CLOSED_MESSAGE));
          return;
        }
        nextId += 1;
        const id = `cli-${nextId}`;
        const budget = options.timeoutMs ?? timeoutMs;
        const timer = setTimeout(() => {
          if (!waiters.delete(id)) return;
          reject(new ClientError("client.timeout", TIMEOUT_MESSAGE));
        }, budget);
        waiters.set(id, { resolve, reject, timer });

        let frame: Uint8Array;
        try {
          frame = encodeFrame({ id, method, params }, MAX_REQUEST_BYTES);
        } catch {
          clearTimeout(timer);
          waiters.delete(id);
          reject(new ClientError("client.protocol", PROTOCOL_MESSAGE));
          return;
        }

        try {
          socket.write(frame);
        } catch {
          close();
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      close();
    },
  };
}

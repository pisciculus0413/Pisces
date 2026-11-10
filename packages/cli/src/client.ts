import { connect, type Socket } from "node:net";
import {
  createNdjsonDecoder,
  encodeFrame,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
} from "@pisces/protocol";

/**
 * Minimal one-connection protocol client for the CLI.
 *
 * The daemon speaks NDJSON over a Unix socket and requires `protocol.hello`
 * before any other method. This client performs that handshake once, then
 * routes responses to waiters by request id. Every failure is reported as a
 * `ClientError` with a fixed code and message, so no raw socket or parser
 * error ever reaches the terminal.
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

export interface Client {
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
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
    failAll(new ClientError("client.closed", CLOSED_MESSAGE));
    socket.removeAllListeners();
    socket.on("error", () => {});
    socket.destroy();
  };

  /** A frame the client cannot understand ends the connection; the daemon is unusable. */
  const protocolFailure = (): void => {
    if (closed) return;
    closed = true;
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
    if (!isRecord(value) || typeof value.id !== "string") {
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
    close() {
      close();
    },
  };
}

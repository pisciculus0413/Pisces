import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import {
  createNdjsonDecoder,
  encodeFrame,
  FrameTooLarge,
  MAX_EVENT_BYTES,
  MAX_RESPONSE_BYTES,
  type ProtocolEvent,
} from "@pisces/protocol";
import type { Gateway } from "../gateway/gateway.js";
import type { GatewayResponse } from "../gateway/protocol.js";
import { createDispatcher } from "./dispatcher.js";

/** Default outbound queue budget for one connection. */
const DEFAULT_MAX_QUEUED_BYTES = 8388608;

/** Version-mismatch responses and oversized-frame errors get at most this long to flush. */
const DEFAULT_FLUSH_CLOSE_MS = 1000;

const FRAME_TOO_LARGE = {
  code: "protocol.frame_too_large",
  message: "NDJSON frame exceeds the size limit",
};

export interface ConnectionOptions {
  preHelloTimeoutMs?: number;
  /** Flush limit shared by version-mismatch and oversize-frame close paths. */
  versionMismatchFlushMs?: number;
  maxQueuedBytes?: number;
  serverVersion?: string;
}

export interface Connection {
  /** Close and detach immediately; admitted Gateway operations keep running. */
  close(): void;
  /** Reject new frames before pending registration; admitted operations keep running. */
  quiesce(): void;
  /** Resolve once every admitted Gateway operation has settled. */
  pending(): Promise<void>;
}

export function createConnection(
  socket: Socket,
  gateway: Gateway,
  options: ConnectionOptions = {},
): Connection {
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const flushCloseMs = Math.max(1, options.versionMismatchFlushMs ?? DEFAULT_FLUSH_CLOSE_MS);
  const connectionId = randomUUID();

  let closed = false;
  let ending = false;
  let discarded = false;
  let writing = false;
  let closeAfterFlush = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedBytes = 0;
  const frames: Uint8Array[] = [];

  const dispatcher = createDispatcher({
    gateway,
    connectionId,
    send: sendResponse,
    close: destroy,
    flushAndClose: flushAndClose,
    ...(options.preHelloTimeoutMs !== undefined
      ? { preHelloTimeoutMs: options.preHelloTimeoutMs }
      : {}),
    ...(options.serverVersion !== undefined ? { serverVersion: options.serverVersion } : {}),
  });

  const decoder = createNdjsonDecoder((line) => {
    dispatcher.accept(line);
  });

  function clearCloseTimer(): void {
    if (closeTimer === undefined) return;
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function armCloseTimer(): void {
    if (closeTimer !== undefined) return;
    closeTimer = setTimeout(() => destroy(), flushCloseMs);
    closeTimer.unref?.();
  }

  function destroy(): void {
    if (closed) return;
    closed = true;
    clearCloseTimer();
    dispatcher.dispose();
    frames.length = 0;
    queuedBytes = 0;
    gateway.detach(connectionId);
    socket.destroy();
  }

  function finishClose(): void {
    if (closed || ending) return;
    ending = true;
    try {
      socket.end();
    } catch {
      destroy();
    }
  }

  function flushAndClose(): void {
    if (closed || ending) return;
    closeAfterFlush = true;
    armCloseTimer();
    if (!writing && frames.length === 0) finishClose();
  }

  function waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        socket.off("drain", done);
        socket.off("close", done);
        socket.off("error", done);
        resolve();
      };
      socket.on("drain", done);
      socket.on("close", done);
      socket.on("error", done);
    });
  }

  async function flush(): Promise<void> {
    try {
      while (!closed && !ending && frames.length > 0) {
        const frame = frames.shift() as Uint8Array;
        queuedBytes -= frame.byteLength;
        if (socket.write(frame) === false) {
          await waitForDrain();
        }
      }
      if (closed) return;
      if (frames.length === 0) {
        if (closeAfterFlush) finishClose();
      }
    } catch {
      destroy();
    } finally {
      writing = false;
      if (!closed && !ending && frames.length > 0) kick();
    }
  }

  function kick(): void {
    if (writing || closed) return;
    writing = true;
    void flush();
  }

  function enqueueFrame(frame: Uint8Array): boolean {
    if (closed || ending) return false;
    if (frame.byteLength > maxQueuedBytes - queuedBytes) {
      // Only this connection is discarded; turn cancellation is never triggered from here.
      destroy();
      return false;
    }
    frames.push(frame);
    queuedBytes += frame.byteLength;
    kick();
    return true;
  }

  function sendResponse(response: GatewayResponse): void {
    let frame: Uint8Array;
    try {
      frame = encodeFrame(response, MAX_RESPONSE_BYTES);
    } catch {
      destroy();
      throw new Error("response cannot be encoded");
    }
    if (!enqueueFrame(frame)) throw new Error("connection cannot accept the response");
  }

  function enqueueEvent(event: ProtocolEvent): void {
    try {
      enqueueFrame(encodeFrame(event, MAX_EVENT_BYTES));
    } catch {
      // Encoding is synchronous, so the published event object is never retained.
      destroy();
    }
  }

  function decoderFailure(error: unknown): void {
    if (closed) return;
    if (error instanceof FrameTooLarge) {
      if (socket.writable) {
        try {
          sendResponse({ id: "", error: FRAME_TOO_LARGE });
        } catch {
          // The safe error could not be queued; the connection is already failing.
        }
      }
      if (!closed) flushAndClose();
      return;
    }
    destroy();
  }

  function onData(chunk: Buffer): void {
    if (closed || ending || discarded) return;
    try {
      decoder.push(chunk);
    } catch (error) {
      // The decoder is not reusable after a failure; discard it with the connection.
      discarded = true;
      decoderFailure(error);
    }
  }

  gateway.attach(connectionId, enqueueEvent);
  socket.on("data", onData);
  socket.on("error", () => destroy());
  socket.on("close", () => destroy());

  return {
    close: destroy,
    quiesce: () => dispatcher.quiesce(),
    pending: () => dispatcher.pending(),
  };
}

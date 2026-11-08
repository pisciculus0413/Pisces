/**
 * 协议分帧与负载上限；纯字节处理，不做 JSON 校验。
 */

/** 单帧上限，含结尾 LF。 */
export const MAX_FRAME_BYTES = 8388608;

/** 响应负载上限，按 JSON UTF-8 字节计，不含结尾 LF。 */
export const MAX_RESPONSE_BYTES = 4194304;

/** 事件负载上限，按 JSON UTF-8 字节计，不含结尾 LF。 */
export const MAX_EVENT_BYTES = MAX_RESPONSE_BYTES;

const LF = 0x0a;
const UTF8_ENCODER = new TextEncoder();

/** 帧（含结尾 LF）超过 {@link MAX_FRAME_BYTES}。 */
export class FrameTooLarge extends Error {
  constructor() {
    super(`NDJSON frame exceeds ${MAX_FRAME_BYTES} bytes`);
    this.name = "FrameTooLarge";
  }
}

/** 增量 NDJSON 分帧器；仅字面 LF 分隔帧，`\r` 保留在帧内。 */
export interface NdjsonDecoder {
  push(chunk: Uint8Array): void;
  finish(): void;
}

/**
 * 创建 NDJSON 分帧器。每次遇到 LF 调用一次 `onLine`，传入不含 LF 的帧字节；
 * 流结束时仍有未终止的字节则在 `finish` 抛错。
 */
export function createNdjsonDecoder(onLine: (line: Uint8Array) => void): NdjsonDecoder {
  const parts: Uint8Array[] = [];
  let pendingBytes = 0;
  let failed = false;

  const overflow = (): never => {
    failed = true;
    parts.length = 0;
    pendingBytes = 0;
    throw new FrameTooLarge();
  };

  const join = (tail: Uint8Array): Uint8Array => {
    if (parts.length === 0) {
      return new Uint8Array(tail);
    }
    let total = tail.byteLength;
    for (const part of parts) {
      total += part.byteLength;
    }
    const line = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      line.set(part, offset);
      offset += part.byteLength;
    }
    line.set(tail, offset);
    return line;
  };

  return {
    push(chunk) {
      if (failed) {
        throw new FrameTooLarge();
      }
      let start = 0;
      for (;;) {
        const lf = chunk.indexOf(LF, start);
        if (lf === -1) {
          const tail = chunk.slice(start);
          if (tail.byteLength === 0) {
            return;
          }
          if (pendingBytes + tail.byteLength >= MAX_FRAME_BYTES) {
            overflow();
          }
          parts.push(tail);
          pendingBytes += tail.byteLength;
          return;
        }
        const segment = chunk.subarray(start, lf);
        if (pendingBytes + segment.byteLength >= MAX_FRAME_BYTES) {
          overflow();
        }
        const line = join(segment);
        parts.length = 0;
        pendingBytes = 0;
        onLine(line);
        start = lf + 1;
        if (start >= chunk.length) {
          return;
        }
      }
    },
    finish() {
      if (failed) {
        throw new FrameTooLarge();
      }
      if (parts.length > 0 || pendingBytes > 0) {
        throw new Error("Incomplete frame: stream ended before LF");
      }
    },
  };
}

/**
 * 将值编码为一行 NDJSON，含结尾 LF。
 *
 * `maxBytes` 只约束 JSON UTF-8 字节（不含 LF）；发出的帧（含 LF）还必须不超
 * {@link MAX_FRAME_BYTES}，否则抛 {@link FrameTooLarge}。
 */
export function encodeFrame(value: unknown, maxBytes: number): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError("Value is not JSON-serializable");
  }
  const payload = UTF8_ENCODER.encode(json);
  if (payload.byteLength > maxBytes) {
    throw new RangeError(`Encoded payload exceeds ${maxBytes} bytes`);
  }
  if (payload.byteLength + 1 > MAX_FRAME_BYTES) {
    throw new FrameTooLarge();
  }
  const frame = new Uint8Array(payload.byteLength + 1);
  frame.set(payload, 0);
  frame[payload.byteLength] = LF;
  return frame;
}

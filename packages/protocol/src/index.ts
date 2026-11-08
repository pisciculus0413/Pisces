/**
 * protocol：客户端与 daemon 之间传输无关的请求、响应与事件契约。
 *
 * 见 docs/0-module.md。
 */

export {
  createNdjsonDecoder,
  encodeFrame,
  FrameTooLarge,
  MAX_EVENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_RESPONSE_BYTES,
  type NdjsonDecoder,
} from "./codec.js";
export type { JsonValue, ProtocolError, ProtocolEvent, Request, Response } from "./types.js";
export { negotiateVersion, PROTOCOL_VERSION } from "./version.js";

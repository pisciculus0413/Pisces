/**
 * 协议消息的传输无关数据契约。
 *
 * 本包不依赖 Node IO、daemon 或 core；JSON 校验与错误映射由传输适配器负责。
 */

/** 可无损表示的 JSON 值。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 协议错误的稳定代码与安全消息。 */
export interface ProtocolError {
  code: string;
  message: string;
}

/** 客户端请求；由 `id` 关联响应。 */
export interface Request<P = JsonValue> {
  id: string;
  method: string;
  params: P;
}

/** 服务端响应；线上恰好包含 `result` 与 `error` 之一。 */
export interface Response<R = JsonValue> {
  id: string;
  result?: R;
  error?: ProtocolError;
}

/** 服务端推送事件。 */
export interface ProtocolEvent<E = JsonValue> {
  event: string;
  data: E;
}

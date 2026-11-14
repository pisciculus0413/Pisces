/**
 * Error code → HTTP status. The protocol code stays the contract; the status is
 * only a coarse class for the browser (retry, show, or give up).
 */

const NOT_FOUND = new Set(["session.not_found", "session.node_not_found"]);
const CONFLICT = new Set([
  "turn.active",
  "turn.node_id_forbidden",
  "queue.entry_locked",
  "queue.entry_not_found",
  "queue.invalid_control",
  "queue.duplicate_name",
  "queue.entry_too_large",
  "queue.too_large",
]);

export function statusForCode(code: string): number {
  if (NOT_FOUND.has(code)) return 404;
  if (CONFLICT.has(code)) return 409;
  if (code === "protocol.invalid_request") return 400;
  if (code === "daemon.unreachable" || code === "daemon.timeout") return 503;
  if (code === "protocol.invalid_response") return 502;
  return 500;
}

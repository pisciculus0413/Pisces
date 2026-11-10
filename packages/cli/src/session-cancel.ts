import { ClientError } from "./client.js";
import type { CommandIo } from "./commands.js";
import { productionSessionsDeps, type SessionsDeps, withSessionsClient } from "./sessions.js";

/**
 * `sessions cancel`: cancels the active turn of one session.
 *
 * The daemon is the only source of truth: `turn.list` is filtered by the
 * requested session id in daemon order, then every match is cancelled with
 * `turn.cancel`. No match is idempotent success (`no active turn`); a rejected
 * cancellation is a fixed failure. Already-reported cancellations stay on
 * stdout when a later one is rejected.
 */

const PROTOCOL_MESSAGE = "Invalid response from daemon";

const CANCEL_FAILED_MESSAGE = "error: turn.cancel_failed: Cancel request was not accepted";

export interface SessionCancelOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
  sessionId: string;
}

interface ActiveTurn {
  sessionId: string;
  turnId: string;
  startedAt: string;
}

function invalidResponse(): never {
  throw new ClientError("client.protocol", PROTOCOL_MESSAGE);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isName = (value: unknown): value is string => isText(value) && value.length > 0;

function parseTurns(result: unknown): ActiveTurn[] {
  if (!isRecord(result) || !Array.isArray(result.turns)) invalidResponse();
  return result.turns.map((turn: unknown) => {
    if (
      !isRecord(turn) ||
      !isName(turn.sessionId) ||
      !isName(turn.turnId) ||
      !isText(turn.startedAt)
    ) {
      invalidResponse();
    }
    return { sessionId: turn.sessionId, turnId: turn.turnId, startedAt: turn.startedAt };
  });
}

function parseCancelled(result: unknown): boolean {
  if (!isRecord(result) || typeof result.cancelled !== "boolean") invalidResponse();
  return result.cancelled;
}

export async function sessionCancel(
  options: SessionCancelOptions,
  deps: SessionsDeps = productionSessionsDeps,
): Promise<number> {
  return await withSessionsClient(options, deps, async (client, io) => {
    const turns = parseTurns(await client.request("turn.list", {}));
    const matching = turns.filter((turn) => turn.sessionId === options.sessionId);
    if (matching.length === 0) {
      io.out("no active turn");
      return 0;
    }

    for (const turn of matching) {
      const cancelled = parseCancelled(
        await client.request("turn.cancel", { turnId: turn.turnId }),
      );
      if (!cancelled) {
        io.err(CANCEL_FAILED_MESSAGE);
        return 1;
      }
      io.out(`cancelled ${turn.turnId}`);
    }
    return 0;
  });
}

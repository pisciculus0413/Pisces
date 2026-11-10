import { ClientError } from "./client.js";
import type { CommandIo } from "./commands.js";
import { productionSessionsDeps, type SessionsDeps, withSessionsClient } from "./sessions.js";

/**
 * `sessions export`: streams `session.read` pages as JSONL.
 *
 * Every printed line is the record object exactly as the daemon returned it, so
 * optional fields survive and nothing from `queue`, `selection` or `meta`
 * leaks. Pagination follows `nextCursor` until it is absent; a cursor that
 * repeats means the daemon is looping, which is reported as a protocol error
 * instead of retrying forever.
 *
 * Every request asks for a bounded page (`PAGE_LIMIT` serialized bytes), so a
 * large tree is spread over several responses instead of blowing the 4 MiB
 * response budget with `protocol.frame_too_large`.
 */

const PROTOCOL_MESSAGE = "Invalid response from daemon";

/** Serialized-byte page budget sent as `session.read` `limit` on every request. */
const PAGE_LIMIT = 262_144;

export interface SessionExportOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
  sessionId: string;
  nodeId?: string;
}

interface SessionReadPage {
  records: Record<string, unknown>[];
  nextCursor?: string;
}

function invalidResponse(): never {
  throw new ClientError("client.protocol", PROTOCOL_MESSAGE);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

function parsePage(result: unknown): SessionReadPage {
  if (!isRecord(result) || !Array.isArray(result.records)) invalidResponse();
  const records = result.records.map((record: unknown) => {
    if (
      !isRecord(record) ||
      !isText(record.id) ||
      !isText(record.parentId) ||
      !isText(record.kind) ||
      !isText(record.role) ||
      !isText(record.source) ||
      !isText(record.createdAt) ||
      typeof record.schemaVersion !== "number" ||
      !Array.isArray(record.content)
    ) {
      invalidResponse();
    }
    return record;
  });

  const { nextCursor } = result;
  if (nextCursor === undefined) return { records };
  if (!isText(nextCursor) || nextCursor === "") invalidResponse();
  return { records, nextCursor };
}

export async function sessionExport(
  options: SessionExportOptions,
  deps: SessionsDeps = productionSessionsDeps,
): Promise<number> {
  return await withSessionsClient(options, deps, async (client, io) => {
    const base =
      options.nodeId === undefined
        ? { sessionId: options.sessionId, limit: PAGE_LIMIT }
        : { sessionId: options.sessionId, nodeId: options.nodeId, limit: PAGE_LIMIT };
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      // A whole page is validated before anything is printed, so a malformed
      // page never emits a partial line.
      const page = parsePage(
        await client.request("session.read", cursor === undefined ? base : { ...base, cursor }),
      );
      for (const record of page.records) io.out(JSON.stringify(record));
      if (page.nextCursor === undefined) return 0;
      if (seen.has(page.nextCursor)) invalidResponse();
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  });
}

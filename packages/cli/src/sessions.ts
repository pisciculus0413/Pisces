import type { SessionId, SessionMeta } from "@pisces/core";
import { ClientError, connectClient, type RequestOptions, UNREACHABLE_MESSAGE } from "./client.js";
import { type CommandIo, processIo } from "./commands.js";
import { loadConfig } from "./config.js";
import { socketPathFor } from "./lifecycle.js";

/**
 * The `sessions` subcommands share one short-lived connection.
 *
 * The helper resolves the data directory exactly like the lifecycle commands,
 * opens a connection, runs the subcommand and always closes the connection.
 * Configuration, connection and protocol failures map onto the fixed CLI exit
 * codes here so every subcommand reports them identically. Session files are
 * never read directly.
 */

const CONFIG_MESSAGE = "Invalid configuration";
const PROTOCOL_MESSAGE = "Invalid response from daemon";

export interface SessionsClient {
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  close(): void;
}

/** The only production seam: tests inject a fake client factory. */
export interface SessionsDeps {
  connect(socketPath: string, timeoutMs?: number): Promise<SessionsClient>;
}

export const productionSessionsDeps: SessionsDeps = {
  connect: (socketPath, timeoutMs) => connectClient(socketPath, timeoutMs),
};

export interface SessionsOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
}

export interface SessionsListOptions extends SessionsOptions {
  json?: boolean;
}

function invalidResponse(): never {
  throw new ClientError("client.protocol", PROTOCOL_MESSAGE);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

function parseSessions(result: unknown): SessionMeta[] {
  if (!isRecord(result) || !Array.isArray(result.sessions)) invalidResponse();
  return result.sessions.map((entry) => {
    if (
      !isRecord(entry) ||
      !isText(entry.id) ||
      !isText(entry.provider) ||
      !isText(entry.model) ||
      !isText(entry.workspace) ||
      !isText(entry.createdAt) ||
      typeof entry.schemaVersion !== "number"
    ) {
      invalidResponse();
    }
    return {
      id: entry.id as SessionId,
      provider: entry.provider,
      model: entry.model,
      workspace: entry.workspace,
      createdAt: entry.createdAt,
      schemaVersion: entry.schemaVersion,
    };
  });
}

/** Newest first; ties keep the daemon order, which is otherwise unspecified. */
function newestFirst(sessions: readonly SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((left, right) => {
    if (left.createdAt === right.createdAt) return 0;
    return left.createdAt < right.createdAt ? 1 : -1;
  });
}

/**
 * Runs `run` on one connected client and maps every failure onto the fixed
 * messages. `run` returning a code keeps it; a thrown `ClientError` passes its
 * code and message through; anything else becomes `client.protocol`.
 */
export async function withSessionsClient(
  options: SessionsOptions,
  deps: SessionsDeps,
  run: (client: SessionsClient, io: CommandIo) => Promise<number>,
): Promise<number> {
  const io = options.io ?? processIo;
  let dataDir: string;
  try {
    const config = await loadConfig(options.configPath);
    dataDir = options.dataDir ?? config.dataDir;
  } catch {
    io.err(`error: config.invalid: ${CONFIG_MESSAGE}`);
    return 2;
  }

  let client: SessionsClient;
  try {
    client = await deps.connect(socketPathFor(dataDir));
  } catch {
    io.err(`error: daemon.unreachable: ${UNREACHABLE_MESSAGE}`);
    return 1;
  }

  try {
    return await run(client, io);
  } catch (error) {
    if (error instanceof ClientError) {
      io.err(`error: ${error.code}: ${error.message}`);
    } else {
      io.err(`error: client.protocol: ${PROTOCOL_MESSAGE}`);
    }
    return 1;
  } finally {
    client.close();
  }
}

/** Newest-first human output; `--json` prints the daemon result unchanged. */
export async function sessionsList(
  options: SessionsListOptions,
  deps: SessionsDeps = productionSessionsDeps,
): Promise<number> {
  return await withSessionsClient(options, deps, async (client, io) => {
    const result = await client.request("session.list", {});
    if (options.json === true) {
      io.out(JSON.stringify(result));
      return 0;
    }
    for (const session of newestFirst(parseSessions(result))) {
      io.out(
        `${session.id} ${session.provider}/${session.model} ${session.workspace} ${session.createdAt}`,
      );
    }
    return 0;
  });
}

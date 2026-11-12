import { ClientError, connectClient, UNREACHABLE_MESSAGE } from "./client.js";
import { type CommandIo, processIo } from "./commands.js";
import { loadConfig } from "./config.js";
import { socketPathFor } from "./lifecycle.js";

/**
 * The `client` management commands.
 *
 * Both commands open one short-lived protocol connection, send exactly one
 * request and close. Registration lives in the daemon: the CLI never reads an
 * extension manifest, never resolves an entry and never spawns a process.
 */

const CONFIG_MESSAGE = "Invalid configuration";
const PROTOCOL_MESSAGE = "Invalid response from daemon";

export interface ClientCommandsClient {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  close(): void;
}

/** The only production seam: tests inject a fake client factory. */
export interface ClientCommandsDeps {
  connect(socketPath: string, timeoutMs?: number): Promise<ClientCommandsClient>;
}

export const productionClientDeps: ClientCommandsDeps = {
  connect: (socketPath, timeoutMs) => connectClient(socketPath, timeoutMs),
};

export interface ClientOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
  json?: boolean;
}

/** One registered client as the daemon reports it. */
interface RegisteredClient {
  id: string;
  source: string;
  entry: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function invalidResponse(): never {
  throw new ClientError("client.protocol", PROTOCOL_MESSAGE);
}

/** Builds fresh objects so unexpected daemon fields never reach output. */
function parseClients(result: unknown): RegisteredClient[] {
  if (!isRecord(result) || !Array.isArray(result.clients)) invalidResponse();
  return (result.clients as unknown[]).map((value: unknown) => {
    if (!isRecord(value)) invalidResponse();
    const { id, source, entry } = value;
    if (!isNonEmptyText(id) || !isNonEmptyText(source) || !isNonEmptyText(entry)) invalidResponse();
    return { id, source, entry };
  });
}

function parsePid(result: unknown): number {
  if (!isRecord(result)) invalidResponse();
  const pid = result.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) invalidResponse();
  return pid;
}

/** Resolves `dataDir` exactly like the lifecycle commands, or prints `config.invalid`. */
async function resolveDataDir(options: ClientOptions, io: CommandIo): Promise<string | undefined> {
  let dataDir: string;
  try {
    const config = await loadConfig(options.configPath);
    dataDir = options.dataDir ?? config.dataDir;
  } catch {
    io.err(`error: config.invalid: ${CONFIG_MESSAGE}`);
    return undefined;
  }
  return dataDir;
}

async function withClient(
  options: ClientOptions,
  deps: ClientCommandsDeps,
  run: (client: ClientCommandsClient) => Promise<number>,
): Promise<number> {
  const io = options.io ?? processIo;
  const dataDir = await resolveDataDir(options, io);
  if (dataDir === undefined) return 2;

  let client: ClientCommandsClient;
  try {
    client = await deps.connect(socketPathFor(dataDir));
  } catch {
    io.err(`error: daemon.unreachable: ${UNREACHABLE_MESSAGE}`);
    return 1;
  }

  try {
    return await run(client);
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

/** `pisces client list`: one `id  source` line per registered client. */
export async function clientList(
  options: ClientOptions,
  deps: ClientCommandsDeps = productionClientDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  return await withClient(options, deps, async (client) => {
    const clients = parseClients(await client.request("client.list", {}));
    if (options.json === true) {
      io.out(JSON.stringify({ clients }));
      return 0;
    }
    for (const entry of clients) io.out(`${entry.id}  ${entry.source}`);
    return 0;
  });
}

/** `pisces client start <id>`: asks the daemon to launch one client and reports the pid. */
export async function clientStart(
  options: ClientOptions & { id: string },
  deps: ClientCommandsDeps = productionClientDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  return await withClient(options, deps, async (client) => {
    const result = await client.request("client.start", { id: options.id });
    const pid = parsePid(result);
    if (options.json === true) {
      io.out(JSON.stringify({ pid }));
      return 0;
    }
    io.out(`started ${options.id} (pid ${pid})`);
    return 0;
  });
}

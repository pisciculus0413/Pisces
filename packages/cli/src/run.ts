import type { ProtocolEvent } from "@pisces/protocol";
import { type Client, ClientError, connectClient, UNREACHABLE_MESSAGE } from "./client.js";
import { type CommandIo, processIo } from "./commands.js";
import { loadConfig } from "./config.js";
import { socketPathFor } from "./lifecycle.js";

/**
 * Non-interactive `pisces run`: selects or creates one session, applies its
 * options, queues the prompt, starts a turn and waits for that turn to end.
 *
 * The daemon is the only source of truth; this module only composes protocol
 * methods and never writes prompts into request bodies. Protocol and session
 * failures are reported with their fixed codes and messages, and configuration
 * values or raw exceptions never reach the terminal.
 */

const CONFIG_MESSAGE = "Invalid configuration";
const PROTOCOL_MESSAGE = "Invalid response from daemon";
const SESSION_NOT_FOUND_MESSAGE = "Session does not exist";
const DEFAULT_PROMPT_MESSAGE = "Default system prompt applies only to new sessions";

export interface RunOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
  prompt: string;
  newSession: boolean;
  continueSession: boolean;
  sessionId?: string;
  create: boolean;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  useDefaultSystemPrompt: boolean;
  enable: string[];
  disable: string[];
  print: boolean;
  json: boolean;
}

/** The only production seams: one connection factory and the Ctrl-C listener. */
export interface RunDeps {
  connect(socketPath: string, timeoutMs?: number): Promise<Client>;
  onInterrupt(handler: () => void): () => void;
}

export const productionRunDeps: RunDeps = {
  connect: (socketPath, timeoutMs) => connectClient(socketPath, timeoutMs),
  onInterrupt(handler) {
    process.once("SIGINT", handler);
    return () => {
      process.off("SIGINT", handler);
    };
  },
};

interface SessionMeta {
  id: string;
  createdAt: string;
}

interface EndedTurn {
  sessionId: string;
  turnId: string;
  reason: "completed" | "cancelled" | "failed";
  error?: { code: string; message: string };
}

interface Cleanup {
  listener?: () => void;
  interrupt?: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function invalidResponse(): never {
  throw new ClientError("client.protocol", PROTOCOL_MESSAGE);
}

function parseMeta(value: unknown): SessionMeta {
  if (
    !isRecord(value) ||
    !isName(value.id) ||
    !isName(value.provider) ||
    !isName(value.model) ||
    !isName(value.workspace) ||
    typeof value.createdAt !== "string" ||
    typeof value.schemaVersion !== "number"
  ) {
    invalidResponse();
  }
  return { id: value.id, createdAt: value.createdAt };
}

function parseSessions(value: unknown): SessionMeta[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) invalidResponse();
  return value.sessions.map((session: unknown) => parseMeta(session));
}

function parseReadMeta(value: unknown): SessionMeta {
  if (!isRecord(value)) invalidResponse();
  return parseMeta(value.meta);
}

function parseSelection(value: unknown): string[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.selection) ||
    !value.selection.every((entry: unknown) => typeof entry === "string")
  ) {
    invalidResponse();
  }
  return value.selection as string[];
}

function parseSubscribe(value: unknown): void {
  if (!isRecord(value) || !isName(value.sessionId)) invalidResponse();
}

function parseIds(value: unknown): void {
  if (
    !isRecord(value) ||
    !Array.isArray(value.ids) ||
    !value.ids.every((id: unknown) => typeof id === "string")
  ) {
    invalidResponse();
  }
}

function parseTurnStart(value: unknown): { turnId: string; mode: "new" | "steer" } {
  if (
    !isRecord(value) ||
    !isName(value.turnId) ||
    (value.mode !== "new" && value.mode !== "steer")
  ) {
    invalidResponse();
  }
  return { turnId: value.turnId, mode: value.mode };
}

/** Selector, output and toggle-combination conflicts rejected before any side effect. */
function invalidUsage(options: RunOptions): boolean {
  if (options.prompt.trim() === "") return true;
  const selectors =
    Number(options.newSession) +
    Number(options.continueSession) +
    (options.sessionId === undefined ? 0 : 1);
  if (selectors > 1) return true;
  if (options.create && options.sessionId === undefined) return true;
  if (options.print && options.json) return true;
  if (options.systemPrompt !== undefined && options.useDefaultSystemPrompt) return true;

  const names = new Set<string>();
  for (const name of [...options.enable, ...options.disable]) {
    if (name.length === 0 || names.has(name)) return true;
    names.add(name);
  }
  return false;
}

async function createSession(client: Client, options: RunOptions): Promise<SessionMeta> {
  const params: Record<string, unknown> = {};
  if (options.provider !== undefined) params.provider = options.provider;
  if (options.model !== undefined) params.model = options.model;
  if (options.systemPrompt !== undefined) params.systemPrompt = [options.systemPrompt];
  return parseMeta(await client.request("session.create", params));
}

export async function runCommand(
  options: RunOptions,
  deps: RunDeps = productionRunDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  if (invalidUsage(options)) return 2;

  let dataDir: string;
  try {
    const config = await loadConfig(options.configPath);
    dataDir = options.dataDir ?? config.dataDir;
  } catch {
    io.err(`error: config.invalid: ${CONFIG_MESSAGE}`);
    return 2;
  }

  let client: Client;
  try {
    client = await deps.connect(socketPathFor(dataDir));
  } catch {
    io.err(`error: daemon.unreachable: ${UNREACHABLE_MESSAGE}`);
    return 1;
  }

  const cleanup: Cleanup = {};
  try {
    return await execute(client, options, io, deps, cleanup);
  } catch (error) {
    if (error instanceof ClientError) {
      io.err(`error: ${error.code}: ${error.message}`);
    } else {
      io.err(`error: client.protocol: ${PROTOCOL_MESSAGE}`);
    }
    return 1;
  } finally {
    cleanup.listener?.();
    cleanup.interrupt?.();
    client.close();
  }
}

async function execute(
  client: Client,
  options: RunOptions,
  io: CommandIo,
  deps: RunDeps,
  cleanup: Cleanup,
): Promise<number> {
  let sessionId: string | undefined;
  let startedTurnId: string | undefined;
  let ending: EndedTurn | undefined;
  let buffered: ProtocolEvent[] = [];
  let interrupted = false;
  let cancelSent = false;
  let text = "";
  let settleEnded: ((value: EndedTurn) => void) | undefined;
  const ended = new Promise<EndedTurn>((resolve) => {
    settleEnded = resolve;
  });
  const stream = !options.print && !options.json;
  const write = io.write ?? ((value: string) => io.out(value));

  const processEvent = (event: ProtocolEvent): void => {
    if (ending !== undefined || startedTurnId === undefined || sessionId === undefined) return;
    if (!isRecord(event.data)) return;
    const data = event.data;
    if (data.sessionId !== sessionId || data.turnId !== startedTurnId) return;

    if (event.event === "turn.delta") {
      if (data.kind !== "text" || typeof data.delta !== "string") return;
      text += data.delta;
      if (stream) write(data.delta);
      return;
    }

    if (event.event !== "turn.ended") return;
    const reason = data.reason;
    if (reason !== "completed" && reason !== "cancelled" && reason !== "failed") return;
    let error: { code: string; message: string } | undefined;
    if (reason === "failed") {
      const raw = data.error;
      error =
        isRecord(raw) && typeof raw.code === "string" && typeof raw.message === "string"
          ? { code: raw.code, message: raw.message }
          : { code: "internal.error", message: "Turn failed" };
    }
    ending = { sessionId, turnId: startedTurnId, reason, ...(error ? { error } : {}) };
    settleEnded?.(ending);
  };

  cleanup.listener = client.onEvent((event) => {
    // Events are not buffered by the client, so anything that arrives before the
    // turn id is known is held here and replayed once `turn.start` returns.
    if (startedTurnId === undefined) {
      buffered.push(event);
      return;
    }
    processEvent(event);
  });

  const cancel = (): void => {
    if (!interrupted || cancelSent || startedTurnId === undefined || ending !== undefined) return;
    cancelSent = true;
    void client.request("turn.cancel", { turnId: startedTurnId }).catch(() => {});
  };
  cleanup.interrupt = deps.onInterrupt(() => {
    interrupted = true;
    cancel();
  });

  let existing = false;
  if (options.continueSession) {
    const sessions = parseSessions(await client.request("session.list", {}));
    if (sessions.length === 0)
      throw new ClientError("session.not_found", SESSION_NOT_FOUND_MESSAGE);
    let newest = sessions[0] as SessionMeta;
    for (const session of sessions) {
      if (session.createdAt > newest.createdAt) newest = session;
    }
    sessionId = newest.id;
    existing = true;
  } else if (options.sessionId === undefined) {
    sessionId = (await createSession(client, options)).id;
  } else {
    try {
      sessionId = parseReadMeta(
        await client.request("session.read", { sessionId: options.sessionId }),
      ).id;
      existing = true;
    } catch (error) {
      if (options.create && error instanceof ClientError && error.code === "session.not_found") {
        sessionId = (await createSession(client, options)).id;
      } else {
        throw error;
      }
    }
  }

  if (existing) {
    if (options.useDefaultSystemPrompt) {
      throw new ClientError("run.default_system_prompt_unsupported", DEFAULT_PROMPT_MESSAGE);
    }
    if (
      options.model !== undefined ||
      options.provider !== undefined ||
      options.systemPrompt !== undefined
    ) {
      const params: Record<string, unknown> = { sessionId };
      if (options.model !== undefined) params.model = options.model;
      if (options.provider !== undefined) params.provider = options.provider;
      if (options.systemPrompt !== undefined) params.systemPrompt = options.systemPrompt;
      parseMeta(await client.request("session.configure", params));
    }
  }

  let control: Record<string, unknown> | undefined;
  if (options.enable.length > 0 || options.disable.length > 0) {
    const selected = new Set(
      parseSelection(await client.request("entries.snapshot", { sessionId })),
    );
    const toggle = [
      ...options.enable.filter((name) => !selected.has(name)),
      ...options.disable.filter((name) => selected.has(name)),
    ];
    if (toggle.length > 0) {
      control = {
        kind: "control",
        role: "declaration",
        source: "run",
        content: [{ type: "text", text: JSON.stringify({ toggle }) }],
      };
    }
  }

  parseSubscribe(await client.request("session.subscribe", { sessionId }));

  const prompt = {
    kind: "agent",
    role: "user",
    source: "run",
    content: [{ type: "text", text: options.prompt }],
  };
  parseIds(
    await client.request("queue.enqueue", {
      sessionId,
      entries: control === undefined ? [prompt] : [control, prompt],
    }),
  );

  const started = parseTurnStart(await client.request("turn.start", { sessionId }));
  startedTurnId = started.turnId;
  const pending = buffered;
  buffered = [];
  for (const event of pending) processEvent(event);
  if (interrupted) cancel();

  const result = await ended;

  if (options.json) {
    io.out(
      JSON.stringify({
        sessionId: result.sessionId,
        turnId: result.turnId,
        reason: result.reason,
        text,
        ...(result.error === undefined ? {} : { error: result.error }),
      }),
    );
  } else if (options.print) {
    io.out(text);
  } else if (io.write === undefined) {
    // `io.out` appends its own newline; an empty line ends the streamed text.
    io.out("");
  } else {
    io.write("\n");
  }

  if (result.reason === "failed") {
    if (!options.json && result.error !== undefined) {
      io.err(`error: ${result.error.code}: ${result.error.message}`);
    }
    return 1;
  }
  return result.reason === "cancelled" ? 130 : 0;
}

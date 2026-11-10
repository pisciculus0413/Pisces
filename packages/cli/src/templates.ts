import type { TemplateInfo, TemplatePreview } from "@pisces/core";
import {
  type Client,
  ClientError,
  connectClient,
  type RequestOptions,
  UNREACHABLE_MESSAGE,
} from "./client.js";
import { type CommandIo, processIo } from "./commands.js";
import { loadConfig } from "./config.js";
import { socketPathFor } from "./lifecycle.js";

/**
 * The `templates` subcommands: `list`, `preview` and `apply`.
 *
 * Every command resolves the data directory exactly like the lifecycle
 * commands, opens one short-lived protocol connection, sends a single request
 * and closes. Usage errors exit 2 before a socket is opened; protocol failures
 * print `error: <code>: <message>` and exit 1. Template file contents are never
 * echoed by `apply`; `preview` only prints paths and the script argv.
 */

export const TEMPLATES_USAGE = [
  "usage: pisces templates <command> [options]",
  "",
  "commands:",
  "  list                                   list available templates",
  "  preview <id> --workspace <dir>         show what applying a template would create",
  "  apply <id> --workspace <dir> --confirm",
  "                                         create the directories, files and session",
  "",
  "options:",
  "  --workspace <dir>   target workspace directory",
  "  --confirm           required by apply; the harness never applies silently",
  "  --overwrite         replace files that already exist (apply only)",
  "  --config <path>     configuration file",
  "  --data-dir <path>   override the configured data directory",
  "  --json              print the raw protocol result",
].join("\n");

const CONFIG_MESSAGE = "Invalid configuration";
const PROTOCOL_MESSAGE = "Invalid response from daemon";

/**
 * `template.apply` budget: the 600 s `initScript` cap plus 60 s of I/O.
 * Every other request keeps the 5 s client default.
 */
export const APPLY_REQUEST_TIMEOUT_MS = 660_000;

export interface TemplatesClient {
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  close(): void;
}

/** The only production seam: tests inject a fake client factory. */
export interface TemplatesDeps {
  connect(socketPath: string, timeoutMs?: number): Promise<TemplatesClient>;
}

export const productionTemplatesDeps: TemplatesDeps = {
  connect: (socketPath, timeoutMs) => connectClient(socketPath, timeoutMs),
};

export interface TemplatesOptions {
  configPath: string;
  dataDir?: string;
  io?: CommandIo;
  json?: boolean;
}

export interface TemplatesPreviewOptions extends TemplatesOptions {
  templateId: string;
  workspace: string;
}

export interface TemplatesApplyOptions extends TemplatesPreviewOptions {
  confirm: boolean;
  overwrite?: boolean;
}

function invalidResponse(): never {
  throw new ClientError("client.protocol", PROTOCOL_MESSAGE);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

const isTextArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);

/** Resolves `dataDir` the same way lifecycle commands do, or prints `config.invalid`. */
async function resolveDataDir(
  options: TemplatesOptions,
  io: CommandIo,
): Promise<string | undefined> {
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
  options: TemplatesOptions,
  deps: TemplatesDeps,
  run: (client: Client, io: CommandIo) => Promise<number>,
): Promise<number> {
  const io = options.io ?? processIo;
  const dataDir = await resolveDataDir(options, io);
  if (dataDir === undefined) return 2;

  let client: Client;
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

function parseTemplates(result: unknown): TemplateInfo[] {
  if (!isRecord(result) || !Array.isArray(result.templates)) invalidResponse();
  return result.templates.map((entry) => {
    if (!isRecord(entry) || !isText(entry.id) || !isText(entry.name)) invalidResponse();
    return {
      id: entry.id,
      name: entry.name,
      ...(isText(entry.description) ? { description: entry.description } : {}),
    };
  });
}

function parsePreview(result: unknown): TemplatePreview {
  if (!isRecord(result)) invalidResponse();
  if (!isTextArray(result.directories) || !isTextArray(result.conflicts)) invalidResponse();
  if (!Array.isArray(result.files)) invalidResponse();
  const files: { path: string; content: string }[] = [];
  for (const file of result.files) {
    if (!isRecord(file) || !isText(file.path) || !isText(file.content)) invalidResponse();
    files.push({ path: file.path, content: file.content });
  }
  const preview: TemplatePreview = {
    directories: result.directories,
    files,
    conflicts: result.conflicts,
  };
  if (result.initScript !== undefined) {
    const script = result.initScript;
    if (
      !isRecord(script) ||
      !isText(script.command) ||
      !isTextArray(script.args) ||
      typeof script.timeoutMs !== "number" ||
      !Number.isInteger(script.timeoutMs) ||
      script.timeoutMs <= 0
    ) {
      invalidResponse();
    }
    preview.initScript = {
      command: script.command,
      args: script.args,
      timeoutMs: script.timeoutMs,
    };
  }
  return preview;
}

function parseApply(result: unknown): { projectId: string; sessionId: string } {
  if (!isRecord(result) || !isText(result.projectId) || !isText(result.sessionId)) {
    invalidResponse();
  }
  return { projectId: result.projectId, sessionId: result.sessionId };
}

function printPreview(preview: TemplatePreview, io: CommandIo): void {
  io.out("directories:");
  for (const directory of preview.directories) io.out(`  ${directory}`);
  io.out("files:");
  for (const file of preview.files) io.out(`  ${file.path}`);
  io.out("conflicts:");
  for (const conflict of preview.conflicts) io.out(`  ${conflict}`);
  if (preview.initScript !== undefined) {
    const { command, args, timeoutMs } = preview.initScript;
    io.out(`script: ${[command, ...args].join(" ")}`);
    io.out(`timeout: ${timeoutMs}ms`);
  }
}

export async function templatesList(
  options: TemplatesOptions,
  deps: TemplatesDeps = productionTemplatesDeps,
): Promise<number> {
  return await withClient(options, deps, async (client, io) => {
    const result = await client.request("template.list", {});
    if (options.json === true) {
      io.out(JSON.stringify(result));
      return 0;
    }
    for (const template of parseTemplates(result)) {
      const line = `${template.id}  ${template.name}`;
      io.out(template.description === undefined ? line : `${line} - ${template.description}`);
    }
    return 0;
  });
}

export async function templatesPreview(
  options: TemplatesPreviewOptions,
  deps: TemplatesDeps = productionTemplatesDeps,
): Promise<number> {
  return await withClient(options, deps, async (client, io) => {
    const result = await client.request("template.preview", {
      templateId: options.templateId,
      workspace: options.workspace,
    });
    if (options.json === true) {
      io.out(JSON.stringify(result));
      return 0;
    }
    printPreview(parsePreview(result), io);
    return 0;
  });
}

export async function templatesApply(
  options: TemplatesApplyOptions,
  deps: TemplatesDeps = productionTemplatesDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  // Guard the destructive path before any config read or socket: a refused
  // apply must have no side effect at all.
  if (!options.confirm) {
    io.err(TEMPLATES_USAGE);
    return 2;
  }
  return await withClient(options, deps, async (client, output) => {
    const result = await client.request(
      "template.apply",
      {
        templateId: options.templateId,
        workspace: options.workspace,
        confirmed: true,
        ...(options.overwrite === true ? { overwrite: true } : {}),
      },
      { timeoutMs: APPLY_REQUEST_TIMEOUT_MS },
    );
    if (options.json === true) {
      output.out(JSON.stringify(result));
      return 0;
    }
    const { projectId, sessionId } = parseApply(result);
    output.out(`project ${projectId} session ${sessionId}`);
    return 0;
  });
}

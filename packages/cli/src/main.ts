#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  type CommandDeps,
  type CommandIo,
  type CommandOptions,
  processIo,
  productionDeps,
  startCommand,
  statusCommand,
  stopCommand,
} from "./commands.js";
import { defaultConfigPath } from "./config.js";
import { isEntryPath } from "./entry.js";
import {
  productionTemplatesDeps,
  type TemplatesDeps,
  templatesApply,
  templatesList,
  templatesPreview,
} from "./templates.js";

export { isEntryPath };

/**
 * `pisces` entry point: argument parsing plus dispatch to the lifecycle commands.
 *
 * `runCli` is pure with respect to process globals except the environment used
 * by config resolution, so tests drive it with a fake io and fake deps. The
 * module only assigns `process.exitCode` when it is executed as the entry.
 */

export const USAGE = [
  "usage: pisces <command> [options]",
  "",
  "commands:",
  "  start    start the daemon in the background",
  "  status   report the daemon state",
  "  stop     stop the daemon",
  "  templates  list, preview or apply a template",
  "",
  "options:",
  "  --config <path>     configuration file (default: <config home>/pisces/config.json)",
  "  --data-dir <path>   override the configured data directory",
  "  --json              machine-readable output (status and templates)",
  "  --help              show this help",
  "  --version           print the version",
].join("\n");

const COMMANDS = ["start", "status", "stop"] as const;
type Command = (typeof COMMANDS)[number];

const TEMPLATES_SUBS = ["list", "preview", "apply"] as const;
type TemplatesSub = (typeof TEMPLATES_SUBS)[number];

interface LifecycleParsed {
  command: Command;
  configPath?: string;
  dataDir?: string;
  json: boolean;
}

interface TemplatesCommon {
  configPath?: string;
  dataDir?: string;
  json: boolean;
}

type TemplatesParsed =
  | (TemplatesCommon & { command: "templates"; sub: "list" })
  | (TemplatesCommon & {
      command: "templates";
      sub: "preview";
      templateId: string;
      workspace: string;
    })
  | (TemplatesCommon & {
      command: "templates";
      sub: "apply";
      templateId: string;
      workspace: string;
      overwrite: boolean;
    });

type Outcome = LifecycleParsed | TemplatesParsed | "help" | "version" | undefined;

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

const isTemplatesSub = (value: string | undefined): value is TemplatesSub =>
  value !== undefined && (TEMPLATES_SUBS as readonly string[]).includes(value);

async function version(): Promise<string> {
  try {
    const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Returns a parsed request, `"help"`, `"version"` or `undefined` for a usage error. */
async function parse(argv: readonly string[]): Promise<Outcome> {
  const command = argv[0];
  if (command === "--help") return "help";
  if (command === "--version") return "version";
  // Help and version are only global as the first argument; after a bad command
  // they must not turn a usage error into a success.
  if (command === "templates") return parseTemplates(argv);
  if (command === undefined || !isCommand(command)) return undefined;

  let configPath: string | undefined;
  let dataDir: string | undefined;
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return "help";
    if (argument === "--version") return "version";
    if (argument === "--json") {
      if (command !== "status") return undefined;
      json = true;
      continue;
    }
    if (argument !== "--config" && argument !== "--data-dir") return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) return undefined;
    if (argument === "--config") configPath = value;
    else dataDir = value;
    index += 1;
  }

  const parsed: LifecycleParsed = { command, json };
  if (configPath !== undefined) parsed.configPath = configPath;
  if (dataDir !== undefined) parsed.dataDir = dataDir;
  return parsed;
}

/** `templates <list|preview|apply>`; `undefined` is always a usage error. */
function parseTemplates(argv: readonly string[]): TemplatesParsed | "help" | "version" | undefined {
  const sub = argv[1];
  if (sub === "--help") return "help";
  if (sub === "--version") return "version";
  if (!isTemplatesSub(sub)) return undefined;

  const common: TemplatesCommon = { json: false };
  let templateId: string | undefined;
  let workspace: string | undefined;
  let confirm = false;
  let overwrite = false;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return "help";
    if (argument === "--version") return "version";
    if (argument === "--json") {
      common.json = true;
      continue;
    }
    if (argument === "--confirm") {
      if (sub !== "apply") return undefined;
      confirm = true;
      continue;
    }
    if (argument === "--overwrite") {
      if (sub !== "apply") return undefined;
      overwrite = true;
      continue;
    }
    if (argument === "--config" || argument === "--data-dir" || argument === "--workspace") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (argument === "--config") common.configPath = value;
      else if (argument === "--data-dir") common.dataDir = value;
      else if (sub === "list") return undefined;
      else workspace = value;
      index += 1;
      continue;
    }
    // Any leftover positional is the template id, and only one is accepted.
    if (argument === undefined || argument.startsWith("-")) return undefined;
    if (sub === "list" || templateId !== undefined) return undefined;
    templateId = argument;
  }

  if (sub === "list") {
    if (templateId !== undefined || workspace !== undefined) return undefined;
    return { command: "templates", sub, ...common };
  }
  if (templateId === undefined || workspace === undefined) return undefined;
  if (sub === "preview") {
    if (confirm || overwrite) return undefined;
    return { command: "templates", sub, ...common, templateId, workspace };
  }
  // Applying is destructive, so a missing `--confirm` is a usage error and
  // nothing is ever sent.
  if (!confirm) return undefined;
  return { command: "templates", sub, ...common, templateId, workspace, overwrite };
}

export async function runCli(
  argv: string[],
  io: CommandIo = processIo,
  deps: CommandDeps = productionDeps,
  templateDeps: TemplatesDeps = productionTemplatesDeps,
): Promise<number> {
  const parsed = await parse(argv);

  if (parsed === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed === "version") {
    io.out(`pisces ${await version()}`);
    return 0;
  }
  if (parsed === undefined) {
    io.err(USAGE);
    return 2;
  }

  if (parsed.command === "templates") {
    const common = {
      configPath: parsed.configPath ?? defaultConfigPath(process.env),
      io,
      json: parsed.json,
      ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
    };
    switch (parsed.sub) {
      case "list":
        return await templatesList(common, templateDeps);
      case "preview":
        return await templatesPreview(
          { ...common, templateId: parsed.templateId, workspace: parsed.workspace },
          templateDeps,
        );
      default:
        return await templatesApply(
          {
            ...common,
            templateId: parsed.templateId,
            workspace: parsed.workspace,
            confirm: true,
            overwrite: parsed.overwrite,
          },
          templateDeps,
        );
    }
  }

  const options: CommandOptions = {
    configPath: parsed.configPath ?? defaultConfigPath(process.env),
    io,
    ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
  };

  switch (parsed.command) {
    case "start":
      return await startCommand(options, deps);
    case "status":
      return await statusCommand({ ...options, json: parsed.json }, deps);
    default:
      return await stopCommand(options, deps);
  }
}

if (isEntryPath(process.argv[1], import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), processIo);
}

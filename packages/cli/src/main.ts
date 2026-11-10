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
import {
  type ConfigCommandOptions,
  configGet,
  configList,
  configSet,
  configUnset,
} from "./config-commands.js";
import { isEntryPath } from "./entry.js";
import { extensionsList } from "./extensions.js";
import {
  modelsList,
  type ProvidersDeps,
  productionProvidersDeps,
  providerList,
} from "./providers.js";
import { sessionCancel } from "./session-cancel.js";
import { sessionExport } from "./session-export.js";
import { productionSessionsDeps, type SessionsDeps, sessionsList } from "./sessions.js";
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
  "  config     list, get, set or unset configuration values",
  "  extensions list discovered extensions without loading them",
  "  sessions   list, export or cancel sessions",
  "  provider   list providers known to the daemon",
  "  models     list models of every provider",
  "",
  "options:",
  "  --config <path>     configuration file (default: <config home>/pisces/config.json)",
  "  --data-dir <path>   override the configured data directory",
  "  --provider <id>     only list models of this provider (models list)",
  "  --node <id>         export only this node's branch (sessions export)",
  "  --scope <scope>     config scope: global (default) or workspace",
  "  --workspace <dir>   workspace directory (config workspace scope, extensions list)",
  "  --json              machine-readable output (status, templates, config, extensions,",
  "                      sessions list, provider, models)",
  "  --help              show this help",
  "  --version           print the version",
].join("\n");

const COMMANDS = ["start", "status", "stop"] as const;
type Command = (typeof COMMANDS)[number];

const TEMPLATES_SUBS = ["list", "preview", "apply"] as const;
type TemplatesSub = (typeof TEMPLATES_SUBS)[number];

const CONFIG_SUBS = ["list", "get", "set", "unset"] as const;
type ConfigSub = (typeof CONFIG_SUBS)[number];

const EXTENSIONS_SUBS = ["list"] as const;
type ExtensionsSub = (typeof EXTENSIONS_SUBS)[number];

const SESSIONS_SUBS = ["list", "export", "cancel"] as const;
type SessionsSub = (typeof SESSIONS_SUBS)[number];

const PROVIDER_SUBS = ["list"] as const;
type ProviderSub = (typeof PROVIDER_SUBS)[number];

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

interface ConfigCommon {
  command: "config";
  configPath?: string;
  scope: "global" | "workspace";
  workspace?: string;
  json: boolean;
}

interface SessionsCommon {
  command: "sessions";
  configPath?: string;
  dataDir?: string;
}

type SessionsParsed =
  | (SessionsCommon & { sub: "list"; json: boolean })
  | (SessionsCommon & { sub: "export"; sessionId: string; nodeId?: string })
  | (SessionsCommon & { sub: "cancel"; sessionId: string });

type ConfigParsed =
  | (ConfigCommon & { sub: "list" })
  | (ConfigCommon & { sub: "get"; path: string })
  | (ConfigCommon & { sub: "unset"; path: string })
  | (ConfigCommon & { sub: "set"; path: string; value: string });

interface ExtensionsParsed {
  command: "extensions";
  sub: "list";
  configPath?: string;
  workspace?: string;
  json: boolean;
}

interface ProviderCommon {
  configPath?: string;
  dataDir?: string;
  json: boolean;
}

type ProvidersParsed =
  | (ProviderCommon & { command: "provider"; sub: ProviderSub })
  | (ProviderCommon & { command: "models"; sub: ProviderSub; provider?: string });

type Outcome =
  | LifecycleParsed
  | TemplatesParsed
  | ConfigParsed
  | ExtensionsParsed
  | SessionsParsed
  | ProvidersParsed
  | "help"
  | "version"
  | undefined;

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

const isTemplatesSub = (value: string | undefined): value is TemplatesSub =>
  value !== undefined && (TEMPLATES_SUBS as readonly string[]).includes(value);

const isConfigSub = (value: string | undefined): value is ConfigSub =>
  value !== undefined && (CONFIG_SUBS as readonly string[]).includes(value);

const isExtensionsSub = (value: string | undefined): value is ExtensionsSub =>
  value !== undefined && (EXTENSIONS_SUBS as readonly string[]).includes(value);

const isSessionsSub = (value: string | undefined): value is SessionsSub =>
  value !== undefined && (SESSIONS_SUBS as readonly string[]).includes(value);

const isProviderSub = (value: string | undefined): value is ProviderSub =>
  value !== undefined && (PROVIDER_SUBS as readonly string[]).includes(value);

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
  if (command === "config") return parseConfig(argv);
  if (command === "extensions") return parseExtensions(argv);
  if (command === "sessions") return parseSessions(argv);
  if (command === "provider") return parseProviders(argv, "provider");
  if (command === "models") return parseProviders(argv, "models");
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

/**
 * `config <list|get|set|unset>`; `undefined` is always a usage error.
 *
 * `--workspace` only makes sense together with `--scope workspace`, and
 * `--json` only for the read-only subcommands.
 */
function parseConfig(argv: readonly string[]): ConfigParsed | "help" | "version" | undefined {
  const sub = argv[1];
  if (sub === "--help") return "help";
  if (sub === "--version") return "version";
  if (!isConfigSub(sub)) return undefined;

  let configPath: string | undefined;
  let scope: "global" | "workspace" = "global";
  let workspace: string | undefined;
  let json = false;
  const positionals: string[] = [];

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (argument === "--help") return "help";
    if (argument === "--version") return "version";
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--config" || argument === "--workspace" || argument === "--scope") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (argument === "--config") configPath = value;
      else if (argument === "--workspace") workspace = value;
      else if (value === "global" || value === "workspace") scope = value;
      else return undefined;
      index += 1;
      continue;
    }
    // JSON values may start with `-`, so every other token is a positional.
    positionals.push(argument);
  }

  if (workspace !== undefined && scope !== "workspace") return undefined;

  const common = {
    command: "config" as const,
    scope,
    json,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
  };

  if (sub === "list") {
    if (positionals.length !== 0) return undefined;
    return { ...common, sub };
  }
  if (sub === "set") {
    if (json) return undefined;
    const [path, value] = positionals;
    if (positionals.length !== 2 || path === undefined || value === undefined) return undefined;
    return { ...common, sub, path, value };
  }
  if (json && sub === "unset") return undefined;
  const path = positionals[0];
  if (positionals.length !== 1 || path === undefined) return undefined;
  return { ...common, sub, path };
}

/** `extensions <list>`; `undefined` is always a usage error. */
function parseExtensions(
  argv: readonly string[],
): ExtensionsParsed | "help" | "version" | undefined {
  const sub = argv[1];
  if (sub === "--help") return "help";
  if (sub === "--version") return "version";
  if (!isExtensionsSub(sub)) return undefined;

  let configPath: string | undefined;
  let workspace: string | undefined;
  let json = false;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return "help";
    if (argument === "--version") return "version";
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--config" || argument === "--workspace") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (argument === "--config") configPath = value;
      else workspace = value;
      index += 1;
      continue;
    }
    // `list` takes no positionals.
    return undefined;
  }

  const parsed: ExtensionsParsed = { command: "extensions", sub, json };
  if (configPath !== undefined) parsed.configPath = configPath;
  if (workspace !== undefined) parsed.workspace = workspace;
  return parsed;
}

/**
 * `sessions <list|export|cancel>`; `undefined` is always a usage error.
 *
 * `--json` belongs to `list` only, `--node` to `export` only, and `export` and
 * `cancel` take exactly one positional session id.
 */
function parseSessions(argv: readonly string[]): SessionsParsed | "help" | "version" | undefined {
  const sub = argv[1];
  if (sub === "--help") return "help";
  if (sub === "--version") return "version";
  if (!isSessionsSub(sub)) return undefined;

  let configPath: string | undefined;
  let dataDir: string | undefined;
  let nodeId: string | undefined;
  let json = false;
  const positionals: string[] = [];

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (argument === "--help") return "help";
    if (argument === "--version") return "version";
    if (argument === "--json") {
      if (sub !== "list") return undefined;
      json = true;
      continue;
    }
    if (argument === "--config" || argument === "--data-dir" || argument === "--node") {
      // `--node` only exists for `export`; anywhere else it is unknown.
      if (argument === "--node" && sub !== "export") return undefined;
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) return undefined;
      if (argument === "--config") configPath = value;
      else if (argument === "--data-dir") dataDir = value;
      else nodeId = value;
      index += 1;
      continue;
    }
    // Unknown flags and leftover positionals are both usage errors.
    if (argument.startsWith("-") || sub === "list") return undefined;
    positionals.push(argument);
  }

  const common: SessionsCommon = {
    command: "sessions",
    ...(configPath !== undefined ? { configPath } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
  if (sub === "list") return { ...common, sub, json };

  const [sessionId] = positionals;
  if (positionals.length !== 1 || sessionId === undefined) return undefined;
  if (sub === "export") {
    return { ...common, sub, sessionId, ...(nodeId !== undefined ? { nodeId } : {}) };
  }
  return { ...common, sub, sessionId };
}

/** `provider list` and `models list`; `undefined` is always a usage error. */
function parseProviders(
  argv: readonly string[],
  command: "provider" | "models",
): ProvidersParsed | "help" | "version" | undefined {
  const sub = argv[1];
  if (sub === "--help") return "help";
  if (sub === "--version") return "version";
  if (!isProviderSub(sub)) return undefined;

  let configPath: string | undefined;
  let dataDir: string | undefined;
  let provider: string | undefined;
  let json = false;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return "help";
    if (argument === "--version") return "version";
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--config" || argument === "--data-dir" || argument === "--provider") {
      // `--provider` only exists for `models list`; anywhere else it is unknown.
      if (argument === "--provider" && command !== "models") return undefined;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (argument === "--config") configPath = value;
      else if (argument === "--data-dir") dataDir = value;
      else provider = value;
      index += 1;
      continue;
    }
    // `list` takes no positionals.
    return undefined;
  }

  const common: ProviderCommon & { sub: ProviderSub } = {
    sub,
    json,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
  if (command === "provider") return { command, ...common };
  return { command, ...common, ...(provider !== undefined ? { provider } : {}) };
}

export async function runCli(
  argv: string[],
  io: CommandIo = processIo,
  deps: CommandDeps = productionDeps,
  templateDeps: TemplatesDeps = productionTemplatesDeps,
  sessionDeps: SessionsDeps = productionSessionsDeps,
  providerDeps: ProvidersDeps = productionProvidersDeps,
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

  if (parsed.command === "config") {
    const options: ConfigCommandOptions = {
      configPath: parsed.configPath ?? defaultConfigPath(process.env),
      scope: parsed.scope,
      json: parsed.json,
      io,
      ...(parsed.workspace !== undefined ? { workspace: parsed.workspace } : {}),
    };
    switch (parsed.sub) {
      case "list":
        return await configList(options);
      case "get":
        return await configGet({ ...options, path: parsed.path });
      case "unset":
        return await configUnset({ ...options, path: parsed.path });
      default:
        return await configSet({ ...options, path: parsed.path, value: parsed.value });
    }
  }

  if (parsed.command === "extensions") {
    return await extensionsList({
      configPath: parsed.configPath ?? defaultConfigPath(process.env),
      io,
      json: parsed.json,
      ...(parsed.workspace !== undefined ? { workspace: parsed.workspace } : {}),
    });
  }

  if (parsed.command === "sessions") {
    const options = {
      configPath: parsed.configPath ?? defaultConfigPath(process.env),
      io,
      ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
    };
    switch (parsed.sub) {
      case "list":
        return await sessionsList({ ...options, json: parsed.json }, sessionDeps);
      case "export":
        return await sessionExport(
          {
            ...options,
            sessionId: parsed.sessionId,
            ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
          },
          sessionDeps,
        );
      default:
        return await sessionCancel({ ...options, sessionId: parsed.sessionId }, sessionDeps);
    }
  }

  if (parsed.command === "provider" || parsed.command === "models") {
    const common = {
      configPath: parsed.configPath ?? defaultConfigPath(process.env),
      io,
      json: parsed.json,
      ...(parsed.dataDir !== undefined ? { dataDir: parsed.dataDir } : {}),
    };
    if (parsed.command === "provider") return await providerList(common, providerDeps);
    return await modelsList(
      { ...common, ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}) },
      providerDeps,
    );
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

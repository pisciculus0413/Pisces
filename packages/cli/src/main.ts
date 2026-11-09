#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  "",
  "options:",
  "  --config <path>     configuration file (default: <config home>/pisces/config.json)",
  "  --data-dir <path>   override the configured data directory",
  "  --json              machine-readable output (status only)",
  "  --help              show this help",
  "  --version           print the version",
].join("\n");

const COMMANDS = ["start", "status", "stop"] as const;
type Command = (typeof COMMANDS)[number];

interface Parsed {
  command: Command;
  configPath?: string;
  dataDir?: string;
  json: boolean;
}

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

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
async function parse(argv: readonly string[]): Promise<Parsed | "help" | "version" | undefined> {
  const command = argv[0];
  if (command === "--help") return "help";
  if (command === "--version") return "version";
  // Help and version are only global as the first argument; after a bad command
  // they must not turn a usage error into a success.
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

  const parsed: Parsed = { command, json };
  if (configPath !== undefined) parsed.configPath = configPath;
  if (dataDir !== undefined) parsed.dataDir = dataDir;
  return parsed;
}

export async function runCli(
  argv: string[],
  io: CommandIo = processIo,
  deps: CommandDeps = productionDeps,
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

/**
 * True only when `entry` denotes this module, following symlinks on both sides.
 *
 * Package managers run bins through a symlink or shim, so comparing the raw
 * `argv[1]` string with `import.meta.url` silently skips the CLI. An entry that
 * is missing or cannot be resolved is never this module.
 */
export function isEntryPath(
  entry: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (entry === undefined) return false;
  const real = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  };
  const self = real(fileURLToPath(moduleUrl));
  const candidate = real(resolve(entry));
  return self !== undefined && candidate !== undefined && self === candidate;
}

if (isEntryPath(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2), processIo);
}

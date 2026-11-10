import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiscesError } from "@pisces/core";
import { type CommandIo, processIo } from "./commands.js";
import { type CliProviderConfig, parseProviders } from "./config.js";
import {
  readConfigDraft,
  validateGlobalDraft,
  validateWorkspaceDraft,
  writeConfigFile,
} from "./config-edit.js";
import {
  type ConfigPathSegment,
  getValue,
  parseConfigPath,
  setValue,
  unsetValue,
} from "./config-path.js";

/**
 * The `config list|get|set|unset` commands.
 *
 * They edit the raw configuration draft at one scope: `global` is the resolved
 * `--config` file, `workspace` is `<workspace>/.pisces/config.json`. Every write
 * is validated against the same rules both loaders apply before it is renamed
 * into place, so a failed command never changes a file. Only fixed codes and
 * messages are printed; configuration values and paths never reach the terminal.
 */

const MESSAGES: Readonly<Record<string, string>> = {
  "config.invalid": "Invalid configuration",
  "config.unknown_key": "Unknown configuration key",
  "config.key_not_found": "Configuration key not found",
  "config.no_workspace": "No workspace directory",
  "storage.io": "Configuration file could not be written",
};

const FALLBACK_MESSAGE = MESSAGES["config.invalid"] ?? "";

export type ConfigScope = "global" | "workspace";

export interface ConfigCommandOptions {
  /** Resolved global configuration file (`--config` or the default path). */
  configPath: string;
  scope?: ConfigScope;
  /** Workspace directory; only meaningful with `scope: "workspace"`. */
  workspace?: string;
  io?: CommandIo;
  json?: boolean;
}

export interface ConfigPathOptions extends ConfigCommandOptions {
  path: string;
}

export interface ConfigSetOptions extends ConfigPathOptions {
  /** Raw command-line value, parsed as JSON. */
  value: string;
}

/** Injectable current directory, so tests never depend on `process.cwd()`. */
export interface ConfigCommandDeps {
  cwd?: string;
}

export const productionConfigCommandDeps: ConfigCommandDeps = {};

function invalid(): never {
  throw new PiscesError("config.invalid", MESSAGES["config.invalid"] ?? "");
}

function keyNotFound(): never {
  throw new PiscesError("config.key_not_found", MESSAGES["config.key_not_found"] ?? "");
}

function noWorkspace(): never {
  throw new PiscesError("config.no_workspace", MESSAGES["config.no_workspace"] ?? "");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Recursively sorts object keys so human output is stable across runs. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) define(result, key, sortDeep(value[key]));
  return result;
}

function renderHuman(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(sortDeep(value), null, 2);
  }
  return String(value);
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    invalid();
  }
}

interface Target {
  path: string;
  scope: ConfigScope;
  globalProviders?: readonly CliProviderConfig[];
}

/**
 * Reads the global providers for the workspace cross-check. A missing or
 * malformed global file only disables the cross-check; the workspace draft is
 * then validated on format alone.
 */
async function readGlobalProviders(
  configPath: string,
): Promise<readonly CliProviderConfig[] | undefined> {
  let raw: unknown;
  try {
    raw = await readConfigDraft(configPath);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.providers === undefined) return undefined;
  try {
    return parseProviders(raw.providers);
  } catch {
    return undefined;
  }
}

async function resolveTarget(
  options: ConfigCommandOptions,
  deps: ConfigCommandDeps,
): Promise<Target> {
  const scope = options.scope ?? "global";
  if (scope === "global") return { path: options.configPath, scope };

  const workspace = resolve(options.workspace ?? deps.cwd ?? process.cwd());
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(workspace);
  } catch {
    noWorkspace();
  }
  if (!info.isDirectory()) noWorkspace();
  const globalProviders = await readGlobalProviders(options.configPath);
  return {
    path: join(workspace, ".pisces", "config.json"),
    scope,
    ...(globalProviders !== undefined ? { globalProviders } : {}),
  };
}

function validateDraft(target: Target, value: unknown): void {
  if (target.scope === "global") validateGlobalDraft(value);
  else validateWorkspaceDraft(value, target.globalProviders);
}

function parsePath(input: string): ConfigPathSegment[] {
  return parseConfigPath(input);
}

/** Runs one command, printing a fixed `error: <code>: <message>` on failure. */
async function run(io: CommandIo, action: () => Promise<number>): Promise<number> {
  try {
    return await action();
  } catch (error) {
    const code = error instanceof PiscesError ? error.code : "config.invalid";
    const message = MESSAGES[code] ?? FALLBACK_MESSAGE;
    io.err(`error: ${code}: ${message}`);
    return code === "config.key_not_found" ? 1 : 2;
  }
}

export async function configList(
  options: ConfigCommandOptions,
  deps: ConfigCommandDeps = productionConfigCommandDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  return run(io, async () => {
    const target = await resolveTarget(options, deps);
    const value = await readConfigDraft(target.path);
    io.out(options.json ? JSON.stringify(value) : JSON.stringify(sortDeep(value), null, 2));
    return 0;
  });
}

export async function configGet(
  options: ConfigPathOptions,
  deps: ConfigCommandDeps = productionConfigCommandDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  return run(io, async () => {
    const target = await resolveTarget(options, deps);
    const draft = await readConfigDraft(target.path);
    const value = getValue(draft, parsePath(options.path));
    if (value === undefined) keyNotFound();
    io.out(options.json === true ? JSON.stringify(value) : renderHuman(value));
    return 0;
  });
}

export async function configSet(
  options: ConfigSetOptions,
  deps: ConfigCommandDeps = productionConfigCommandDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  return run(io, async () => {
    const value = parseValue(options.value);
    const path = parsePath(options.path);
    const target = await resolveTarget(options, deps);
    const draft = await readConfigDraft(target.path);
    const next = setValue(draft, path, value);
    validateDraft(target, next);
    await writeConfigFile(target.path, next);
    return 0;
  });
}

export async function configUnset(
  options: ConfigPathOptions,
  deps: ConfigCommandDeps = productionConfigCommandDeps,
): Promise<number> {
  const io = options.io ?? processIo;
  return run(io, async () => {
    const target = await resolveTarget(options, deps);
    const draft = await readConfigDraft(target.path);
    const next = unsetValue(draft, parsePath(options.path));
    if (next === undefined) keyNotFound();
    validateDraft(target, next);
    await writeConfigFile(target.path, next);
    return 0;
  });
}

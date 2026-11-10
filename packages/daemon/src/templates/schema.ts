import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PiscesError, type TemplateInfo } from "@pisces/core";

/** Maximum size of a single template JSON file. */
export const TEMPLATE_MAX_BYTES = 1_048_576;
/** Default `initScript.timeoutMs` when the template omits it. */
export const TEMPLATE_DEFAULT_TIMEOUT_MS = 60_000;

const MAX_TIMEOUT_MS = 600_000;
const TEMPLATE_SUFFIX = ".json";
const INVALID = "Invalid template";
const ENTRY_NAME = /^[^#\s]+#[^#\s]+$/u;

const TEMPLATE_KEYS = new Set([
  "id",
  "name",
  "description",
  "directories",
  "files",
  "initScript",
  "config",
]);
const FILE_KEYS = new Set(["path", "content"]);
const SCRIPT_KEYS = new Set(["command", "args", "timeoutMs"]);
const CONFIG_KEYS = new Set(["provider", "model", "extensions", "systemPromptFile"]);

export interface LoadedTemplate {
  info: TemplateInfo;
  directories: string[];
  files: { path: string; content: string }[];
  initScript?: { command: string; args: string[]; timeoutMs: number };
  config?: {
    provider?: string;
    model?: string;
    extensions?: string[];
    systemPromptFile?: string;
  };
}

export interface TemplateIssue {
  id: string;
  code: "template.invalid";
}

function invalid(): never {
  throw new PiscesError("template.invalid", INVALID);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

function isTemplatePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\0") || isAbsolute(value) || value.endsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function requirePath(value: unknown): string {
  if (!isTemplatePath(value)) invalid();
  return value;
}

function parseDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const entry of value) {
    const path = requirePath(entry);
    if (seen.has(path)) invalid();
    seen.add(path);
    directories.push(path);
  }
  return directories;
}

function parseFiles(value: unknown): { path: string; content: string }[] {
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  const files: { path: string; content: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) invalid();
    checkKeys(entry, FILE_KEYS);
    const path = requirePath(entry.path);
    if (typeof entry.content !== "string") invalid();
    if (seen.has(path)) invalid();
    seen.add(path);
    files.push({ path, content: entry.content });
  }
  return files;
}

function validateLayout(files: { path: string }[], directories: string[]): void {
  const filePaths = new Set(files.map((file) => file.path));
  for (const path of [...files.map((file) => file.path), ...directories]) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (filePaths.has(segments.slice(0, index).join("/"))) invalid();
    }
  }
  for (const directory of directories) {
    if (filePaths.has(directory)) invalid();
  }
}

function parseInitScript(value: unknown): { command: string; args: string[]; timeoutMs: number } {
  if (!isRecord(value)) invalid();
  checkKeys(value, SCRIPT_KEYS);
  const { command } = value;
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.includes("\0") ||
    !isAbsolute(command)
  ) {
    invalid();
  }
  if (!Array.isArray(value.args)) invalid();
  const args: string[] = [];
  for (const arg of value.args) {
    if (typeof arg !== "string" || arg.includes("\0")) invalid();
    args.push(arg);
  }
  const timeoutMs = value.timeoutMs === undefined ? TEMPLATE_DEFAULT_TIMEOUT_MS : value.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    invalid();
  }
  return { command, args, timeoutMs };
}

function parseConfig(
  value: unknown,
  files: { path: string }[],
): NonNullable<LoadedTemplate["config"]> {
  if (!isRecord(value)) invalid();
  checkKeys(value, CONFIG_KEYS);
  const config: NonNullable<LoadedTemplate["config"]> = {};
  for (const key of ["provider", "model"] as const) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || entry.length === 0) invalid();
    config[key] = entry;
  }
  if (value.extensions !== undefined) {
    if (!Array.isArray(value.extensions)) invalid();
    const extensions: string[] = [];
    for (const entry of value.extensions) {
      if (typeof entry !== "string" || !ENTRY_NAME.test(entry)) invalid();
      extensions.push(entry);
    }
    config.extensions = extensions;
  }
  if (value.systemPromptFile !== undefined) {
    const path = requirePath(value.systemPromptFile);
    if (!files.some((file) => file.path === path)) invalid();
    config.systemPromptFile = path;
  }
  return config;
}

export function parseTemplate(id: string, raw: string): LoadedTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid();
  }
  if (!isRecord(parsed)) invalid();
  checkKeys(parsed, TEMPLATE_KEYS);
  if (parsed.id !== id) invalid();
  if (typeof parsed.name !== "string" || parsed.name.length === 0) invalid();
  const info: TemplateInfo = { id, name: parsed.name };
  if (parsed.description !== undefined) {
    if (typeof parsed.description !== "string") invalid();
    info.description = parsed.description;
  }
  const directories = parsed.directories === undefined ? [] : parseDirectories(parsed.directories);
  const files = parsed.files === undefined ? [] : parseFiles(parsed.files);
  validateLayout(files, directories);
  const template: LoadedTemplate = { info, directories, files };
  if (parsed.initScript !== undefined) template.initScript = parseInitScript(parsed.initScript);
  if (parsed.config !== undefined) template.config = parseConfig(parsed.config, files);
  return template;
}

const issue = (id: string): TemplateIssue => ({ id, code: "template.invalid" });

export async function loadTemplates(
  configDir: string,
): Promise<{ templates: LoadedTemplate[]; issues: TemplateIssue[] }> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch {
    return { templates: [], issues: [] };
  }
  const templates: LoadedTemplate[] = [];
  const issues: TemplateIssue[] = [];
  for (const name of entries) {
    if (!name.endsWith(TEMPLATE_SUFFIX)) continue;
    const id = name.slice(0, -TEMPLATE_SUFFIX.length);
    const path = join(configDir, name);
    let size: number;
    try {
      const stats = await stat(path);
      if (!stats.isFile()) continue;
      size = stats.size;
    } catch {
      issues.push(issue(id));
      continue;
    }
    if (size > TEMPLATE_MAX_BYTES) {
      issues.push(issue(id));
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      issues.push(issue(id));
      continue;
    }
    try {
      templates.push(parseTemplate(id, raw));
    } catch {
      issues.push(issue(id));
    }
  }
  templates.sort((left, right) => (left.info.id < right.info.id ? -1 : 1));
  issues.sort((left, right) => (left.id < right.id ? -1 : 1));
  return { templates, issues };
}

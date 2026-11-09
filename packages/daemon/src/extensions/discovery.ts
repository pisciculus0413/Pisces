import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ContentBlock,
  type DefinitionSnapshot,
  type EntryInfo,
  type EntryName,
  type JsonObject,
  PiscesError,
} from "@pisces/core";
import { glob, isDynamicPattern } from "tinyglobby";
import { sha256 } from "./hash.js";
import {
  compileWrapperSchema,
  configHashFor,
  deepFreeze,
  definitionHashFor,
  type EntryKind,
  type EntrySidecar,
  entryBaseName,
  InvalidMetadataError,
  type InventoryDescriptor,
  inventoryHashFor,
  isScriptFile,
  mergeWrapperConfig,
  normalizeWrapperSpec,
  type PackageManifest,
  packageEntryName,
  parsePackageJson,
  parseSidecar,
  SIDECAR_SUFFIX,
  SKILL_FILE,
  skillContentFor,
  type WrapperValidator,
} from "./metadata.js";
import type {
  DiscoveredEntry,
  DiscoveryResult,
  ExtensionConfig,
  ExtensionIssue,
  ExtensionsOptions,
  Inventory,
  WrapperConfigSpec,
} from "./types.js";

const INVALID_CONFIG = "Invalid extension configuration";
const DISCOVERY_FAILED = "Extension discovery failed";
const KINDS: readonly EntryKind[] = ["tool", "wrapper", "skill", "context"];
const KIND_DIRS: Record<EntryKind, string> = {
  tool: "tools",
  wrapper: "wrappers",
  skill: "skills",
  context: "context",
};
const MANIFEST_KEYS: Record<EntryKind, "tools" | "wrappers" | "skills" | "context"> = {
  tool: "tools",
  wrapper: "wrappers",
  skill: "skills",
  context: "context",
};

interface Candidate {
  packageRoot: string;
  packageName: string;
  kind: EntryKind;
  entryPath: string;
  entryDigest: string;
  name: EntryName;
  description: string;
  parameters: JsonObject;
  configSpec?: WrapperConfigSpec;
  validator?: WrapperValidator;
  wrapperConfig?: JsonObject;
  skillContent?: ContentBlock[];
}

interface PackageRoot {
  dir: string;
  tag: string;
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

const invalidConfig = (): never => {
  throw new PiscesError("config.invalid", INVALID_CONFIG);
};

const sortNames = (names: readonly string[]): string[] => [...names].sort();

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return sortNames(await readdir(dir));
  } catch (error) {
    if (isNotFound(error) || (error as { code?: string }).code === "ENOTDIR") return [];
    throw new PiscesError("extensions.invalid", DISCOVERY_FAILED);
  }
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function defaultBuiltinDir(): string {
  return fileURLToPath(new URL("../../../../extensions/builtin/", import.meta.url));
}

async function listPackageRoots(sourceDir: string): Promise<PackageRoot[]> {
  const roots: PackageRoot[] = [];
  for (const name of await readDirNames(sourceDir)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const child of await readDirNames(join(sourceDir, name))) {
        if (child.startsWith(".")) continue;
        roots.push({ dir: join(sourceDir, name, child), tag: `${name}/${child}` });
      }
      continue;
    }
    roots.push({ dir: join(sourceDir, name), tag: name });
  }
  return roots;
}

async function resolveExplicit(
  packageRoot: string,
  kind: EntryKind,
  patterns: readonly string[],
): Promise<{ paths: string[]; invalid: boolean }> {
  const directories = kind === "skill";
  const found = new Set<string>();
  let invalid = false;

  for (const literal of patterns) {
    if (literal.startsWith("!") || isDynamicPattern(literal)) continue;
    const candidate = isAbsolute(literal) ? literal : join(packageRoot, literal);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      invalid = true;
      continue;
    }
    const info = await stat(resolved).catch(() => undefined);
    if (info === undefined || !within(packageRoot, resolved)) {
      invalid = true;
      continue;
    }
    const matches = directories ? info.isDirectory() : info.isFile();
    if (!matches || (!directories && !isScriptFile(basename(resolved)))) {
      invalid = true;
      continue;
    }
    found.add(resolved);
  }

  let matches: string[];
  try {
    matches = await glob([...patterns], {
      cwd: packageRoot,
      absolute: false,
      onlyFiles: !directories,
      onlyDirectories: directories,
      expandDirectories: false,
      followSymbolicLinks: true,
      dot: false,
    });
  } catch {
    return { paths: sortNames([...found]), invalid: true };
  }

  for (const match of matches) {
    const trimmed = match.endsWith("/") ? match.slice(0, -1) : match;
    const candidate = isAbsolute(trimmed) ? trimmed : join(packageRoot, trimmed);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      invalid = true;
      continue;
    }
    if (!within(packageRoot, resolved)) {
      invalid = true;
      continue;
    }
    if (!directories && !isScriptFile(basename(resolved))) continue;
    found.add(resolved);
  }

  return { paths: sortNames([...found]), invalid };
}

async function conventionalPaths(packageRoot: string, kind: EntryKind): Promise<string[]> {
  const dir = join(packageRoot, KIND_DIRS[kind]);
  const found: string[] = [];
  for (const name of await readDirNames(dir)) {
    if (name.startsWith(".") || name.endsWith(SIDECAR_SUFFIX)) continue;
    const full = join(dir, name);
    const info = await stat(full).catch(() => undefined);
    if (info === undefined) continue;
    if (kind === "skill") {
      if (!info.isDirectory()) continue;
    } else if (!info.isFile() || !isScriptFile(name)) {
      continue;
    }
    found.push(await realpath(full));
  }
  return sortNames(found);
}

async function readSidecar(kind: EntryKind, entryPath: string): Promise<EntrySidecar | undefined> {
  const path =
    kind === "skill"
      ? join(dirname(entryPath), `${basename(entryPath)}${SIDECAR_SUFFIX}`)
      : `${entryPath}${SIDECAR_SUFFIX}`;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new InvalidMetadataError();
  }
  return parseSidecar(text, kind);
}

async function readCandidate(
  packageRoot: string,
  packageName: string,
  kind: EntryKind,
  entryPath: string,
): Promise<Candidate> {
  const sidecar = await readSidecar(kind, entryPath);
  const namePart = sidecar?.name ?? entryBaseName(kind, basename(entryPath));
  const name = packageEntryName(packageName, namePart);
  const description = sidecar?.description ?? "";

  let entryDigest: string;
  let skillContent: ContentBlock[] | undefined;
  if (kind === "skill") {
    let text: string;
    try {
      const bytes = await readFile(join(entryPath, SKILL_FILE));
      entryDigest = sha256(bytes);
      text = bytes.toString("utf8");
    } catch {
      throw new InvalidMetadataError();
    }
    skillContent = skillContentFor(text);
  } else {
    try {
      entryDigest = sha256(await readFile(entryPath));
    } catch {
      throw new InvalidMetadataError();
    }
  }

  const candidate: Candidate = {
    packageRoot,
    packageName,
    kind,
    entryPath,
    entryDigest,
    name,
    description,
    parameters: sidecar?.parameters ?? {},
  };
  if (kind === "wrapper") {
    const spec = normalizeWrapperSpec(sidecar?.config);
    const validator = compileWrapperSchema(spec.schema);
    if (validator === undefined) throw new InvalidMetadataError();
    candidate.configSpec = spec;
    candidate.validator = validator;
  }
  if (skillContent !== undefined) candidate.skillContent = skillContent;
  return candidate;
}

function pushIssue(
  issues: ExtensionIssue[],
  code: ExtensionIssue["code"],
  source: string,
  name?: EntryName,
): void {
  const issue: ExtensionIssue = { code, source };
  if (name !== undefined) issue.name = name;
  issues.push(Object.freeze(issue));
}

function buildDefinition(candidate: Candidate): DefinitionSnapshot | undefined {
  if (candidate.kind !== "tool" && candidate.kind !== "wrapper") return undefined;
  const definitionHash = definitionHashFor(
    candidate.name,
    candidate.kind,
    candidate.description,
    candidate.parameters,
    candidate.entryDigest,
  );
  const definition: DefinitionSnapshot = {
    name: candidate.name,
    kind: candidate.kind,
    description: candidate.description,
    parameters: structuredClone(candidate.parameters),
    definitionHash,
  };
  if (candidate.wrapperConfig !== undefined) {
    definition.configHash = configHashFor(candidate.wrapperConfig);
  }
  return definition;
}

function buildInfo(candidate: Candidate, definition: DefinitionSnapshot | undefined): EntryInfo {
  const info: EntryInfo = {
    type: candidate.kind,
    source: candidate.packageName,
    name: candidate.name,
    description: candidate.description,
  };
  if (definition !== undefined) {
    info.definition = definition;
    info.definitionHash = definition.definitionHash;
  }
  return info;
}

export async function discoverExtensions(
  options: ExtensionsOptions,
  workspace: string,
  config: ExtensionConfig,
): Promise<DiscoveryResult> {
  const issues: ExtensionIssue[] = [];
  const sources = [
    options.builtinDir ?? defaultBuiltinDir(),
    join(options.configDir, "extensions"),
    join(workspace, ".pisces", "extensions"),
  ];

  const seenRoots = new Set<string>();
  const candidates: Candidate[] = [];

  for (const sourceDir of sources) {
    for (const listed of await listPackageRoots(sourceDir)) {
      let packageRoot: string;
      let isDirectory = false;
      try {
        packageRoot = await realpath(listed.dir);
        isDirectory = (await stat(packageRoot)).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory || seenRoots.has(packageRoot)) continue;
      seenRoots.add(packageRoot);

      const packageFile = join(packageRoot, "package.json");
      let packageJson: string;
      try {
        packageJson = await readFile(packageFile, "utf8");
      } catch (error) {
        if (isNotFound(error)) continue;
        pushIssue(issues, "extensions.invalid", listed.tag);
        continue;
      }

      let name: string;
      let manifest: PackageManifest | undefined;
      try {
        const parsed = parsePackageJson(packageJson);
        name = parsed.name;
        manifest = parsed.manifest;
      } catch {
        pushIssue(issues, "extensions.invalid", listed.tag);
        continue;
      }

      if (manifest !== undefined) {
        for (const _provider of manifest.providers ?? []) {
          pushIssue(issues, "extensions.unsupported_contribution", name);
        }
        for (const _client of manifest.clients ?? []) {
          pushIssue(issues, "extensions.unsupported_contribution", name);
        }
      }

      for (const kind of KINDS) {
        let paths: string[];
        if (manifest === undefined) {
          paths = await conventionalPaths(packageRoot, kind);
        } else {
          const patterns = manifest[MANIFEST_KEYS[kind]] ?? [];
          const resolved = await resolveExplicit(packageRoot, kind, patterns);
          if (resolved.invalid) pushIssue(issues, "extensions.invalid", name);
          paths = resolved.paths;
        }
        for (const entryPath of paths) {
          try {
            candidates.push(await readCandidate(packageRoot, name, kind, entryPath));
          } catch (error) {
            if (error instanceof InvalidMetadataError) {
              pushIssue(issues, "extensions.invalid", name);
              continue;
            }
            throw error;
          }
        }
      }
    }
  }

  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
  }
  const survivors = candidates.filter((candidate) => counts.get(candidate.name) === 1);
  for (const [name, count] of counts) {
    if (count > 1) {
      pushIssue(issues, "extensions.duplicate", name, name as EntryName);
    }
  }

  survivors.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const byName = new Map<EntryName, Candidate>();
  for (const candidate of survivors) byName.set(candidate.name, candidate);

  for (const key of Object.keys(config.entryConfig ?? {})) {
    const candidate = byName.get(key as EntryName);
    if (candidate === undefined || candidate.kind !== "wrapper") invalidConfig();
  }

  for (const candidate of survivors) {
    if (candidate.kind !== "wrapper") continue;
    const spec = normalizeWrapperSpec(candidate.configSpec);
    const override = config.entryConfig?.[candidate.name] ?? {};
    const merged = mergeWrapperConfig(spec.defaults, override);
    if (candidate.validator === undefined || !candidate.validator(merged)) invalidConfig();
    candidate.configSpec = spec;
    candidate.wrapperConfig = merged;
  }

  const records = new Map<EntryName, DiscoveredEntry>();
  const entries: EntryInfo[] = [];
  const descriptors: InventoryDescriptor[] = [];

  for (const candidate of survivors) {
    const definition = buildDefinition(candidate);
    const info = deepFreeze(buildInfo(candidate, definition));
    entries.push(info);
    const descriptor: InventoryDescriptor = {
      name: candidate.name,
      type: candidate.kind,
      digest: candidate.entryDigest,
    };
    if (definition !== undefined) descriptor.digest = definition.definitionHash;
    if (definition?.configHash !== undefined) descriptor.configHash = definition.configHash;
    descriptors.push(descriptor);

    const record: DiscoveredEntry = {
      info: deepFreeze(buildInfo(candidate, buildDefinition(candidate))),
      packageRoot: candidate.packageRoot,
      entryPath: candidate.entryPath,
      entryDigest: candidate.entryDigest,
    };
    if (candidate.wrapperConfig !== undefined) {
      record.wrapperConfig = deepFreeze(structuredClone(candidate.wrapperConfig));
    }
    if (candidate.configSpec !== undefined) {
      record.wrapperConfigSpec = deepFreeze(structuredClone(candidate.configSpec));
    }
    if (candidate.skillContent !== undefined) {
      record.skillContent = deepFreeze(structuredClone(candidate.skillContent));
    }
    records.set(candidate.name, deepFreeze(record));
  }

  const inventory: Inventory = deepFreeze({
    hash: inventoryHashFor(descriptors),
    entries: deepFreeze(entries),
  });

  return {
    inventory,
    records: new Map(records),
    issues: deepFreeze(issues),
  };
}

export type { DiscoveryResult, ExtensionConfig, ExtensionIssue, ExtensionsOptions, Inventory };

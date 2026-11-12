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
import {
  readConfigLayer,
  readGlobalConfig,
  readWorkspaceConfig,
  resolveConfigLocation,
} from "./config.js";
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
  ClientDiscoveryResult,
  ClientRegistration,
  DiscoveredEntry,
  DiscoveryResult,
  ExtensionConfig,
  ExtensionIssue,
  ExtensionListing,
  ExtensionListingEntry,
  ExtensionOrigin,
  ExtensionsOptions,
  Inventory,
  ListExtensionsOptions,
  WrapperConfigSpec,
} from "./types.js";

const INVALID_CONFIG = "Invalid extension configuration";
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

// logical: lexical path used for basename/sidecar derivation; canonical: realpath for
// identity, containment and entry reads.
interface EntryPath {
  logical: string;
  canonical: string;
}

interface DirListing {
  names: string[];
  failed: boolean;
}

interface Candidate {
  packageRoot: string;
  packageName: string;
  origin: ExtensionOrigin;
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

const isNotDir = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOTDIR";

const invalidConfig = (): never => {
  throw new PiscesError("config.invalid", INVALID_CONFIG);
};

const sortNames = (names: readonly string[]): string[] => [...names].sort();

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Read faults never escape discovery: callers report them as safe issues.
async function readDirListing(dir: string): Promise<DirListing> {
  try {
    return { names: sortNames(await readdir(dir)), failed: false };
  } catch (error) {
    if (isNotFound(error) || isNotDir(error)) return { names: [], failed: false };
    return { names: [], failed: true };
  }
}

export function defaultBuiltinDir(): string {
  return fileURLToPath(new URL("../../../../extensions/builtin/", import.meta.url));
}

async function listPackageRoots(
  sourceDir: string,
  label: string,
): Promise<{ roots: PackageRoot[]; failures: string[] }> {
  const roots: PackageRoot[] = [];
  const failures: string[] = [];
  const listing = await readDirListing(sourceDir);
  if (listing.failed) return { roots, failures: [label] };
  for (const name of listing.names) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      const inner = await readDirListing(join(sourceDir, name));
      if (inner.failed) {
        failures.push(name);
        continue;
      }
      for (const child of inner.names) {
        if (child.startsWith(".")) continue;
        roots.push({ dir: join(sourceDir, name, child), tag: `${name}/${child}` });
      }
      continue;
    }
    roots.push({ dir: join(sourceDir, name), tag: name });
  }
  return { roots, failures };
}

function dedupeEntryPaths(paths: readonly EntryPath[]): EntryPath[] {
  const ordered = [...paths].sort((left, right) =>
    left.logical < right.logical ? -1 : left.logical > right.logical ? 1 : 0,
  );
  const seen = new Map<string, EntryPath>();
  for (const path of ordered) {
    if (!seen.has(path.canonical)) seen.set(path.canonical, path);
  }
  return [...seen.values()];
}

async function literalPath(
  packageRoot: string,
  kind: EntryKind,
  literal: string,
): Promise<EntryPath | undefined> {
  const logical = isAbsolute(literal) ? literal : join(packageRoot, literal);
  const canonical = await realpath(logical).catch(() => undefined);
  if (canonical === undefined) return undefined;
  const info = await stat(canonical).catch(() => undefined);
  if (info === undefined || !within(packageRoot, canonical)) return undefined;
  if (kind === "skill") return info.isDirectory() ? { logical, canonical } : undefined;
  if (!info.isFile() || !isScriptFile(basename(logical))) return undefined;
  return { logical, canonical };
}

async function resolveExplicit(
  packageRoot: string,
  kind: EntryKind,
  patterns: readonly string[],
): Promise<{ paths: EntryPath[]; invalid: boolean }> {
  const directories = kind === "skill";
  let invalid = false;

  // Literal positives are only validated here; membership comes from the single glob pass
  // so `!` exclusions also apply to them.
  for (const literal of patterns) {
    if (literal.startsWith("!") || isDynamicPattern(literal)) continue;
    if ((await literalPath(packageRoot, kind, literal)) === undefined) invalid = true;
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
    return { paths: [], invalid: true };
  }

  const found: EntryPath[] = [];
  for (const match of matches) {
    const trimmed = match.endsWith("/") ? match.slice(0, -1) : match;
    const logical = isAbsolute(trimmed) ? trimmed : join(packageRoot, trimmed);
    const canonical = await realpath(logical).catch(() => undefined);
    if (canonical === undefined) {
      invalid = true;
      continue;
    }
    if (!within(packageRoot, canonical)) {
      invalid = true;
      continue;
    }
    if (!directories && !isScriptFile(basename(logical))) continue;
    found.push({ logical, canonical });
  }

  return { paths: dedupeEntryPaths(found), invalid };
}

async function conventionalPaths(
  packageRoot: string,
  kind: EntryKind,
  onFault: () => void,
): Promise<EntryPath[]> {
  const dir = join(packageRoot, KIND_DIRS[kind]);
  const listing = await readDirListing(dir);
  if (listing.failed) {
    onFault();
    return [];
  }
  const found: EntryPath[] = [];
  for (const name of listing.names) {
    if (name.startsWith(".") || name.endsWith(SIDECAR_SUFFIX)) continue;
    const logical = join(dir, name);
    const info = await stat(logical).catch(() => undefined);
    if (info === undefined) {
      onFault();
      continue;
    }
    if (kind === "skill") {
      if (!info.isDirectory()) continue;
    } else if (!info.isFile() || !isScriptFile(name)) {
      continue;
    }
    const canonical = await realpath(logical).catch(() => undefined);
    if (canonical === undefined || !within(packageRoot, canonical)) {
      onFault();
      continue;
    }
    found.push({ logical, canonical });
  }
  return dedupeEntryPaths(found);
}

async function readSidecar(
  kind: EntryKind,
  logicalPath: string,
): Promise<EntrySidecar | undefined> {
  const path =
    kind === "skill"
      ? join(dirname(logicalPath), `${basename(logicalPath)}${SIDECAR_SUFFIX}`)
      : `${logicalPath}${SIDECAR_SUFFIX}`;
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
  origin: ExtensionOrigin,
  kind: EntryKind,
  path: EntryPath,
): Promise<Candidate> {
  const sidecar = await readSidecar(kind, path.logical);
  const namePart = sidecar?.name ?? entryBaseName(kind, basename(path.logical));
  const name = packageEntryName(packageName, namePart);
  const description = sidecar?.description ?? "";

  let entryDigest: string;
  let skillContent: ContentBlock[] | undefined;
  if (kind === "skill") {
    let text: string;
    try {
      const bytes = await readFile(join(path.canonical, SKILL_FILE));
      entryDigest = sha256(bytes);
      text = bytes.toString("utf8");
    } catch {
      throw new InvalidMetadataError();
    }
    skillContent = skillContentFor(text);
  } else {
    try {
      entryDigest = sha256(await readFile(path.canonical));
    } catch {
      throw new InvalidMetadataError();
    }
  }

  const candidate: Candidate = {
    packageRoot,
    packageName,
    origin,
    kind,
    entryPath: path.canonical,
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

function mergedConfigValid(candidate: Candidate, merged: JsonObject): boolean {
  try {
    return candidate.validator?.(merged) === true;
  } catch (error) {
    if (error instanceof InvalidMetadataError) return false;
    throw error;
  }
}

export async function discoverExtensions(
  options: ExtensionsOptions,
  workspace: string | undefined,
  config: ExtensionConfig,
): Promise<DiscoveryResult> {
  const issues: ExtensionIssue[] = [];
  // The extension root is `configDir` when given, otherwise `dirname(configPath)`; the global
  // config file itself is never read here.
  const { configDir } = resolveConfigLocation(options);
  // The workspace source and label only exist when a workspace is given: without one,
  // discovery must never read `<undefined>/.pisces/extensions`.
  const sources: { dir: string; origin: ExtensionOrigin }[] = [
    { dir: options.builtinDir ?? defaultBuiltinDir(), origin: "builtin" },
    { dir: join(configDir, "extensions"), origin: "config" },
  ];
  if (workspace !== undefined) {
    sources.push({ dir: join(workspace, ".pisces", "extensions"), origin: "workspace" });
  }

  const seenRoots = new Set<string>();
  const candidates: Candidate[] = [];

  for (const source of sources) {
    const label = source.origin;
    const listed = await listPackageRoots(source.dir, label);
    for (const failure of listed.failures) {
      pushIssue(issues, "extensions.invalid", failure);
    }
    for (const packageEntry of listed.roots) {
      let packageRoot: string;
      let isDirectory = false;
      try {
        packageRoot = await realpath(packageEntry.dir);
        isDirectory = (await stat(packageRoot)).isDirectory();
      } catch {
        pushIssue(issues, "extensions.invalid", packageEntry.tag);
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
        pushIssue(issues, "extensions.invalid", packageEntry.tag);
        continue;
      }

      let name: string;
      let manifest: PackageManifest | undefined;
      try {
        const parsed = parsePackageJson(packageJson);
        name = parsed.name;
        manifest = parsed.manifest;
      } catch {
        pushIssue(issues, "extensions.invalid", packageEntry.tag);
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

      const reportFault = (): void => {
        pushIssue(issues, "extensions.invalid", name);
      };

      for (const kind of KINDS) {
        let paths: EntryPath[];
        if (manifest === undefined) {
          paths = await conventionalPaths(packageRoot, kind, reportFault);
        } else {
          const patterns = manifest[MANIFEST_KEYS[kind]] ?? [];
          const resolved = await resolveExplicit(packageRoot, kind, patterns);
          if (resolved.invalid) reportFault();
          paths = resolved.paths;
        }
        for (const path of paths) {
          try {
            candidates.push(await readCandidate(packageRoot, name, source.origin, kind, path));
          } catch (error) {
            if (error instanceof InvalidMetadataError) {
              reportFault();
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

  const userConfig = config.entryConfig ?? {};
  for (const key of Object.keys(userConfig)) {
    const candidate = byName.get(key as EntryName);
    if (candidate === undefined || candidate.kind !== "wrapper") invalidConfig();
  }

  // Design §6.2: schema applies to merged defaults < user override. Defaults may be partial;
  // only a failing merged config with an explicit user override is a user config error.
  const kept: Candidate[] = [];
  for (const candidate of survivors) {
    if (candidate.kind !== "wrapper") {
      kept.push(candidate);
      continue;
    }
    const spec = normalizeWrapperSpec(candidate.configSpec);
    const hasUserConfig = Object.hasOwn(userConfig, candidate.name);
    const override = hasUserConfig ? (userConfig[candidate.name] ?? {}) : {};
    const merged = mergeWrapperConfig(spec.defaults, override);
    if (!mergedConfigValid(candidate, merged)) {
      if (hasUserConfig) invalidConfig();
      pushIssue(issues, "extensions.invalid", candidate.packageName, candidate.name);
      continue;
    }
    candidate.configSpec = spec;
    candidate.wrapperConfig = merged;
    kept.push(candidate);
  }

  const records = new Map<EntryName, DiscoveredEntry>();
  const entries: EntryInfo[] = [];
  const descriptors: InventoryDescriptor[] = [];

  for (const candidate of kept) {
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
      origin: candidate.origin,
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

/** A client entry must be a script file inside its own package; nothing else is executable. */
async function clientEntry(packageRoot: string, entry: string): Promise<string | undefined> {
  const logical = join(packageRoot, entry);
  const canonical = await realpath(logical).catch(() => undefined);
  if (canonical === undefined) return undefined;
  const info = await stat(canonical).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  if (!within(packageRoot, canonical)) return undefined;
  if (!isScriptFile(basename(logical))) return undefined;
  return canonical;
}

/**
 * Read-only collection of `pisces.clients` contributions from the builtin and global
 * extension directories. The workspace source is never read: `client.list` carries no
 * workspace, so a workspace extension cannot contribute a client. No extension code is
 * imported and no configuration file is read.
 */
export async function discoverClients(options: ExtensionsOptions): Promise<ClientDiscoveryResult> {
  const issues: ExtensionIssue[] = [];
  const { configDir } = resolveConfigLocation(options);
  const sources = [
    { dir: options.builtinDir ?? defaultBuiltinDir(), label: "builtin" },
    { dir: join(configDir, "extensions"), label: "config" },
  ];
  const seenRoots = new Set<string>();
  const declared: ClientRegistration[] = [];

  for (const source of sources) {
    const listed = await listPackageRoots(source.dir, source.label);
    for (const failure of listed.failures) {
      pushIssue(issues, "extensions.invalid", failure);
    }
    for (const packageEntry of listed.roots) {
      let packageRoot: string;
      try {
        packageRoot = await realpath(packageEntry.dir);
        if (!(await stat(packageRoot)).isDirectory()) continue;
      } catch {
        pushIssue(issues, "extensions.invalid", packageEntry.tag);
        continue;
      }
      if (seenRoots.has(packageRoot)) continue;
      seenRoots.add(packageRoot);

      let packageJson: string;
      try {
        packageJson = await readFile(join(packageRoot, "package.json"), "utf8");
      } catch (error) {
        if (isNotFound(error)) continue;
        pushIssue(issues, "extensions.invalid", packageEntry.tag);
        continue;
      }

      let name: string;
      let manifest: PackageManifest | undefined;
      try {
        const parsed = parsePackageJson(packageJson);
        name = parsed.name;
        manifest = parsed.manifest;
      } catch {
        pushIssue(issues, "extensions.invalid", packageEntry.tag);
        continue;
      }

      for (const client of manifest?.clients ?? []) {
        const entry = await clientEntry(packageRoot, client.entry);
        if (entry === undefined) {
          pushIssue(issues, "extensions.invalid", name);
          continue;
        }
        declared.push({ id: client.id, source: name, entry });
      }
    }
  }

  // A reused id has no defensible owner: drop every declaration of it rather than
  // letting directory order decide which package wins.
  const counts = new Map<string, number>();
  for (const client of declared) counts.set(client.id, (counts.get(client.id) ?? 0) + 1);
  const clients: ClientRegistration[] = [];
  for (const client of declared) {
    if ((counts.get(client.id) ?? 0) > 1) {
      pushIssue(issues, "extensions.duplicate", client.source, client.id as EntryName);
      continue;
    }
    clients.push(client);
  }
  clients.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return { clients, issues };
}

/**
 * Read-only listing over the same discovery pass the daemon uses, without
 * importing entry modules, building tools or reading credentials.
 *
 * The workspace config layer is only read when a workspace is given; the two
 * layers are merged exactly like `prepare` does before discovery. The global
 * layer is `options.configPath` when given, so a CLI `--config <file>` is
 * honored, and `<configDir>/config.json` otherwise.
 */
export async function listExtensions(options: ListExtensionsOptions): Promise<ExtensionListing> {
  const config =
    options.workspace === undefined
      ? options.configPath === undefined
        ? await readGlobalConfig(options.configDir)
        : await readConfigLayer(options.configPath, "global")
      : await readWorkspaceConfig(options.configDir, options.workspace, options.configPath);
  const discoveryOptions: ExtensionsOptions = { configDir: options.configDir };
  if (options.configPath !== undefined) discoveryOptions.configPath = options.configPath;
  if (options.builtinDir !== undefined) discoveryOptions.builtinDir = options.builtinDir;

  const discovery = await discoverExtensions(discoveryOptions, options.workspace, config);

  const entries: ExtensionListingEntry[] = [];
  for (const record of discovery.records.values()) {
    const entry: ExtensionListingEntry = {
      name: record.info.name,
      type: record.info.type,
      origin: record.origin,
    };
    if (record.info.description !== undefined && record.info.description !== "") {
      entry.description = record.info.description;
    }
    entries.push(entry);
  }

  return { entries, issues: discovery.issues };
}

export type {
  ClientDiscoveryResult,
  ClientRegistration,
  DiscoveryResult,
  ExtensionConfig,
  ExtensionIssue,
  ExtensionListing,
  ExtensionListingEntry,
  ExtensionOrigin,
  ExtensionsOptions,
  Inventory,
  ListExtensionsOptions,
};

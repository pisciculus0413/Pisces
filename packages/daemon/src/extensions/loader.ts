import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createJiti, type JitiOptions } from "jiti";
import { sha256 } from "./hash.js";
import type { DiscoveredEntry } from "./types.js";

export interface ExtensionModule {
  default: unknown;
  config?: unknown;
}

export interface ExtensionLoader {
  load(entry: DiscoveredEntry): Promise<ExtensionModule>;
}

export class ExtensionLoadError extends Error {
  constructor(message = "Extension module could not be loaded") {
    super(message);
    this.name = "ExtensionLoadError";
  }
}

const CODE_KINDS = new Set<DiscoveredEntry["info"]["type"]>(["tool", "wrapper", "context"]);

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// The extension's own tsconfig is the only source of baseUrl/paths/extends. Search stops
// at the package root so a repository-level config cannot leak into extension resolution.
async function findTsconfig(entryPath: string, packageRoot: string): Promise<string | undefined> {
  let dir = dirname(entryPath);
  for (;;) {
    if (within(packageRoot, dir)) {
      const candidate = join(dir, "tsconfig.json");
      const info = await stat(candidate).catch(() => undefined);
      if (info?.isFile()) return candidate;
    }
    if (dir === packageRoot) return undefined;
    const parent = dirname(dir);
    if (parent === dir || !within(packageRoot, parent)) return undefined;
    dir = parent;
  }
}

async function hostModules(): Promise<Record<string, unknown>> {
  const [core, protocol, daemon] = await Promise.all([
    import("@pisces/core"),
    import("@pisces/protocol"),
    import("@pisces/daemon"),
  ]);
  return {
    "@pisces/core": core,
    "@pisces/protocol": protocol,
    "@pisces/daemon": daemon,
  };
}

async function importEntry(entry: DiscoveredEntry): Promise<ExtensionModule> {
  const kind = entry.info.type;
  if (kind === "skill") {
    throw new ExtensionLoadError("Skill entries cannot be loaded as code");
  }
  if (!CODE_KINDS.has(kind)) {
    throw new ExtensionLoadError("Unsupported extension entry kind");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(entry.entryPath);
  } catch {
    throw new ExtensionLoadError("Extension entry could not be read");
  }
  // Frozen bytes are checked before the first execution; a rejected load stays cached.
  if (sha256(bytes) !== entry.entryDigest) {
    throw new ExtensionLoadError("Extension entry changed after discovery");
  }

  const hosts = await hostModules();
  const tsconfig = await findTsconfig(entry.entryPath, entry.packageRoot);
  const options: JitiOptions = {
    fsCache: false,
    moduleCache: false,
    interopDefault: false,
    tryNative: false,
    nativeModules: [],
    transformModules: [],
    // TSX is compiled with the automatic runtime; extensions provide their own runtime
    // via @jsxImportSource (or a react/jsx-runtime dependency).
    jsx: { runtime: "automatic" },
    virtualModules: hosts,
  };
  if (tsconfig !== undefined) options.tsconfigPaths = tsconfig;

  let evaluated: unknown;
  try {
    const jiti = createJiti(entry.entryPath, options);
    evaluated = await jiti.evalModule(bytes.toString("utf8"), {
      filename: entry.entryPath,
      async: true,
      // Always execute the bytes already checked against the frozen digest, even for
      // plain JS/CJS entries that jiti would otherwise load natively from disk.
      forceTranspile: true,
    });
  } catch {
    throw new ExtensionLoadError("Extension module failed to load");
  }
  if (typeof evaluated !== "object" || evaluated === null) {
    throw new ExtensionLoadError("Extension module has no default function export");
  }
  const record = evaluated as Record<string, unknown>;
  if (typeof record.default !== "function") {
    throw new ExtensionLoadError("Extension module has no default function export");
  }
  const module: ExtensionModule = { default: record.default };
  if (Object.hasOwn(record, "config")) module.config = record.config;
  return module;
}

export function createExtensionLoader(): ExtensionLoader {
  const cache = new Map<string, Promise<ExtensionModule>>();
  return {
    load(entry: DiscoveredEntry): Promise<ExtensionModule> {
      const key = `${entry.entryPath}\u0000${entry.entryDigest}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      // Insert before awaiting so concurrent loads of one entry share one execution,
      // and keep rejected promises cached for this loader instance.
      const pending = importEntry(entry);
      cache.set(key, pending);
      return pending;
    },
  };
}

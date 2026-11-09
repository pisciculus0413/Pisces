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
const HOST_ROOTS = ["@pisces/core", "@pisces/protocol", "@pisces/daemon"] as const;

function isHostSubpath(key: PropertyKey): boolean {
  return typeof key === "string" && HOST_ROOTS.some((root) => key.startsWith(`${root}/`));
}

// Null-prototype target keeps inherited keys such as toString out of the virtual
// module map. Reserved host subpaths are rejected before jiti can resolve an
// extension-local copy; the three host packages only export their root.
function guardHostModules(hosts: Record<string, unknown>): Record<string, unknown> {
  const target = Object.assign(Object.create(null) as Record<string, unknown>, hosts);
  return new Proxy(target, {
    has(object, key) {
      if (isHostSubpath(key)) throw new ExtensionLoadError("Unsupported @pisces host subpath");
      return Reflect.has(object, key);
    },
    get(object, key, receiver) {
      if (isHostSubpath(key)) throw new ExtensionLoadError("Unsupported @pisces host subpath");
      return Reflect.get(object, key, receiver);
    },
  });
}

function loadFailure(error: unknown): ExtensionLoadError {
  let code: unknown;
  try {
    code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  } catch {
    code = undefined;
  }
  // Only the patch's private static reason codes are mapped; raw messages,
  // causes and arbitrary metadata never leave this boundary.
  if (code === "ERR_PISCES_EXTENSION_FORMAT") {
    return new ExtensionLoadError("Unsupported extension module format");
  }
  if (code === "ERR_PISCES_EXTENSION_JSON") {
    return new ExtensionLoadError("Extension module JSON is invalid");
  }
  return new ExtensionLoadError("Extension module failed to load");
}

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
  return guardHostModules({
    "@pisces/core": core,
    "@pisces/protocol": protocol,
    "@pisces/daemon": daemon,
  });
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

  let hosts: Record<string, unknown>;
  let tsconfig: string | undefined;
  try {
    hosts = await hostModules();
    tsconfig = await findTsconfig(entry.entryPath, entry.packageRoot);
  } catch {
    throw new ExtensionLoadError("Extension module failed to load");
  }
  const options: JitiOptions = {
    fsCache: false,
    moduleCache: false,
    interopDefault: false,
    tryNative: false,
    nativeModules: [],
    transformModules: [],
    // Private jiti patch: only exact true enables extension mode. Every ordinary
    // dependency in this graph is transpiled so nested CJS also reaches the
    // virtual host modules, graph-private JSON cache and format checks.
    transformAll: true,
    // TSX is compiled with the automatic runtime; extensions provide their own runtime
    // via @jsxImportSource (or a react/jsx-runtime dependency).
    jsx: { runtime: "automatic" },
    virtualModules: hosts,
  };
  if (tsconfig !== undefined) options.tsconfigPaths = tsconfig;

  let evaluated: unknown;
  try {
    const jiti = createJiti(entry.entryPath, options) as ReturnType<typeof createJiti> & {
      readonly piscesExtensionModeVersion?: unknown;
    };
    // An unpatched or wrongly patched install must fail before byte evaluation,
    // not silently restore native CJS loading.
    if (jiti.piscesExtensionModeVersion !== 1) {
      throw new ExtensionLoadError("Extension loader patch is unavailable");
    }
    evaluated = await jiti.evalModule(bytes.toString("utf8"), {
      filename: entry.entryPath,
      async: true,
      // Always execute the bytes already checked against the frozen digest, even for
      // plain JS/CJS entries that jiti would otherwise load natively from disk.
      forceTranspile: true,
    });
  } catch (error) {
    if (error instanceof ExtensionLoadError) throw error;
    throw loadFailure(error);
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

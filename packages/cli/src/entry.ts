import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True only when `entry` denotes the module at `moduleUrl`, following symlinks
 * on both sides. `moduleUrl` is explicit because `import.meta.url` here is this
 * helper, not the caller entry.
 *
 * Package managers run bins through a symlink or shim, so comparing the raw
 * `argv[1]` string with `import.meta.url` silently skips the entry. An entry
 * that is missing or cannot be resolved is never this module.
 */
export function isEntryPath(entry: string | undefined, moduleUrl: string): boolean {
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

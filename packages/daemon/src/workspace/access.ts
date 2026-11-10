import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  access as accessProbe,
  mkdir,
  readFile as readFileFs,
  writeFile as writeFileFs,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { PiscesError, type WorkspaceAccess } from "@pisces/core";

const OUTSIDE = "Path is outside the workspace";
const IO = "Workspace access failed";
const MAX_LINK_DEPTH = 40;

function outside(): never {
  throw new PiscesError("workspace.path_outside", OUTSIDE);
}

function ioFailed(cause: unknown): never {
  throw new PiscesError("storage.io", IO, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isMissingComponent(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function fold(path: unknown): string[] {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) outside();
  if (isAbsolute(path)) outside();
  const segments: string[] = [];
  for (const segment of path.split(sep)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) outside();
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function contain(root: string, candidate: string): string {
  const rest = relative(root, candidate);
  if (rest === "") return candidate;
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) outside();
  return candidate;
}

function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch (error) {
    if (isMissingComponent(error)) return undefined;
    ioFailed(error);
  }
}

function tryLinkTarget(target: string): string | undefined {
  try {
    if (!lstatSync(target).isSymbolicLink()) return undefined;
    return readlinkSync(target);
  } catch (error) {
    if (isMissingComponent(error)) return undefined;
    ioFailed(error);
  }
}

// Returns the canonical path for `target`, including a possibly missing tail.
// Escapes are not judged here; callers check containment against the root.
function canonicalize(target: string, depth: number): string {
  let candidate = target;
  const tail: string[] = [];
  for (;;) {
    const real = tryRealpath(candidate);
    if (real !== undefined) return tail.length === 0 ? real : join(real, ...tail);
    const link = tryLinkTarget(candidate);
    if (link !== undefined) {
      if (depth >= MAX_LINK_DEPTH) ioFailed(new Error("Too many symbolic links"));
      const base = isAbsolute(link) ? link : join(dirname(candidate), link);
      return canonicalize(tail.length === 0 ? base : join(base, ...tail), depth + 1);
    }
    const parent = dirname(candidate);
    if (parent === candidate) ioFailed(new Error("Workspace root is not accessible"));
    tail.unshift(basename(candidate));
    candidate = parent;
  }
}

async function makeDirectory(target: string): Promise<void> {
  try {
    await mkdir(target, { recursive: true });
  } catch (error) {
    ioFailed(error);
  }
}

export function createWorkspaceAccess(root: string): WorkspaceAccess {
  // Canonicalize the root itself: callers may pass a path whose own components are
  // symlinks, while every candidate below is canonicalized before the containment check.
  // A missing root keeps its canonical prefix plus the missing tail, so preview works for
  // workspaces that do not exist yet without ever creating them here.
  const base = canonicalize(normalize(root), 0);
  const resolve = (path: string): string => {
    const segments = fold(path);
    return contain(base, canonicalize(segments.length === 0 ? base : join(base, ...segments), 0));
  };
  return {
    resolve,
    async ensureDirectory(path: string): Promise<void> {
      await makeDirectory(resolve(path));
    },
    async writeFile(path: string, content: string): Promise<void> {
      const target = resolve(path);
      await makeDirectory(dirname(target));
      try {
        await writeFileFs(target, content, "utf8");
      } catch (error) {
        ioFailed(error);
      }
    },
    async readFile(path: string): Promise<string> {
      const target = resolve(path);
      try {
        return await readFileFs(target, "utf8");
      } catch (error) {
        ioFailed(error);
      }
    },
    async exists(path: string): Promise<boolean> {
      const target = resolve(path);
      try {
        await accessProbe(target);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        ioFailed(error);
      }
    },
  };
}

import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { PiscesError } from "@pisces/core";
import { validateGlobalDraft, validateWorkspaceDraft } from "./config.js";

/**
 * Raw configuration draft I/O shared by the `config` commands.
 *
 * A draft is the file's JSON value without any defaults applied: a missing file
 * is `{}`, malformed JSON is a fixed `config.invalid`, and writes are atomic
 * (temp file + rename) with private permissions. Symlinked targets are refused
 * so an edit can never follow a link outside the configuration path.
 */

export { validateGlobalDraft, validateWorkspaceDraft };

const INVALID_MESSAGE = "Invalid configuration";
const STORAGE_MESSAGE = "Configuration file could not be written";

function invalid(): never {
  throw new PiscesError("config.invalid", INVALID_MESSAGE);
}

const storageFailure = (cause: unknown): PiscesError =>
  new PiscesError("storage.io", STORAGE_MESSAGE, { cause });

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/** Reads the file's JSON value; a missing file reads as an empty object. */
export async function readConfigDraft(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    invalid();
  }
  try {
    return JSON.parse(text);
  } catch {
    invalid();
  }
}

function serialize(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    invalid();
  }
  if (text === undefined) invalid();
  return `${text}\n`;
}

async function assertWritableTarget(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw storageFailure(error);
  }
  if (info.isSymbolicLink()) throw storageFailure(new Error("symbolic link target"));
}

let tempCounter = 0;

/**
 * Writes `value` atomically: the parent directory is created `0700`, the temp
 * file is created `0600` and renamed over the target. Any failure removes the
 * temp file and surfaces as a fixed `storage.io`.
 */
export async function writeConfigFile(path: string, value: unknown): Promise<void> {
  tempCounter += 1;
  const tempPath = `${path}.tmp-${process.pid}-${tempCounter}`;
  try {
    await assertWritableTarget(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(serialize(value), "utf8");
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // The temp file may never have been created.
    }
    if (error instanceof PiscesError) throw error;
    throw storageFailure(error);
  }
}

import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { PiscesError, type ProjectRef } from "@pisces/core";

const FILE = "projects.json";
const CORRUPT = "Project records are corrupt";
const IO = "Project records could not be written";
const KEYS = new Set(["id", "templateId", "workspace", "createdAt"]);

const chains = new Map<string, Promise<unknown>>();

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function corrupt(cause?: unknown): PiscesError {
  return new PiscesError("storage.corrupt", CORRUPT, { cause });
}

function ioFailed(cause: unknown): PiscesError {
  return new PiscesError("storage.io", IO, { cause });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isProjectRef(value: unknown): value is ProjectRef {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !KEYS.has(key))) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.templateId === "string" &&
    value.templateId.length > 0 &&
    typeof value.workspace === "string" &&
    value.workspace.length > 0 &&
    typeof value.createdAt === "string" &&
    value.createdAt.length > 0
  );
}

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

export async function readProjects(dataDir: string): Promise<ProjectRef[]> {
  const file = join(dataDir, FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw ioFailed(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw corrupt(cause);
  }
  if (!Array.isArray(parsed) || !parsed.every(isProjectRef)) throw corrupt();
  return parsed;
}

async function ensureDataDir(dataDir: string): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw ioFailed(error);
  }
}

async function rejectSymlink(file: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw ioFailed(error);
  }
  if (stats.isSymbolicLink()) throw ioFailed(new Error("Project records are symlinked"));
}

async function writeRecords(file: string, records: ProjectRef[]): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await unlink(temp).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(records, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw ioFailed(error);
  }
}

export async function appendProject(dataDir: string, ref: ProjectRef): Promise<void> {
  const key = resolvePath(dataDir);
  await serialize(key, async () => {
    await ensureDataDir(key);
    const file = join(key, FILE);
    await rejectSymlink(file);
    const records = await readProjects(key);
    await writeRecords(file, [...records, ref]);
  });
}

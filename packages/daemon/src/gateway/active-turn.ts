import { join } from "node:path";
import { type NodeId, PiscesError, type SessionId, type TurnId } from "@pisces/core";
import { assertSessionId, corrupt, parseJson } from "../session-store/session-store-format.js";
import { sessionStoreIo as io } from "../session-store/session-store-io.js";

export interface ActiveTurnMarker {
  turnId: TurnId;
  startedAt: string;
  startOffset: number;
  startNodeId?: NodeId;
}

export interface ActiveTurnStore {
  read(sessionId: SessionId): Promise<ActiveTurnMarker | undefined>;
  write(sessionId: SessionId, marker: ActiveTurnMarker): Promise<void>;
  remove(sessionId: SessionId, turnId: TurnId): Promise<void>;
  list(): Promise<{ sessionId: SessionId; marker: ActiveTurnMarker }[]>;
}

export interface ActiveTurnStoreOptions {
  dataDir: string;
}

const name = "active-turn.json";
const keys = new Set(["turnId", "startedAt", "startOffset", "startNodeId"]);
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const storageError = (error: unknown) =>
  error instanceof PiscesError || error instanceof TypeError
    ? error
    : new PiscesError("storage.io", "Active turn storage I/O failed", { cause: error });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function assertMarker(value: unknown): asserts value is ActiveTurnMarker {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !keys.has(key)) ||
    !id(value.turnId) ||
    !timestamp(value.startedAt) ||
    !Number.isSafeInteger(value.startOffset) ||
    (value.startOffset as number) < 0 ||
    (value.startNodeId !== undefined && !id(value.startNodeId))
  )
    throw new TypeError("Invalid active turn marker");
}

export function createActiveTurnStore({ dataDir }: ActiveTurnStoreOptions): ActiveTurnStore {
  const root = join(dataDir, "sessions");
  const directory = (sessionId: SessionId) => join(root, sessionId);
  const file = (sessionId: SessionId) => join(directory(sessionId), name);
  async function checked(path: string, directoryType = false): Promise<boolean> {
    try {
      const value = await io.lstat(path);
      if (directoryType ? !value.isDirectory() : !value.isFile())
        throw corrupt(`Unexpected file type: ${path}`);
      return true;
    } catch (error) {
      if (code(error) === "ENOENT") return false;
      throw error;
    }
  }

  async function read(sessionId: SessionId): Promise<ActiveTurnMarker | undefined> {
    assertSessionId(sessionId);
    try {
      if (!(await checked(directory(sessionId), true))) return undefined;
      if (!(await checked(file(sessionId)))) return undefined;
      const value = parseJson(await io.readFile(file(sessionId)));
      try {
        assertMarker(value);
      } catch (cause) {
        throw corrupt("Invalid active turn marker", cause);
      }
      return value;
    } catch (error) {
      throw storageError(error);
    }
  }
  async function write(sessionId: SessionId, marker: ActiveTurnMarker): Promise<void> {
    assertSessionId(sessionId);
    assertMarker(marker);
    const dir = directory(sessionId);
    const temp = join(dir, `${name}.tmp`);
    try {
      if (!(await checked(dir, true)))
        throw new PiscesError("storage.io", "Session directory does not exist");
      await io.writeSynced(temp, Buffer.from(`${JSON.stringify(marker)}\n`));
      await io.rename(temp, file(sessionId));
      await io.syncDirectory(dir);
    } catch (error) {
      throw storageError(error);
    }
  }
  async function remove(sessionId: SessionId, turnId: TurnId): Promise<void> {
    assertSessionId(sessionId);
    const current = await read(sessionId);
    if (!current || current.turnId !== turnId) return;
    const dir = directory(sessionId);
    try {
      await io.unlink(file(sessionId));
    } catch (error) {
      if (code(error) === "ENOENT") return;
      throw storageError(error);
    }
    await io.syncDirectory(dir);
  }
  async function list(): Promise<{ sessionId: SessionId; marker: ActiveTurnMarker }[]> {
    const entries = await io.readdir(root).catch((error: unknown) => {
      if (code(error) === "ENOENT") return [];
      throw storageError(error);
    });
    const result: { sessionId: SessionId; marker: ActiveTurnMarker }[] = [];
    for (const entry of entries.sort()) {
      if (!/^[A-Za-z0-9_-]+$/.test(entry)) continue;
      const sessionId = entry as SessionId;
      const marker = await read(sessionId);
      if (marker) result.push({ sessionId, marker });
    }
    return result;
  }
  return { read, write, remove, list };
}

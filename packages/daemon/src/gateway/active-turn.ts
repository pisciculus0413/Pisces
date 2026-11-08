import { join } from "node:path";
import { type NodeId, PiscesError, type SessionId, type TurnId } from "@pisces/core";
import {
  assertSessionId,
  corrupt,
  object,
  parseJson,
  timestamp,
  validId,
} from "../session-store/session-store-format.js";
import {
  checked,
  errorCode,
  sessionStoreIo as io,
  storageError,
} from "../session-store/session-store-io.js";

export interface ActiveTurnMarker {
  turnId: TurnId;
  startedAt: string;
  startOffset: number;
  startNodeId?: NodeId;
}

export type ActiveTurnScanEntry =
  | { sessionId: SessionId; marker: ActiveTurnMarker }
  | { sessionId: SessionId; error: PiscesError };

export interface ActiveTurnStore {
  read(sessionId: SessionId): Promise<ActiveTurnMarker | undefined>;
  write(sessionId: SessionId, marker: ActiveTurnMarker): Promise<void>;
  remove(sessionId: SessionId, turnId: TurnId): Promise<void>;
  list(): Promise<{ sessionId: SessionId; marker: ActiveTurnMarker }[]>;
  scan(): Promise<ActiveTurnScanEntry[]>;
}

export interface ActiveTurnStoreOptions {
  dataDir: string;
}

const name = "active-turn.json";
const message = "Active turn storage I/O failed";
const keys = new Set(["turnId", "startedAt", "startOffset", "startNodeId"]);
function assertMarker(value: unknown): asserts value is ActiveTurnMarker {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !keys.has(key)) ||
    !validId(value.turnId) ||
    !timestamp(value.startedAt) ||
    !Number.isSafeInteger(value.startOffset) ||
    (value.startOffset as number) < 0 ||
    (value.startNodeId !== undefined && !validId(value.startNodeId))
  )
    throw new TypeError("Invalid active turn marker");
}

export function createActiveTurnStore({ dataDir }: ActiveTurnStoreOptions): ActiveTurnStore {
  const root = join(dataDir, "sessions");
  const directory = (sessionId: SessionId) => join(root, sessionId);
  const file = (sessionId: SessionId) => join(directory(sessionId), name);

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
      throw storageError(error, message);
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
      throw storageError(error, message);
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
      if (errorCode(error) === "ENOENT") return;
      throw storageError(error, message);
    }
    await io.syncDirectory(dir);
  }
  async function scan(): Promise<ActiveTurnScanEntry[]> {
    const entries = await io.readdir(root).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return [];
      throw storageError(error, message);
    });
    const result: ActiveTurnScanEntry[] = [];
    for (const entry of entries.sort()) {
      if (!validId(entry)) continue;
      const sessionId = entry as SessionId;
      try {
        const marker = await read(sessionId);
        if (marker) result.push({ sessionId, marker });
      } catch (error) {
        result.push({
          sessionId,
          error:
            error instanceof PiscesError
              ? error
              : new PiscesError("storage.io", message, { cause: error }),
        });
      }
    }
    return result;
  }
  async function list(): Promise<{ sessionId: SessionId; marker: ActiveTurnMarker }[]> {
    const result: { sessionId: SessionId; marker: ActiveTurnMarker }[] = [];
    for (const entry of await scan()) {
      if ("error" in entry) throw entry.error;
      result.push(entry);
    }
    return result;
  }
  return { read, write, remove, list, scan };
}

import { join } from "node:path";
import {
  PiscesError,
  type SessionId,
  type SessionMeta,
  type SessionNode,
  type SessionRepository,
} from "@pisces/core";
import {
  assertSessionId,
  buildIndex,
  corrupt,
  encodeBatch,
  parseCommit,
  parseJson,
  type SessionIndex,
  validMeta,
} from "./session-store-format.js";
import { sessionStoreIo as io } from "./session-store-io.js";

export interface SessionStoreOptions {
  dataDir: string;
}
export interface RecoveryIssue {
  sessionId: SessionId;
  error: PiscesError;
}
export interface SessionStore extends SessionRepository {
  initialize(): Promise<RecoveryIssue[]>;
}
interface Snapshot {
  meta: SessionMeta;
  index: SessionIndex;
}
const names = ["meta.json", "events.jsonl", "events.commit"] as const;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const storageError = (error: unknown) =>
  error instanceof PiscesError || error instanceof TypeError
    ? error
    : new PiscesError("storage.io", "Session storage I/O failed", { cause: error });
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

export function createSessionStore({ dataDir }: SessionStoreOptions): SessionStore {
  const root = join(dataDir, "sessions");
  const cache = new Map<SessionId, Snapshot>();
  const revisions = new Map<SessionId, number>();
  function invalidate(id: SessionId): void {
    cache.delete(id);
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
  }
  const issuesBySession = new Map<SessionId, PiscesError>();
  let initialized = false;
  let initialization: Promise<RecoveryIssue[]> | undefined;
  function ready(id?: string): void {
    if (!initialized) throw new TypeError("SessionStore is not initialized");
    if (id !== undefined) assertSessionId(id);
  }
  const directory = (id: SessionId) => join(root, id);
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
  async function bytesAt(path: string, offset: number, length: number): Promise<Buffer> {
    const file = await io.open(path, "r");
    try {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(bytes, read, length - read, offset + read);
        if (!bytesRead) throw corrupt("Unexpected end of committed events");
        read += bytesRead;
      }
      return bytes;
    } finally {
      await file.close();
    }
  }
  async function load(id: SessionId): Promise<Snapshot> {
    const issue = issuesBySession.get(id);
    if (issue) throw issue;
    const revision = revisions.get(id) ?? 0;
    const dir = directory(id);
    if (!(await checked(dir, true)) || !(await checked(join(dir, "meta.json"))))
      throw new PiscesError("session.not_found", "Session does not exist");
    for (const name of names.slice(1))
      if (!(await checked(join(dir, name)))) throw corrupt(`Missing ${name}`);
    const existing = cache.get(id);
    if (existing) return existing;
    const meta = parseJson(await io.readFile(join(dir, "meta.json")));
    if (!validMeta(meta, id)) throw corrupt("Invalid session metadata");
    const committed = await io.readFile(join(dir, "events.commit"));
    const size = (await io.lstat(join(dir, "events.jsonl"))).size;
    const commit = parseCommit(committed, size);
    const index = buildIndex(await bytesAt(join(dir, "events.jsonl"), 0, commit));
    const snapshot = { meta, index };
    if ((revisions.get(id) ?? 0) === revision) cache.set(id, snapshot);
    return snapshot;
  }
  async function temporary(dir: string, name: string, bytes: Buffer): Promise<void> {
    const path = join(dir, `${name}.tmp`);
    await checked(path);
    await io.writeSynced(path, bytes);
  }
  async function replace(dir: string, name: string, bytes: Buffer): Promise<void> {
    await temporary(dir, name, bytes);
    await io.rename(join(dir, `${name}.tmp`), join(dir, name));
  }
  // Read snapshots are immutable; a failed write forces the next read to reload its commit boundary.
  const store: SessionStore = {
    initialize() {
      if (initialization) return initialization;
      initialization = (async () => {
        try {
          await io.mkdir(root, { recursive: true });
          await checked(root, true);
          const issues: RecoveryIssue[] = [];
          for (const entry of await io.readdir(root)) {
            if (!/^[A-Za-z0-9_-]+$/.test(entry)) continue;
            const id = entry as SessionId;
            const dir = directory(id);
            try {
              await checked(dir, true);
              for (const name of names) {
                await checked(join(dir, name));
                await checked(join(dir, `${name}.tmp`));
              }
              if (!(await checked(join(dir, "meta.json")))) {
                await io.rm(dir, { recursive: true });
                continue;
              }
              const snapshot = await load(id);
              const path = join(dir, "events.jsonl");
              if ((await io.lstat(path)).size > snapshot.index.commit) {
                await io.truncate(path, snapshot.index.commit);
                const file = await io.open(path, "r+");
                try {
                  await file.sync();
                } finally {
                  await file.close();
                }
              }
              for (const name of names)
                if (await checked(join(dir, `${name}.tmp`)))
                  await io.unlink(join(dir, `${name}.tmp`));
            } catch (error) {
              invalidate(id);
              const issue = storageError(error) as PiscesError;
              issuesBySession.set(id, issue);
              issues.push({ sessionId: id, error: issue });
            }
          }
          initialized = true;
          return issues;
        } catch (error) {
          throw storageError(error);
        }
      })();
      return initialization;
    },
    async create(meta, nodes) {
      ready(meta.id);
      if (!validMeta(meta, meta.id)) throw new TypeError("Invalid session metadata");
      const batch = encodeBatch(nodes);
      const dir = directory(meta.id);
      let owned = false;
      let committed = false;
      try {
        try {
          await io.mkdir(dir);
          owned = true;
        } catch (error) {
          if (code(error) === "EEXIST") throw new TypeError("Session already exists");
          throw error;
        }
        await temporary(dir, "events.jsonl", batch.bytes);
        await temporary(dir, "events.commit", Buffer.from(`${batch.index.commit}\n`));
        await temporary(dir, "meta.json", json(meta));
        for (const name of ["events.jsonl", "events.commit", "meta.json"]) {
          await io.rename(join(dir, `${name}.tmp`), join(dir, name));
          if (name === "meta.json") committed = true;
        }
        await io.syncDirectory(dir);
        await io.syncDirectory(root);
        invalidate(meta.id);
        cache.set(meta.id, { meta: structuredClone(meta), index: batch.index });
      } catch (error) {
        invalidate(meta.id);
        if (owned && !committed) await io.rm(dir, { recursive: true, force: true });
        throw storageError(error);
      }
    },
    async append(id, nodes) {
      ready(id);
      try {
        const snapshot = await load(id);
        const batch = encodeBatch(nodes, snapshot.index);
        const dir = directory(id);
        await io.truncate(join(dir, "events.jsonl"), snapshot.index.commit);
        await io.appendSynced(join(dir, "events.jsonl"), batch.bytes);
        await replace(dir, "events.commit", Buffer.from(`${batch.index.commit}\n`));
        await io.syncDirectory(dir);
        invalidate(id);
        cache.set(id, { meta: snapshot.meta, index: batch.index });
      } catch (error) {
        invalidate(id);
        throw storageError(error);
      }
    },
    async *readTree(id) {
      ready(id);
      try {
        const { index } = await load(id);
        for (const position of index.positions.values())
          yield parseJson(
            await bytesAt(join(directory(id), "events.jsonl"), position.offset, position.length),
          ) as SessionNode;
      } catch (error) {
        throw storageError(error);
      }
    },
    async *readBranch(id, nodeId) {
      ready(id);
      try {
        const { index } = await load(id);
        let current = nodeId ?? index.last;
        if (!index.positions.has(current))
          throw new PiscesError("session.node_not_found", "Node not in session");
        const branch = [];
        while (true) {
          const position = index.positions.get(current);
          if (!position) throw corrupt("Missing indexed parent");
          branch.push(position);
          if (current === position.parentId) break;
          current = position.parentId;
        }
        for (const position of branch.reverse())
          yield parseJson(
            await bytesAt(join(directory(id), "events.jsonl"), position.offset, position.length),
          ) as SessionNode;
      } catch (error) {
        throw storageError(error);
      }
    },
    async list() {
      ready();
      try {
        const result = [];
        for (const entry of await io.readdir(root)) {
          if (!/^[A-Za-z0-9_-]+$/.test(entry)) continue;
          const id = entry as SessionId;
          const issue = issuesBySession.get(id);
          if (issue) throw issue;
          if (
            !(await checked(directory(id), true)) ||
            !(await checked(join(directory(id), "meta.json")))
          )
            continue;
          result.push(structuredClone((await load(id)).meta));
        }
        return result;
      } catch (error) {
        throw storageError(error);
      }
    },
    async updateMeta(id, input) {
      ready(id);
      try {
        const snapshot = await load(id);
        const meta = { ...snapshot.meta, model: input.model, provider: input.provider };
        if (!validMeta(meta, id)) throw new TypeError("Invalid session metadata");
        await replace(directory(id), "meta.json", json(meta));
        await io.syncDirectory(directory(id));
        invalidate(id);
        cache.set(id, { meta, index: snapshot.index });
      } catch (error) {
        invalidate(id);
        throw storageError(error);
      }
    },
  };
  const queues = new Map<SessionId, Promise<void>>();
  function enqueue(id: SessionId, task: () => Promise<void>): Promise<void> {
    const result = (queues.get(id) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => {},
      () => {},
    );
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return result;
  }
  return {
    ...store,
    async create(meta, nodes) {
      ready(meta.id);
      return enqueue(meta.id, () => store.create(meta, nodes));
    },
    async append(id, nodes) {
      ready(id);
      return enqueue(id, () => store.append(id, nodes));
    },
    async updateMeta(id, meta) {
      ready(id);
      return enqueue(id, () => store.updateMeta(id, meta));
    },
  };
}

import { PiscesError } from "../types.js";
import type { NodeId, SessionNode, SessionNodeDraft, Sessions, SessionsDeps } from "./types.js";
export function createSessions({ repository, newId, now }: SessionsDeps): Sessions {
  function build(drafts: SessionNodeDraft[], parent?: NodeId): SessionNode[] {
    return drafts.map((draft) => {
      const id = newId();
      const node = { ...draft, id, parentId: parent ?? id, createdAt: now(), schemaVersion: 1 };
      parent = id;
      return node;
    });
  }
  return {
    async create(meta, drafts, options) {
      if (!drafts.length) throw new TypeError("Empty drafts");
      const nodes = build(drafts);
      options?.validate?.(structuredClone(nodes));
      await repository.create(meta, nodes);
      return nodes;
    },
    async append(id, drafts, parentId, options) {
      if (!drafts.length) throw new TypeError("Empty drafts");
      let parent: NodeId | undefined;
      for await (const node of repository.readBranch(id, parentId)) parent = node.id;
      if (parent === undefined) throw new PiscesError("storage.corrupt", "Empty session branch");
      const nodes = build(drafts, parent);
      options?.validate?.(structuredClone(nodes));
      await repository.append(id, nodes);
      return nodes;
    },
    readBranch: (id, nodeId) => repository.readBranch(id, nodeId),
    readTree: (id) => repository.readTree(id),
    list: () => repository.list(),
    updateMeta: (id, meta) => repository.updateMeta(id, meta),
  };
}

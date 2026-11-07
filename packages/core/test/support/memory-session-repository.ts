import {
  type NodeId,
  PiscesError,
  type SessionId,
  type SessionMeta,
  type SessionNode,
  type SessionRepository,
} from "../../src/index.js";

type Operation = "create" | "append" | "updateMeta";
export class MemorySessionRepository implements SessionRepository {
  private records = new Map<SessionId, { meta: SessionMeta; nodes: SessionNode[] }>();
  private failures = new Map<Operation, Error>();
  failNextWrite(operation: Operation, error: Error): void {
    this.failures.set(operation, error);
  }
  private check(operation: Operation) {
    const error = this.failures.get(operation);
    if (error) {
      this.failures.delete(operation);
      throw error;
    }
  }
  private get(id: SessionId) {
    const value = this.records.get(id);
    if (!value) throw new PiscesError("session.not_found", "Session not found");
    return value;
  }
  async create(meta: SessionMeta, nodes: SessionNode[]) {
    if (this.records.has(meta.id)) throw new TypeError("Session exists");
    const value = structuredClone({ meta, nodes });
    this.check("create");
    this.records.set(meta.id, value);
  }
  async append(id: SessionId, nodes: SessionNode[]) {
    const previous = this.get(id);
    const ids = new Set(previous.nodes.map((n) => n.id));
    for (const node of nodes) {
      if (!ids.has(node.parentId) || ids.has(node.id))
        throw new PiscesError("session.node_not_found", "Invalid node");
      ids.add(node.id);
    }
    const value = structuredClone({ meta: previous.meta, nodes: [...previous.nodes, ...nodes] });
    this.check("append");
    this.records.set(id, value);
  }
  async *readTree(id: SessionId): AsyncIterable<SessionNode> {
    yield* structuredClone(this.get(id).nodes);
  }
  async *readBranch(id: SessionId, nodeId?: NodeId): AsyncIterable<SessionNode> {
    const nodes = this.get(id).nodes;
    let node = nodeId === undefined ? nodes.at(-1) : nodes.find((n) => n.id === nodeId);
    if (!node) throw new PiscesError("session.node_not_found", "Node not found");
    const branch: SessionNode[] = [];
    while (node) {
      branch.unshift(node);
      if (node.id === node.parentId) break;
      node = nodes.find((n) => n.id === node?.parentId);
    }
    yield* structuredClone(branch);
  }
  async list() {
    return structuredClone([...this.records.values()].map((r) => r.meta));
  }
  async updateMeta(id: SessionId, meta: SessionMeta) {
    const previous = this.get(id);
    const value = structuredClone({
      meta: { ...previous.meta, model: meta.model, provider: meta.provider },
      nodes: previous.nodes,
    });
    this.check("updateMeta");
    this.records.set(id, value);
  }
}

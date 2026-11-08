import { randomUUID } from "node:crypto";
import { createSessions, type NodeId } from "@pisces/core";
import type { RecoveryIssue } from "../session-store/session-store.js";
import { createGateway, type Gateway, type GatewayDeps } from "./gateway.js";
import { recoverActiveTurns } from "./recovery.js";

export interface BootstrapResult {
  gateway: Gateway;
  initializationIssues: RecoveryIssue[];
  recoveryIssues: RecoveryIssue[];
}

export async function bootstrapGateway(deps: GatewayDeps): Promise<BootstrapResult> {
  const initializationIssues = await deps.store.initialize();
  const sessions = createSessions({
    repository: deps.store,
    newId: deps.newNodeId ?? (() => randomUUID() as NodeId),
    now: deps.now ?? (() => new Date().toISOString()),
  });
  const recoveryIssues = await recoverActiveTurns({
    store: deps.store,
    markers: deps.markers,
    sessions,
  });
  return { gateway: createGateway(deps), initializationIssues, recoveryIssues };
}

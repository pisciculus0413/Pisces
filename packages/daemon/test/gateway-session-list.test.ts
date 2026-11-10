import type { JsonValue, SessionId } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import type { SessionListResult } from "../src/gateway/protocol.js";
import {
  createGatewayHarness,
  draftQueueUser,
  type GatewayHarness,
} from "./support/gateway-harness.js";

const open: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function openHarness(): Promise<GatewayHarness> {
  const harness = await createGatewayHarness();
  open.push(harness);
  return harness;
}

function sessionList(harness: GatewayHarness, params: Record<string, unknown> = {}) {
  return harness.gateway.handle({
    id: "list",
    method: "session.list",
    params: params as unknown as JsonValue,
  });
}

async function createSession(
  harness: GatewayHarness,
  params: Record<string, unknown> = {},
): Promise<{
  id: SessionId;
  provider: string;
  model: string;
  workspace: string;
  createdAt: string;
}> {
  const response = await harness.gateway.handle({
    id: "create",
    method: "session.create",
    params: {
      workspace: harness.dataDir,
      provider: "p",
      model: "m",
      ...params,
    } as unknown as JsonValue,
  });
  if (response.error) throw new Error(response.error.message);
  return response.result as unknown as {
    id: SessionId;
    provider: string;
    model: string;
    workspace: string;
    createdAt: string;
  };
}

test("returns an empty list when no session is persisted and ignores parameters", async () => {
  const h = await openHarness();

  const response = await sessionList(h, { ignored: true });

  expect(response).toEqual({ id: "list", result: { sessions: [] } });
});

test("does not list a session that exists only in memory", async () => {
  const h = await openHarness();
  const created = await createSession(h);

  const response = await sessionList(h);

  expect(response.error).toBeUndefined();
  expect((response.result as unknown as SessionListResult).sessions).toEqual([]);
  expect(JSON.stringify(response)).not.toContain(created.id);
});

test("lists a session after turn.start persists it", async () => {
  const h = await openHarness();
  const created = await createSession(h);
  expect((await sessionList(h)).result).toEqual({ sessions: [] });

  await h.enqueue(created.id, [draftQueueUser("hello")]);
  const started = await h.gateway.handle({
    id: "start",
    method: "turn.start",
    params: { sessionId: created.id } as unknown as JsonValue,
  });
  if (started.error) throw new Error(started.error.message);
  const { turnId } = started.result as unknown as { turnId: string };
  await h.waitForTurnEnd(turnId as never);

  const response = await sessionList(h);

  expect(response.result).toEqual({
    sessions: [
      {
        id: created.id,
        provider: created.provider,
        model: created.model,
        workspace: created.workspace,
        createdAt: created.createdAt,
        schemaVersion: 1,
      },
    ],
  });
});

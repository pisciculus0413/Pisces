import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryName, JsonValue, SessionId, SessionMeta } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import {
  createGatewayHarness,
  draftQueueUser,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./support/gateway-harness.js";

const ID = "s-fixed" as SessionId;
const open: GatewayHarness[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openHarness(options: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
  const harness = await createGatewayHarness({ newSessionId: () => ID, ...options });
  open.push(harness);
  return harness;
}

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pisces-workspace-"));
  workspaces.push(dir);
  return dir;
}

function createSession(harness: GatewayHarness, params: Record<string, unknown>) {
  return harness.gateway.handle({
    id: "create",
    method: "session.create",
    params: params as unknown as JsonValue,
  });
}

async function expectRejected(
  harness: GatewayHarness,
  params: Record<string, unknown>,
  code: string,
): Promise<void> {
  const response = await createSession(harness, params);
  expect(response.error?.code).toBe(code);
  expect(await harness.store.list()).toEqual([]);
  expect(harness.events().filter((event) => event.type === "queue.updated")).toEqual([]);
  const follow = await harness.gateway.handle({
    id: "follow",
    method: "queue.enqueue",
    params: { sessionId: ID, entries: [draftQueueUser("probe")] } as unknown as JsonValue,
  });
  expect(follow.error?.code).toBe("session.not_found");
}

test("creates a temporary session from defaults and materializes the queue", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness({ defaults: { workspace, provider: "p", model: "m" } });

  const created = await createSession(h, { systemPrompt: ["be brief"] });

  const meta = created.result as unknown as SessionMeta;
  expect(meta).toMatchObject({
    id: ID,
    model: "m",
    provider: "p",
    workspace,
    schemaVersion: 1,
  });
  expect(await h.store.list()).toEqual([]);
  const queued = h
    .events()
    .filter((event) => event.type === "queue.updated")
    .at(-1);
  expect(queued?.data).toMatchObject({
    queue: [
      {
        kind: "agent",
        role: "system",
        source: "create",
        content: [{ type: "text", text: "be brief" }],
      },
    ],
  });
});

test("accepts explicit empty extensions over a non-empty default", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness({
    defaults: {
      workspace,
      provider: "p",
      model: "m",
      extensions: ["pkg#tool" as EntryName],
    },
  });

  const created = await createSession(h, { extensions: [] });

  expect(created.error).toBeUndefined();
  expect((created.result as unknown as SessionMeta).workspace).toBe(workspace);
});

test("requires a workspace when no default exists", async () => {
  const h = await openHarness({ defaults: { provider: "p", model: "m" } });

  await expectRejected(h, {}, "session.workspace_required");
});

test("rejects a workspace that fails validation", async () => {
  const h = await openHarness({
    defaults: { provider: "p", model: "m" },
    validateWorkspace: async () => false,
  });

  await expectRejected(
    h,
    { workspace: "/definitely/not/a/pisces/workspace" },
    "session.invalid_workspace",
  );
});

test("rejects a default workspace path that does not exist", async () => {
  const h = await openHarness({
    defaults: {
      workspace: "/definitely/not/a/pisces/workspace",
      provider: "p",
      model: "m",
    },
  });

  await expectRejected(h, {}, "session.invalid_workspace");
});

test("requires provider and model together", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness();

  await expectRejected(h, { workspace, provider: "p" }, "session.model_required");
  await expectRejected(h, { workspace, model: "m" }, "session.model_required");
  await expectRejected(h, { workspace }, "session.model_required");
});

test("rejects a provider/model pair that is not in the catalogue", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness();

  await expectRejected(h, { workspace, provider: "p", model: "unknown" }, "session.invalid_model");
});

test("rejects templateId", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness();

  await expectRejected(
    h,
    { workspace, provider: "p", model: "m", templateId: "template" },
    "protocol.invalid_request",
  );
});

test("rejects a non-string system prompt entry", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness();

  await expectRejected(
    h,
    { workspace, provider: "p", model: "m", systemPrompt: [1] as unknown as string[] },
    "protocol.invalid_request",
  );
});

test("rejects an extension name that is not package#name", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness();

  await expectRejected(
    h,
    { workspace, provider: "p", model: "m", extensions: ["nope" as EntryName] },
    "queue.invalid_control",
  );
});

test("rejects duplicate extension names", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness();

  await expectRejected(
    h,
    {
      workspace,
      provider: "p",
      model: "m",
      extensions: ["pkg#tool" as EntryName, "pkg#tool" as EntryName],
    },
    "queue.duplicate_name",
  );
});

test("rejects a non-empty explicit extension list", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness();

  await expectRejected(
    h,
    { workspace, provider: "p", model: "m", extensions: ["pkg#tool" as EntryName] },
    "queue.invalid_control",
  );
});

test("rejects a non-empty default extension list", async () => {
  const workspace = await tempWorkspace();
  const h = await openHarness({
    defaults: {
      workspace,
      provider: "p",
      model: "m",
      extensions: ["pkg#tool" as EntryName],
    },
  });

  await expectRejected(h, {}, "queue.invalid_control");
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderManagement,
  type JsonValue,
  PiscesError,
  type SessionId,
  type TemplateInfo,
  type TemplatePreview,
} from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import { createExtensions } from "../src/extensions/extensions.js";
import type { GatewayDeps } from "../src/gateway/gateway.js";
import type { GatewayResponse, SessionReadResult } from "../src/gateway/protocol.js";
import type { TemplateDefaults, TemplatePlan, TemplateResolution } from "../src/templates/store.js";
import {
  createGatewayHarness,
  descriptor,
  type GatewayHarness,
  type GatewayHarnessOptions,
  gatewayModel,
} from "./support/gateway-harness.js";

const ID = "s-template" as SessionId;
const MISSING = "/definitely/not/a/pisces/workspace";

type Templates = NonNullable<GatewayDeps["templates"]>;

interface FakeHandlers {
  list?: () => Promise<TemplateInfo[]>;
  preview?: (templateId: string, workspace: string) => Promise<TemplatePreview>;
  inspect?: (templateId: string, workspace: string) => Promise<TemplatePlan>;
  resolve?: (templateId: string, workspace: string) => Promise<TemplatePlan>;
  apply?: (
    templateId: string,
    workspace: string,
    options: { confirmed: true; overwrite?: boolean },
  ) => Promise<TemplateResolution>;
}

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
  const dir = await mkdtemp(join(tmpdir(), "pisces-template-gateway-"));
  workspaces.push(dir);
  return dir;
}

function previewFixture(overrides: Partial<TemplatePreview> = {}): TemplatePreview {
  return {
    directories: ["docs"],
    files: [{ path: "README.md", content: "# Notes\n" }],
    conflicts: [],
    ...overrides,
  };
}

function defaultsFixture(): TemplateDefaults {
  return { provider: "p", model: "m" };
}

/** Records every store call so ordering and "never touched" claims stay observable. */
function fakeTemplates(handlers: FakeHandlers = {}): { store: Templates; calls: string[] } {
  const calls: string[] = [];
  const store: Templates = {
    async list() {
      calls.push("list");
      return handlers.list === undefined ? [] : handlers.list();
    },
    async preview(templateId, workspace) {
      calls.push("preview");
      return handlers.preview === undefined
        ? previewFixture()
        : handlers.preview(templateId, workspace);
    },
    async inspect(templateId, workspace) {
      calls.push("inspect");
      return handlers.inspect === undefined
        ? { preview: previewFixture(), defaults: {} }
        : handlers.inspect(templateId, workspace);
    },
    async resolve(templateId, workspace) {
      calls.push("resolve");
      return handlers.resolve === undefined
        ? { preview: previewFixture(), defaults: {} }
        : handlers.resolve(templateId, workspace);
    },
    async apply(templateId, workspace, options) {
      calls.push("apply");
      return handlers.apply === undefined
        ? { projectId: "project-1", preview: previewFixture(), defaults: {} }
        : handlers.apply(templateId, workspace, options);
    },
  };
  return { store, calls };
}

function request(
  harness: GatewayHarness,
  method: string,
  params: Record<string, unknown> = {},
): Promise<GatewayResponse> {
  return harness.gateway.handle({
    id: method,
    method,
    params: params as unknown as JsonValue,
  });
}

function queuedPrompts(
  result: SessionReadResult,
): { role: string; source: string; text: unknown }[] {
  return result.queue.map((entry) => ({
    role: entry.role,
    source: entry.source,
    text: entry.content[0],
  }));
}

test("template methods are unknown methods without a store", async () => {
  const h = await openHarness();

  for (const [method, params] of [
    ["template.list", {}],
    ["template.preview", { templateId: "notes", workspace: MISSING }],
    ["template.apply", { templateId: "notes", workspace: MISSING, confirmed: true }],
  ] as const) {
    const response = await request(h, method, params);
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe("protocol.unknown_method");
  }
});

test("template.list returns the store inventory", async () => {
  const { store, calls } = fakeTemplates({
    list: async () => [{ id: "notes", name: "Notes project", description: "Notes" }],
  });
  const h = await openHarness({ templates: store });

  const response = await request(h, "template.list");

  expect(response.error).toBeUndefined();
  expect(response.result).toEqual({
    templates: [{ id: "notes", name: "Notes project", description: "Notes" }],
  });
  expect(calls).toEqual(["list"]);
});

test("template.preview validates params and returns the preview", async () => {
  const { store, calls } = fakeTemplates({
    preview: async () => previewFixture({ conflicts: ["README.md"] }),
  });
  const h = await openHarness({ templates: store });

  for (const params of [
    { workspace: MISSING },
    { templateId: "notes" },
    { templateId: 7, workspace: MISSING },
    { templateId: "", workspace: MISSING },
    { templateId: "notes", workspace: "" },
    { templateId: "notes", workspace: 1 },
  ]) {
    const rejected = await request(h, "template.preview", params);
    expect(rejected.error?.code).toBe("protocol.invalid_request");
  }
  expect(calls).toEqual([]);

  const response = await request(h, "template.preview", {
    templateId: "notes",
    workspace: MISSING,
  });

  expect(response.error).toBeUndefined();
  expect(response.result).toEqual(previewFixture({ conflicts: ["README.md"] }));
  expect(calls).toEqual(["preview"]);
});

test("template.preview passes store errors through unchanged", async () => {
  const { store } = fakeTemplates({
    preview: async () => {
      throw new PiscesError("template.not_found", "Template not found");
    },
  });
  const h = await openHarness({ templates: store });

  const response = await request(h, "template.preview", {
    templateId: "missing",
    workspace: MISSING,
  });

  expect(response.error).toEqual({ code: "template.not_found", message: "Template not found" });
});

test("template.apply requires confirmed true before touching the store", async () => {
  const { store, calls } = fakeTemplates();
  const h = await openHarness({ templates: store });

  for (const confirmed of [undefined, false, "true"]) {
    const params =
      confirmed === undefined
        ? { templateId: "notes", workspace: MISSING }
        : { templateId: "notes", workspace: MISSING, confirmed };
    const response = await request(h, "template.apply", params);
    expect(response.error?.code).toBe("protocol.invalid_request");
  }
  for (const params of [
    { workspace: MISSING, confirmed: true },
    { templateId: "notes", confirmed: true },
    { templateId: "notes", workspace: MISSING, confirmed: true, overwrite: "yes" },
  ]) {
    const response = await request(h, "template.apply", params);
    expect(response.error?.code).toBe("protocol.invalid_request");
  }
  expect(calls).toEqual([]);
});

test("template.apply requires provider and model before writing", async () => {
  const { store, calls } = fakeTemplates();
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store });

  const response = await request(h, "template.apply", {
    templateId: "notes",
    workspace,
    confirmed: true,
  });

  expect(response.error?.code).toBe("session.model_required");
  expect(calls).toEqual(["inspect"]);
  expect(await h.store.list()).toEqual([]);
  expect(h.events().filter((event) => event.type === "queue.updated")).toEqual([]);
});

test("template.apply rejects an unregistered model before writing", async () => {
  const { store, calls } = fakeTemplates({
    inspect: async () => ({
      preview: previewFixture(),
      defaults: { provider: "p", model: "unknown" },
    }),
  });
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store });

  const response = await request(h, "template.apply", {
    templateId: "notes",
    workspace,
    confirmed: true,
  });

  expect(response.error?.code).toBe("session.invalid_model");
  expect(calls).toEqual(["inspect"]);
});

test("template.apply rejects an invalid workspace before writing", async () => {
  const { store, calls } = fakeTemplates({
    inspect: async () => ({ preview: previewFixture(), defaults: defaultsFixture() }),
  });
  const h = await openHarness({ templates: store, validateWorkspace: async () => false });

  const response = await request(h, "template.apply", {
    templateId: "notes",
    workspace: MISSING,
    confirmed: true,
  });

  expect(response.error?.code).toBe("session.invalid_workspace");
  expect(calls).toEqual(["inspect"]);
});

test("template.apply creates the session from the store resolution", async () => {
  const applied: unknown[] = [];
  const { store, calls } = fakeTemplates({
    inspect: async () => ({ preview: previewFixture(), defaults: defaultsFixture() }),
    apply: async (templateId, workspace, options) => {
      applied.push({ templateId, workspace, options });
      return {
        projectId: "project-1",
        preview: previewFixture(),
        defaults: { ...defaultsFixture(), systemPrompt: "# Notes\n" },
      };
    },
  });
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store });

  const response = await request(h, "template.apply", {
    templateId: "notes",
    workspace,
    confirmed: true,
    overwrite: true,
  });

  expect(response.error).toBeUndefined();
  expect(response.result).toEqual({
    projectId: "project-1",
    sessionId: ID,
  } as unknown as JsonValue);
  expect(applied).toEqual([
    { templateId: "notes", workspace, options: { confirmed: true, overwrite: true } },
  ]);
  expect(calls).toEqual(["inspect", "apply"]);

  const read = await request(h, "session.read", { sessionId: ID });
  const result = read.result as unknown as SessionReadResult;
  expect(result.meta).toMatchObject({ id: ID, provider: "p", model: "m", workspace });
  expect(queuedPrompts(result)).toEqual([
    { role: "system", source: "template", text: { type: "text", text: "# Notes\n" } },
  ]);
  expect(await h.store.list()).toEqual([]);
});

test("template.apply builds the session from the apply resolution defaults", async () => {
  // A deliberately divergent preflight: the session must follow apply's own defaults.
  const providers = createProviderManagement();
  providers.registerProvider(descriptor({ models: [gatewayModel("m"), gatewayModel("m2")] }));
  const { store } = fakeTemplates({
    inspect: async () => ({ preview: previewFixture(), defaults: defaultsFixture() }),
    apply: async () => ({
      projectId: "project-1",
      preview: previewFixture(),
      defaults: { provider: "p", model: "m2", systemPrompt: "applied prompt" },
    }),
  });
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store, providers });

  const response = await request(h, "template.apply", {
    templateId: "notes",
    workspace,
    confirmed: true,
  });

  expect(response.error).toBeUndefined();
  const read = await request(h, "session.read", { sessionId: ID });
  const result = read.result as unknown as SessionReadResult;
  expect(result.meta).toMatchObject({ provider: "p", model: "m2", workspace });
  expect(queuedPrompts(result)).toEqual([
    { role: "system", source: "template", text: { type: "text", text: "applied prompt" } },
  ]);
});

test("template.apply passes store errors through and creates no session", async () => {
  const { store } = fakeTemplates({
    inspect: async () => ({
      preview: previewFixture({ conflicts: ["README.md"] }),
      defaults: defaultsFixture(),
    }),
    apply: async () => {
      throw new PiscesError("template.workspace_conflict", "Workspace conflicts with the template");
    },
  });
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store });

  const response = await request(h, "template.apply", {
    templateId: "notes",
    workspace,
    confirmed: true,
  });

  expect(response.result).toBeUndefined();
  expect(response.error).toEqual({
    code: "template.workspace_conflict",
    message: "Workspace conflicts with the template",
  });
  const read = await request(h, "session.read", { sessionId: ID });
  expect(read.error?.code).toBe("session.not_found");
});

test("session.create uses template defaults without writing", async () => {
  const { store, calls } = fakeTemplates({
    resolve: async () => ({
      preview: previewFixture(),
      defaults: { ...defaultsFixture(), systemPrompt: "template prompt" },
    }),
  });
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store });

  const response = await request(h, "session.create", { templateId: "notes", workspace });

  expect(response.error).toBeUndefined();
  expect(response.result).toMatchObject({ id: ID, provider: "p", model: "m", workspace });
  expect(calls).toEqual(["resolve"]);

  const read = await request(h, "session.read", { sessionId: ID });
  expect(queuedPrompts(read.result as unknown as SessionReadResult)).toEqual([
    { role: "system", source: "template", text: { type: "text", text: "template prompt" } },
  ]);
  expect(await h.store.list()).toEqual([]);
});

test("session.create with templateId uses the configured global workspace", async () => {
  const workspace = await tempWorkspace();
  const configDir = join(workspace, "config");
  await mkdir(configDir);
  await writeFile(join(configDir, "config.json"), JSON.stringify({ defaultWorkspace: workspace }));
  const extensions = createExtensions({ configDir });
  const resolved: string[] = [];
  const { store } = fakeTemplates({
    resolve: async (_templateId, resolvedWorkspace) => {
      resolved.push(resolvedWorkspace);
      return {
        preview: previewFixture(),
        defaults: { ...defaultsFixture(), systemPrompt: "template prompt" },
      };
    },
  });
  const h = await openHarness({ templates: store, extensions });

  // No explicit workspace: configured mode must fall back exactly as it does without a template.
  const response = await request(h, "session.create", { templateId: "notes" });

  expect(response.error).toBeUndefined();
  expect(response.result).toMatchObject({ id: ID, provider: "p", model: "m", workspace });
  expect(resolved).toEqual([workspace]);
  const read = await request(h, "session.read", { sessionId: ID });
  const result = read.result as unknown as SessionReadResult;
  expect(result.meta.workspace).toBe(workspace);
  expect(queuedPrompts(result)).toEqual([
    { role: "system", source: "template", text: { type: "text", text: "template prompt" } },
  ]);
});

test("session.create explicit values win over template defaults", async () => {
  const { store } = fakeTemplates({
    resolve: async () => ({
      preview: previewFixture(),
      defaults: { provider: "p", model: "unknown", systemPrompt: "template prompt" },
    }),
  });
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store });

  const response = await request(h, "session.create", {
    templateId: "notes",
    workspace,
    provider: "p",
    model: "m",
    systemPrompt: ["explicit prompt"],
  });

  expect(response.error).toBeUndefined();
  const read = await request(h, "session.read", { sessionId: ID });
  expect(queuedPrompts(read.result as unknown as SessionReadResult)).toEqual([
    { role: "system", source: "create", text: { type: "text", text: "explicit prompt" } },
  ]);
});

test("session.create reports an unknown template", async () => {
  const { store, calls } = fakeTemplates({
    resolve: async () => {
      throw new PiscesError("template.not_found", "Template not found");
    },
  });
  const workspace = await tempWorkspace();
  const h = await openHarness({ templates: store });

  const response = await request(h, "session.create", { templateId: "notes", workspace });

  expect(response.error?.code).toBe("template.not_found");
  expect(calls).toEqual(["resolve"]);
  expect(await h.store.list()).toEqual([]);
});

test("session.create rejects templateId without a store or a workspace", async () => {
  const noStore = await openHarness();
  const missingStore = await request(noStore, "session.create", {
    templateId: "notes",
    workspace: MISSING,
  });
  expect(missingStore.error?.code).toBe("protocol.invalid_request");

  const { store, calls } = fakeTemplates();
  const invalid = await openHarness({ templates: store });
  const noWorkspace = await request(invalid, "session.create", { templateId: "notes" });
  expect(noWorkspace.error?.code).toBe("session.workspace_required");
  expect(calls).toEqual([]);

  const nonString = await request(invalid, "session.create", { templateId: 7 });
  expect(nonString.error?.code).toBe("protocol.invalid_request");
});

test("session.create validates the workspace before resolving the template", async () => {
  const { store, calls } = fakeTemplates();
  const h = await openHarness({ templates: store, validateWorkspace: async () => false });

  const response = await request(h, "session.create", { templateId: "notes", workspace: MISSING });

  expect(response.error?.code).toBe("session.invalid_workspace");
  expect(calls).toEqual([]);
});

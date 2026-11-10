import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiscesError } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadTemplates, parseTemplate } from "../src/templates/schema.js";

const MAX_BYTES = 1_048_576;
const INVALID = "template.invalid";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-templates-schema-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function baseTemplate(): Record<string, unknown> {
  return {
    id: "notes",
    name: "Notes project",
    description: "Markdown notes with a scaffold script",
    directories: ["docs", "docs/archive"],
    files: [
      { path: "README.md", content: "# Notes\n" },
      { path: "docs/.gitkeep", content: "" },
    ],
    initScript: { command: "/usr/bin/git", args: ["init"], timeoutMs: 60_000 },
    config: {
      provider: "openai",
      model: "gpt-4o-mini",
      extensions: ["pkg#entry"],
      systemPromptFile: "README.md",
    },
  };
}

function overrides(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...baseTemplate(), ...patch };
}

function without(key: string): Record<string, unknown> {
  const value = baseTemplate();
  delete value[key];
  return value;
}

function invalidTemplate(value: unknown): PiscesError {
  try {
    parseTemplate("notes", JSON.stringify(value));
  } catch (error) {
    expect(error).toBeInstanceOf(PiscesError);
    const failure = error as PiscesError;
    expect(failure.code).toBe(INVALID);
    return failure;
  }
  throw new Error("expected the template to be rejected");
}

function validTemplate(value: unknown) {
  return parseTemplate("notes", JSON.stringify(value));
}

async function writeTemplate(name: string, value: unknown): Promise<void> {
  await writeFile(join(root, name), JSON.stringify(value), "utf8");
}

test("loads valid templates and isolates invalid ones", async () => {
  await writeTemplate("notes.json", baseTemplate());
  await writeFile(join(root, "bad.json"), "{", "utf8");
  const result = await loadTemplates(root);
  expect(result.templates.map((template) => template.info.id)).toEqual(["notes"]);
  expect(result.issues).toEqual([{ id: "bad", code: "template.invalid" }]);
});

test("keeps the declared template shape", () => {
  const loaded = validTemplate(baseTemplate());
  expect(loaded).toEqual({
    info: {
      id: "notes",
      name: "Notes project",
      description: "Markdown notes with a scaffold script",
    },
    directories: ["docs", "docs/archive"],
    files: [
      { path: "README.md", content: "# Notes\n" },
      { path: "docs/.gitkeep", content: "" },
    ],
    initScript: { command: "/usr/bin/git", args: ["init"], timeoutMs: 60_000 },
    config: {
      provider: "openai",
      model: "gpt-4o-mini",
      extensions: ["pkg#entry"],
      systemPromptFile: "README.md",
    },
  });
});

test("accepts a minimal template without optional sections", () => {
  const loaded = validTemplate({ id: "notes", name: "Notes" });
  expect(loaded).toEqual({ info: { id: "notes", name: "Notes" }, directories: [], files: [] });
});

test("sorts loaded templates by id", async () => {
  await writeTemplate("zeta.json", { id: "zeta", name: "Zeta" });
  await writeTemplate("alpha.json", { id: "alpha", name: "Alpha" });
  const result = await loadTemplates(root);
  expect(result.templates.map((template) => template.info.id)).toEqual(["alpha", "zeta"]);
});

test("ignores files that are not <id>.json", async () => {
  await writeFile(join(root, "notes.txt"), "not a template", "utf8");
  await writeTemplate("notes.json", { id: "notes", name: "Notes" });
  const result = await loadTemplates(root);
  expect(result.templates.map((template) => template.info.id)).toEqual(["notes"]);
  expect(result.issues).toEqual([]);
});

test("defaults the init script timeout to 60000", () => {
  const loaded = validTemplate(overrides({ initScript: { command: "/usr/bin/true", args: [] } }));
  expect(loaded.initScript).toEqual({ command: "/usr/bin/true", args: [], timeoutMs: 60_000 });
});

test("accepts the timeout bounds", () => {
  for (const timeoutMs of [1, 600_000]) {
    const loaded = validTemplate(
      overrides({ initScript: { command: "/usr/bin/true", args: [], timeoutMs } }),
    );
    expect(loaded.initScript?.timeoutMs).toBe(timeoutMs);
  }
});

test("accepts a template file of exactly 1 MiB", async () => {
  const raw = sizedTemplate(MAX_BYTES);
  await writeFile(join(root, "notes.json"), raw, "utf8");
  const result = await loadTemplates(root);
  expect(result.templates.map((template) => template.info.id)).toEqual(["notes"]);
  expect(result.issues).toEqual([]);
});

test("rejects a template file larger than 1 MiB", async () => {
  await writeFile(join(root, "notes.json"), sizedTemplate(MAX_BYTES + 1), "utf8");
  const result = await loadTemplates(root);
  expect(result.templates).toEqual([]);
  expect(result.issues).toEqual([{ id: "notes", code: "template.invalid" }]);
});

test("returns an empty result for a missing directory", async () => {
  await expect(loadTemplates(join(root, "missing"))).resolves.toEqual({
    templates: [],
    issues: [],
  });
});

test("records an unreadable template file as an issue", async () => {
  const path = join(root, "notes.json");
  await writeTemplate("notes.json", { id: "notes", name: "Notes" });
  await chmod(path, 0o000);
  const result = await loadTemplates(root);
  expect(result.templates).toEqual([]);
  expect(result.issues).toEqual([{ id: "notes", code: "template.invalid" }]);
});

test("skips adjacent directories named <id>.json", async () => {
  await mkdir(join(root, "notes.json"));
  const result = await loadTemplates(root);
  expect(result.templates).toEqual([]);
  expect(result.issues).toEqual([]);
});

test("rejects a non-object template", () => {
  invalidTemplate([]);
  invalidTemplate(null);
  invalidTemplate("notes");
});

test("rejects invalid template metadata", () => {
  invalidTemplate(overrides({ id: "other" }));
  invalidTemplate(without("name"));
  invalidTemplate(overrides({ name: "" }));
  invalidTemplate(overrides({ name: 1 }));
  invalidTemplate(without("id"));
  invalidTemplate(overrides({ description: 1 }));
});

test("rejects unknown keys", () => {
  invalidTemplate(overrides({ extra: true }));
  invalidTemplate(
    overrides({
      files: [{ path: "README.md", content: "", mode: 420 }],
      config: { provider: "openai" },
      initScript: undefined,
    }),
  );
  invalidTemplate(
    overrides({
      initScript: { command: "/usr/bin/true", args: [], cwd: "/tmp" },
      config: undefined,
    }),
  );
  invalidTemplate(overrides({ config: { provider: "openai", apiKey: "secret" } }));
});

test("rejects invalid template paths", () => {
  invalidTemplate(overrides({ directories: "/etc" }));
  invalidTemplate(overrides({ directories: ["docs/"] }));
  invalidTemplate(overrides({ directories: ["docs//archive"] }));
  invalidTemplate(overrides({ directories: ["./docs"] }));
  invalidTemplate(overrides({ directories: [".."] }));
  invalidTemplate(overrides({ directories: [""] }));
  invalidTemplate(overrides({ directories: [42] }));
  invalidTemplate(overrides({ directories: "docs" }));
  invalidTemplate(overrides({ files: [{ path: "../README.md", content: "" }] }));
  invalidTemplate(overrides({ files: [{ path: "docs\0README.md", content: "" }] }));
  invalidTemplate(overrides({ files: [{ path: "README.md", content: 1 }] }));
  invalidTemplate(overrides({ files: [{ content: "" }] }));
});

test("rejects duplicate and conflicting paths", () => {
  invalidTemplate(overrides({ directories: ["docs", "docs"] }));
  invalidTemplate(
    overrides({
      files: [
        { path: "README.md", content: "" },
        { path: "README.md", content: "" },
      ],
    }),
  );
  invalidTemplate(
    overrides({
      directories: ["docs"],
      files: [
        { path: "README.md", content: "" },
        { path: "docs", content: "" },
      ],
    }),
  );
  invalidTemplate(
    overrides({
      files: [
        { path: "docs", content: "" },
        { path: "docs/README.md", content: "" },
      ],
    }),
  );
  invalidTemplate(
    overrides({
      directories: ["docs/archive"],
      files: [
        { path: "docs", content: "" },
        { path: "docs/archive/.gitkeep", content: "" },
      ],
    }),
  );
});

test("rejects invalid init scripts", () => {
  invalidTemplate(overrides({ initScript: {} }));
  invalidTemplate(overrides({ initScript: { command: "git", args: [] } }));
  invalidTemplate(overrides({ initScript: { command: "/usr/bin/git", args: ["init", 1] } }));
  invalidTemplate(overrides({ initScript: { command: "/usr/bin/git", args: ["a\0b"] } }));
  invalidTemplate(overrides({ initScript: { command: "/usr/bin/git" } }));
  invalidTemplate(overrides({ initScript: { command: "/usr/bin/git", args: [], timeoutMs: 1.5 } }));
  invalidTemplate(overrides({ initScript: { command: "/usr/bin/git", args: [], timeoutMs: 0 } }));
  invalidTemplate(
    overrides({ initScript: { command: "/usr/bin/git", args: [], timeoutMs: 600_001 } }),
  );
  invalidTemplate(
    overrides({ initScript: { command: "/usr/bin/git", args: [], timeoutMs: "60000" } }),
  );
});

test("rejects invalid template config", () => {
  invalidTemplate(overrides({ config: { provider: "" } }));
  invalidTemplate(overrides({ config: { model: 1 } }));
  invalidTemplate(overrides({ config: { extensions: ["pkg-only"] } }));
  invalidTemplate(overrides({ config: { extensions: [1] } }));
  invalidTemplate(overrides({ config: { systemPromptFile: "AGENTS.md" } }));
  invalidTemplate(overrides({ config: { systemPromptFile: "/README.md" } }));
  invalidTemplate(
    overrides({
      files: [],
      config: { systemPromptFile: "README.md" },
      directories: [],
    }),
  );
});

function sizedTemplate(size: number): string {
  const template = baseTemplate();
  delete template.config;
  template.files = [{ path: "big.txt", content: "" }];
  const overhead = Buffer.byteLength(JSON.stringify(template));
  template.files = [{ path: "big.txt", content: "x".repeat(size - overhead) }];
  const raw = JSON.stringify(template);
  expect(Buffer.byteLength(raw)).toBe(size);
  return raw;
}

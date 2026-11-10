import { randomUUID } from "node:crypto";
import {
  type Exec,
  PiscesError,
  type TemplateInfo,
  type TemplatePreview,
  type WorkspaceAccess,
} from "@pisces/core";
import { appendProject } from "./projects.js";
import { type LoadedTemplate, loadTemplates, type TemplateIssue } from "./schema.js";

export type { TemplateIssue };

export interface TemplateDefaults {
  provider?: string;
  model?: string;
  extensions?: string[];
  systemPrompt?: string;
}

export interface TemplatePlan {
  preview: TemplatePreview;
  defaults: TemplateDefaults;
}

export interface TemplateResolution extends TemplatePlan {
  projectId: string;
}

export interface TemplateStoreOptions {
  configDir: string;
  dataDir: string;
  workspaceAccess: (workspace: string) => WorkspaceAccess;
  exec: Exec;
  now?: () => string;
  newProjectId?: () => string;
}

export interface TemplateStore {
  list(): Promise<TemplateInfo[]>;
  /** Loader diagnostics for templates rejected by validation, sorted by id. */
  issues(): Promise<TemplateIssue[]>;
  preview(templateId: string, workspace: string): Promise<TemplatePreview>;
  /**
   * Read-only preflight: preview plus config defaults, and never the prompt file. An
   * `apply` preflight must survive a prompt file the template is about to create.
   */
  inspect(templateId: string, workspace: string): Promise<TemplatePlan>;
  resolve(templateId: string, workspace: string): Promise<TemplatePlan>;
  apply(
    templateId: string,
    workspace: string,
    options: { confirmed: true; overwrite?: boolean },
  ): Promise<TemplateResolution>;
}

const NOT_FOUND = "Template not found";
const INVALID = "Invalid template";
const CONFLICT = "Workspace conflicts with the template";
const INIT_FAILED = "Template init script failed";
const CONFIRMATION = "Template apply requires confirmation";

const notFound = () => new PiscesError("template.not_found", NOT_FOUND);
const invalid = (cause?: unknown) => new PiscesError("template.invalid", INVALID, { cause });
const conflict = () => new PiscesError("template.workspace_conflict", CONFLICT);
const initFailed = (cause?: unknown) =>
  new PiscesError("template.init_failed", INIT_FAILED, { cause });

interface Prepared {
  template: LoadedTemplate;
  access: WorkspaceAccess;
  cwd: string;
  preview: TemplatePreview;
  defaults: TemplateDefaults;
}

function resolvePath(access: WorkspaceAccess, path: string): string {
  try {
    return access.resolve(path);
  } catch (error) {
    if (error instanceof PiscesError && error.code === "workspace.path_outside") throw invalid();
    throw error;
  }
}

function defaultsFrom(template: LoadedTemplate): TemplateDefaults {
  const defaults: TemplateDefaults = {};
  const config = template.config;
  if (!config) return defaults;
  if (config.provider !== undefined) defaults.provider = config.provider;
  if (config.model !== undefined) defaults.model = config.model;
  if (config.extensions !== undefined) defaults.extensions = [...config.extensions];
  return defaults;
}

async function promptFile(
  access: WorkspaceAccess,
  template: LoadedTemplate,
): Promise<string | undefined> {
  const path = template.config?.systemPromptFile;
  if (path === undefined) return undefined;
  try {
    return await access.readFile(path);
  } catch (error) {
    throw invalid(error);
  }
}

export function createTemplateStore(options: TemplateStoreOptions): TemplateStore {
  const { configDir, dataDir, workspaceAccess, exec } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newProjectId = options.newProjectId ?? (() => randomUUID());

  async function prepare(
    templateId: string,
    workspace: string,
    readPrompt: boolean,
  ): Promise<Prepared> {
    const { templates, issues } = await loadTemplates(configDir);
    const template = templates.find((entry) => entry.info.id === templateId);
    if (!template) {
      // A template that failed validation is invalid, not missing; diagnostics stay reachable
      // through `issues()` and never carry file paths or contents.
      if (issues.some((entry) => entry.id === templateId)) throw invalid();
      throw notFound();
    }
    const access = workspaceAccess(workspace);
    const cwd = resolvePath(access, ".");
    for (const directory of template.directories) resolvePath(access, directory);
    const conflicts: string[] = [];
    for (const file of template.files) {
      resolvePath(access, file.path);
      if (await access.exists(file.path)) conflicts.push(file.path);
    }
    const preview: TemplatePreview = {
      directories: [...template.directories],
      files: template.files.map((file) => ({ path: file.path, content: file.content })),
      conflicts,
    };
    if (template.initScript) {
      preview.initScript = {
        command: template.initScript.command,
        args: [...template.initScript.args],
        timeoutMs: template.initScript.timeoutMs,
      };
    }
    const defaults = defaultsFrom(template);
    if (readPrompt) {
      const prompt = await promptFile(access, template);
      if (prompt !== undefined) defaults.systemPrompt = prompt;
    }
    return { template, access, cwd, preview, defaults };
  }

  async function apply(
    templateId: string,
    workspace: string,
    applyOptions: { confirmed: true; overwrite?: boolean },
  ): Promise<TemplateResolution> {
    if (applyOptions.confirmed !== true) {
      throw new PiscesError("protocol.invalid_request", CONFIRMATION);
    }
    const prepared = await prepare(templateId, workspace, false);
    const { template, access, cwd, preview, defaults } = prepared;
    if (!(await access.exists("."))) {
      throw new PiscesError("session.invalid_workspace", "Workspace does not exist");
    }
    if (preview.conflicts.length > 0 && applyOptions.overwrite !== true) throw conflict();
    const projectId = newProjectId();
    for (const directory of template.directories) await access.ensureDirectory(directory);
    for (const file of template.files) await access.writeFile(file.path, file.content);
    if (template.initScript) {
      let result: Awaited<ReturnType<Exec["run"]>>;
      try {
        result = await exec.run(template.initScript.command, template.initScript.args, {
          cwd,
          timeoutMs: template.initScript.timeoutMs,
        });
      } catch (error) {
        throw initFailed(error);
      }
      if (result.exitCode !== 0 || result.timedOut === true) throw initFailed();
    }
    const prompt = await promptFile(access, template);
    if (prompt !== undefined) defaults.systemPrompt = prompt;
    await appendProject(dataDir, { id: projectId, templateId, workspace, createdAt: now() });
    return { projectId, preview, defaults };
  }

  return {
    async list() {
      const { templates } = await loadTemplates(configDir);
      return templates.map((template) => template.info);
    },
    async issues() {
      const { issues } = await loadTemplates(configDir);
      return issues.map((entry) => ({ ...entry }));
    },
    async preview(templateId, workspace) {
      return (await prepare(templateId, workspace, false)).preview;
    },
    async inspect(templateId, workspace) {
      const { preview, defaults } = await prepare(templateId, workspace, false);
      return { preview, defaults };
    },
    async resolve(templateId, workspace) {
      const { preview, defaults } = await prepare(templateId, workspace, true);
      return { preview, defaults };
    },
    apply,
  };
}

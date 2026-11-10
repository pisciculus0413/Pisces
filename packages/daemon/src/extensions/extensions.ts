import { realpath } from "node:fs/promises";
import {
  type ContextSource,
  type ContextSourceRegistry,
  createTools,
  type DefinitionSnapshot,
  type EntryName,
  type JsonObject,
  type JsonValue,
  PiscesError,
  type SkillEntry,
  type Skills,
  type ToolDeclaration,
  type ToolFunction,
  type Tools,
  type ToolWrapper,
} from "@pisces/core";
import { readConfigLayer, readWorkspaceConfig, resolveConfigLocation } from "./config.js";
import { discoverExtensions } from "./discovery.js";
import { canonicalJson } from "./hash.js";
import { createExtensionLoader, ExtensionLoadError, type ExtensionLoader } from "./loader.js";
import { deepFreeze } from "./metadata.js";
import type {
  DiscoveredEntry,
  DiscoveryResult,
  ExtensionBinding,
  ExtensionConfig,
  Extensions,
  ExtensionsOptions,
} from "./types.js";

// Module exports are compatibility evidence only: the confirmed config always wins.
function configMatches(exported: unknown, frozen: JsonObject): boolean {
  try {
    const copy = structuredClone(exported) as JsonValue;
    return canonicalJson(copy) === canonicalJson(frozen);
  } catch {
    return false;
  }
}

function toolExecute(loader: ExtensionLoader, record: DiscoveredEntry): ToolFunction {
  return async (args, context) => {
    const module = await loader.load(record);
    const execute = module.default as ToolFunction;
    return execute(args, context);
  };
}

// The factory promise is cached by Tools per binding; this closure only runs once.
// Module `config` must describe the sidecar defaults, never hidden or merged values.
function wrapperFactory(
  loader: ExtensionLoader,
  record: DiscoveredEntry,
  config: JsonObject,
  defaults: JsonObject,
): () => Promise<ToolWrapper> {
  return async () => {
    const module = await loader.load(record);
    if (module.config !== undefined && !configMatches(module.config, defaults)) {
      throw new ExtensionLoadError("Extension wrapper config does not match the declared defaults");
    }
    const create = module.default as (config: JsonObject) => ToolWrapper | Promise<ToolWrapper>;
    const wrapper = await create(structuredClone(config));
    if (typeof wrapper !== "function") {
      throw new ExtensionLoadError("Extension wrapper factory did not return a function");
    }
    return wrapper;
  };
}

function contextSource(loader: ExtensionLoader, record: DiscoveredEntry): ContextSource {
  return {
    id: record.info.name,
    async resolve(context) {
      const module = await loader.load(record);
      const resolve = module.default as ContextSource["resolve"];
      return resolve(context);
    },
  };
}

function createBinding(
  workspace: string,
  config: ExtensionConfig,
  discovery: DiscoveryResult,
): ExtensionBinding {
  const { inventory, records, issues } = discovery;
  // A fresh loader and registry per binding: no shared promise, module or config identity.
  const loader = createExtensionLoader();
  const registry = createTools();

  const sources = new Map<EntryName, ContextSource>();
  const skillEntries = new Map<EntryName, SkillEntry>();

  for (const record of records.values()) {
    const info = record.info;
    if (info.type === "tool") {
      const declaration: ToolDeclaration = {
        id: info.name,
        source: info.source,
        name: info.name,
        description: info.description ?? "",
        parameters: structuredClone(info.definition?.parameters ?? {}),
        execute: toolExecute(loader, record),
      };
      registry.registerTool(declaration);
    } else if (info.type === "wrapper") {
      registry.registerWrapper(
        info.name,
        wrapperFactory(
          loader,
          record,
          record.wrapperConfig ?? {},
          record.wrapperConfigSpec?.defaults ?? {},
        ),
      );
    } else if (info.type === "context") {
      sources.set(info.name, contextSource(loader, record));
    } else if (info.type === "skill" && record.skillContent !== undefined) {
      skillEntries.set(info.name, {
        name: info.name,
        source: info.source,
        content: structuredClone(record.skillContent),
      });
    }
  }

  const tools: Tools = registry.forInventory(inventory);

  const entries = {
    kind(name: EntryName) {
      return records.get(name)?.info.type;
    },
    // Pure comparison with this binding's frozen inventory; never reads disk or modules.
    matchesDefinition(definition: DefinitionSnapshot): boolean {
      const frozen = records.get(definition.name)?.info.definition;
      if (frozen === undefined) return false;
      return (
        frozen.name === definition.name &&
        frozen.kind === definition.kind &&
        frozen.definitionHash === definition.definitionHash &&
        frozen.configHash === definition.configHash
      );
    },
  };

  const skills: Skills = {
    selected(selection) {
      const selected: SkillEntry[] = [];
      for (const name of [...new Set(selection)].sort()) {
        const entry = skillEntries.get(name);
        if (entry !== undefined) {
          selected.push({ ...entry, content: structuredClone(entry.content) });
        }
      }
      return selected;
    },
  };

  const sourceRegistry: ContextSourceRegistry = {
    get(name: EntryName): ContextSource | undefined {
      const source = sources.get(name);
      // Frozen copy: callers cannot overwrite id/resolve or mutate the internal registry.
      return source === undefined
        ? undefined
        : Object.freeze({ id: source.id, resolve: source.resolve });
    },
  };

  return {
    workspace,
    config,
    inventory,
    issues,
    entries,
    skills,
    sources: sourceRegistry,
    tools,
  };
}

export function createExtensions(options: ExtensionsOptions): Extensions {
  // Resolve once, without reading the file or scanning directories: construction only locks in
  // which global file `readGlobalConfig`/`prepare` will read and which root discovery will scan.
  const location = resolveConfigLocation(options);
  return {
    readGlobalConfig: () => readConfigLayer(location.configPath, "global"),
    async prepare(workspace: string): Promise<ExtensionBinding> {
      // realpath identifies the workspace; an inaccessible path fails with the module's
      // existing safe configuration error instead of falling back or leaking Node details.
      let canonical: string;
      try {
        canonical = await realpath(workspace);
      } catch {
        throw new PiscesError("config.invalid", "Invalid extension configuration");
      }
      const config = deepFreeze(
        await readWorkspaceConfig(location.configDir, canonical, location.configPath),
      );
      // Every prepare rescans and freezes a new inventory without importing module code.
      const discovery = await discoverExtensions(options, canonical, config);
      return createBinding(canonical, config, discovery);
    },
  };
}

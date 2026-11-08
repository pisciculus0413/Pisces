import type { EntryName, SelectionState, ToolCall, ToolResult } from "../messages.js";
import type { JsonObject, JsonValue } from "../types.js";
import { PiscesError } from "../types.js";
import type {
  EntryInfo,
  ToolDeclaration,
  ToolInventory,
  ToolInvocationContext,
  Tools,
  ToolsOptions,
  ToolWrapper,
} from "./types.js";
import { ToolDeniedError } from "./types.js";
import { encodeWireName as defaultEncodeWireName } from "./wire-name.js";

function cloneDeclaration(declaration: ToolDeclaration): ToolDeclaration {
  return {
    id: declaration.id,
    source: declaration.source,
    name: declaration.name,
    description: declaration.description,
    parameters: structuredClone(declaration.parameters),
    ...(declaration.execute === undefined ? {} : { execute: declaration.execute }),
  };
}

function failure(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, code };
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEqual(value, right[index] as JsonValue));
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => jsonEqual(left[key] as JsonValue, right[key] as JsonValue))
  );
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) valid = false;
    for (let index = 0; valid && index < value.length; index++) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) valid = false;
    }
  } else {
    for (const item of Object.values(value)) {
      if (!isJsonValue(item, ancestors)) {
        valid = false;
        break;
      }
    }
  }
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function isToolDeclaration(value: unknown): value is ToolDeclaration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const declaration = value as Partial<ToolDeclaration>;
  return (
    typeof declaration.id === "string" &&
    typeof declaration.source === "string" &&
    typeof declaration.name === "string" &&
    typeof declaration.description === "string" &&
    declaration.parameters !== null &&
    typeof declaration.parameters === "object" &&
    !Array.isArray(declaration.parameters) &&
    (declaration.execute === undefined || typeof declaration.execute === "function")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface InventoryBinding {
  hash: string;
  types: ReadonlyMap<EntryName, EntryInfo["type"]>;
}

export function createTools(options: ToolsOptions = {}): Tools {
  const encode = options.encodeWireName ?? defaultEncodeWireName;
  const declarations = new Map<EntryName, ToolDeclaration>();
  const wrappers = new Map<EntryName, () => ToolWrapper>();
  const wrapperPromises = new Map<EntryName, Promise<ToolWrapper>>();
  const wireOwners = new Map<string, EntryName>();
  const unavailable = new Set<EntryName>();

  function registerWireName(name: EntryName): void {
    const wireName = encode(name);
    const owner = wireOwners.get(wireName);
    if (owner === undefined) {
      wireOwners.set(wireName, name);
      return;
    }
    if (owner === name) return;

    unavailable.add(owner);
    unavailable.add(name);
    throw new PiscesError("tools.wire_name_conflict", "Tool wire name conflict", {
      data: { wireName, names: [owner, name].sort() },
    });
  }

  function makeFacade(binding?: InventoryBinding): Tools {
    function isTool(name: EntryName): boolean {
      return binding === undefined || binding.types.get(name) === "tool";
    }

    function isWrapper(name: EntryName): boolean {
      return binding === undefined ? wrappers.has(name) : binding.types.get(name) === "wrapper";
    }

    function loadWrapper(name: EntryName): Promise<ToolWrapper> {
      const cached = wrapperPromises.get(name);
      if (cached !== undefined) return cached;
      const factory = wrappers.get(name);
      const promise =
        factory === undefined
          ? Promise.reject(new Error(`Wrapper is not registered: ${name}`))
          : Promise.resolve().then(factory);
      wrapperPromises.set(name, promise);
      return promise;
    }

    function wrapperFailure(name: EntryName): ToolResult {
      return failure("tool.wrapper_invalid", `Invalid tool wrapper: ${name}`);
    }

    function selected(selection: SelectionState): ToolDeclaration[] {
      const names = new Set(selection);
      return [...names]
        .filter((name) => !unavailable.has(name) && isTool(name) && declarations.has(name))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((name) => cloneDeclaration(declarations.get(name) as ToolDeclaration));
    }

    async function invoke(
      call: ToolCall,
      selection: SelectionState,
      context: ToolInvocationContext,
    ): Promise<ToolResult> {
      const args = structuredClone(call.arguments);
      const invocationContext: ToolInvocationContext = {
        sessionId: context.sessionId,
        workspace: context.workspace,
        signal: context.signal,
      };
      const selectedTool = selected(selection).find(
        (declaration) => declaration.name === call.name,
      );
      if (selectedTool === undefined)
        return failure("tool.failed", `Tool is not selected: ${call.name}`);

      const baseline = {
        id: selectedTool.id,
        source: selectedTool.source,
        name: selectedTool.name,
        description: selectedTool.description,
        parameters: structuredClone(selectedTool.parameters),
      };
      const wrapperNames = [...new Set(selection)]
        .filter((name) => !unavailable.has(name) && isWrapper(name))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      let wrapped = selectedTool;
      for (const wrapperName of wrapperNames) {
        let wrapper: ToolWrapper;
        try {
          wrapper = await loadWrapper(wrapperName);
        } catch {
          return wrapperFailure(wrapperName);
        }
        try {
          const candidate = wrapper(wrapped);
          if (
            !isToolDeclaration(candidate) ||
            !isJsonObject(candidate.parameters) ||
            candidate.id !== baseline.id ||
            candidate.source !== baseline.source ||
            candidate.name !== baseline.name ||
            candidate.description !== baseline.description ||
            !jsonEqual(candidate.parameters, baseline.parameters)
          )
            return wrapperFailure(wrapperName);
          wrapped = candidate;
        } catch {
          return wrapperFailure(wrapperName);
        }
      }

      if (wrapped.execute === undefined)
        return failure("tool.failed", `Tool has no execute function: ${call.name}`);
      try {
        return structuredClone(await wrapped.execute(args, invocationContext));
      } catch (error) {
        if (error instanceof ToolDeniedError) return failure("tool.denied", messageOf(error));
        return failure("tool.failed", "Tool execution failed");
      }
    }

    return {
      forInventory(inventory: ToolInventory): Tools {
        return makeFacade({
          hash: inventory.hash,
          types: new Map(inventory.entries.map((entry) => [entry.name, entry.type])),
        });
      },
      registerTool(declaration: ToolDeclaration): void {
        registerWireName(declaration.name);
        declarations.set(declaration.name, cloneDeclaration(declaration));
      },
      registerWrapper(name: EntryName, factory: () => ToolWrapper): void {
        registerWireName(name);
        wrapperPromises.delete(name);
        wrappers.set(name, factory);
      },
      selected,
      invoke,
    };
  }

  return makeFacade();
}

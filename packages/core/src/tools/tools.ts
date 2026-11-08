import type { EntryName, SelectionState, ToolCall, ToolResult } from "../messages.js";
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

interface InventoryBinding {
  hash: string;
  types: ReadonlyMap<EntryName, EntryInfo["type"]>;
}

export function createTools(options: ToolsOptions = {}): Tools {
  const encode = options.encodeWireName ?? defaultEncodeWireName;
  const declarations = new Map<EntryName, ToolDeclaration>();
  const wrappers = new Map<EntryName, () => ToolWrapper>();
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
      const selectedTool = selected(selection).find(
        (declaration) => declaration.name === call.name,
      );
      if (selectedTool === undefined)
        return failure("tool.failed", `Tool is not selected: ${call.name}`);
      if (selectedTool.execute === undefined)
        return failure("tool.failed", `Tool has no execute function: ${call.name}`);
      return selectedTool.execute(call.arguments, context);
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
        wrappers.set(name, factory);
      },
      selected,
      invoke,
    };
  }

  return makeFacade();
}

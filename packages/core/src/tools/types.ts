import type {
  DefinitionSnapshot,
  EntryName,
  SelectionState,
  ToolCall,
  ToolResult,
} from "../messages.js";
import type { SessionId } from "../sessions/types.js";
import type { JsonObject, JsonValue } from "../types.js";

export type JsonSchema = JsonObject;

export interface EntryInfo {
  type: "tool" | "wrapper" | "skill" | "context";
  source: string;
  name: EntryName;
  description?: string;
  definition?: DefinitionSnapshot;
  definitionHash?: string;
}

/** Per-entry eligibility from replayed definitions; never fabricates kind evidence. */
export interface EffectiveEntry {
  name: EntryName;
  definitionHash?: string;
  configHash?: string;
  stale: boolean;
}

export interface ToolDeclaration {
  readonly id: string;
  readonly source: string;
  readonly name: EntryName;
  readonly description: string;
  readonly parameters: JsonSchema;
  execute?: ToolFunction;
}

export interface ToolInvocationContext {
  sessionId: SessionId;
  workspace: string;
  signal: AbortSignal;
}

export type ToolFunction = (args: JsonValue, context: ToolInvocationContext) => Promise<ToolResult>;

export type ToolWrapper = (wrapped: ToolDeclaration) => ToolDeclaration;

export interface ToolInventory {
  hash: string;
  entries: EntryInfo[];
}

export interface Tools {
  forInventory(inventory: ToolInventory): Tools;
  registerTool(declaration: ToolDeclaration): void;
  registerWrapper(name: EntryName, factory: () => ToolWrapper | Promise<ToolWrapper>): void;
  selected(selection: SelectionState): ToolDeclaration[];
  invoke(
    call: ToolCall,
    selection: SelectionState,
    context: ToolInvocationContext,
  ): Promise<ToolResult>;
}

export interface ToolsOptions {
  encodeWireName?: (name: EntryName) => string;
}

export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolDeniedError";
  }
}

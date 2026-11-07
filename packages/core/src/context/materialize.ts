import type { DefinitionSnapshot, EntryName } from "../messages.js";
import type { SessionNodeDraft } from "../sessions/types.js";
import { PiscesError } from "../types.js";
import { sourceContent } from "./content.js";
import { validDefinition } from "./declarations.js";
import type {
  ContextEntries,
  ContextSourceContext,
  ContextSourceRegistry,
  QueueEntry,
  RequestToolDeclaration,
  SelectionState,
  Skills,
} from "./types.js";

interface MaterializeInput {
  branch: readonly SessionNodeDraft[];
  queue: readonly QueueEntry[];
  selection: SelectionState;
  definitions: ReadonlyMap<EntryName, DefinitionSnapshot>;
  entries: ContextEntries;
  sources: ContextSourceRegistry;
  skills: Skills;
  sourceContext: ContextSourceContext;
}

export async function materialize({
  branch,
  queue,
  selection,
  definitions,
  entries,
  sources,
  skills,
  sourceContext,
}: MaterializeInput): Promise<{ drafts: SessionNodeDraft[]; tools: RequestToolDeclaration[] }> {
  sourceContext.signal?.throwIfAborted();
  const drafts: SessionNodeDraft[] = [];
  const tools: RequestToolDeclaration[] = [];
  const contexts: EntryName[] = [];
  const selectedSkills: EntryName[] = [];
  const existing = new Set(
    branch.filter((node) => node.kind === "agent").map((node) => node.source),
  );
  for (const name of [...new Set(selection)].sort()) {
    const kind = entries.kind(name);
    if (kind === "context") {
      if (!existing.has(name)) contexts.push(name);
    } else if (kind === "skill") {
      if (!existing.has(name)) selectedSkills.push(name);
    } else if (kind === "tool" || kind === "wrapper") {
      const definition = definitions.get(name);
      if (!validDefinition(definition) || definition.name !== name || definition.kind !== kind)
        throw new PiscesError("storage.corrupt", "Missing or invalid frozen definition", {
          data: { name },
        });
      if (kind === "tool")
        tools.push({
          name,
          description: definition.description,
          parameters: structuredClone(definition.parameters),
        });
    } else throw new PiscesError("storage.corrupt", "Unknown selected entry", { data: { name } });
  }
  function append(name: EntryName, content: SessionNodeDraft["content"]) {
    drafts.push({ kind: "agent", role: "system", source: name, content: sourceContent(content) });
  }
  function failed(name: EntryName, cause: unknown): never {
    sourceContext.signal?.throwIfAborted();
    throw new PiscesError("context.source_failed", "Could not materialize selected entry", {
      data: { name },
      cause,
    });
  }
  for (const name of contexts) {
    try {
      const source = sources.get(name);
      if (!source) throw new TypeError("Selected context source is missing");
      const fragments = await source.resolve(sourceContext);
      sourceContext.signal?.throwIfAborted();
      if (!Array.isArray(fragments)) throw new TypeError("Invalid context fragments");
      for (const fragment of fragments) append(name, fragment.content);
    } catch (cause) {
      failed(name, cause);
    }
  }
  if (selectedSkills.length) {
    let selected: ReturnType<Skills["selected"]>;
    try {
      selected = skills.selected([...selectedSkills]);
    } catch (cause) {
      failed(selectedSkills[0] as EntryName, cause);
    }
    for (const name of selectedSkills) {
      try {
        const skill = selected.find((skill) => skill.name === name);
        if (!skill) throw new TypeError("Selected skill is missing");
        append(name, skill.content);
      } catch (cause) {
        failed(name, cause);
      }
    }
  }
  for (const entry of queue)
    drafts.push({
      kind: entry.kind,
      role: entry.role,
      source: entry.source,
      content: structuredClone(entry.content),
    });
  return { drafts, tools };
}

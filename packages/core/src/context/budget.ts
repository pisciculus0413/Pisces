import type { ContentBlock, Message } from "../messages.js";
import type { SessionNode, SessionNodeDraft } from "../sessions/types.js";
import { PiscesError } from "../types.js";
import { isEntryName } from "./declarations.js";
import type { RequestToolDeclaration, SelectionState } from "./types.js";

interface BudgetInput {
  branch: readonly SessionNode[];
  drafts: readonly SessionNodeDraft[];
  selection: SelectionState;
  tools: readonly RequestToolDeclaration[];
  contextWindow: number;
  maxOutput: number;
}

interface Range {
  start: number;
  end: number;
}
interface ToolGroup extends Range {
  open: boolean;
}
interface Unit {
  start: number;
  indices: number[];
  messages: Message[];
  protected: boolean;
  removed: boolean;
}
interface Summary extends Range {
  message: Message;
}
interface Candidate extends Summary {
  draft: SessionNodeDraft;
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(value)).length / 3);
}

function contentText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text" || block.type === "reasoning") return block.text;
      if (block.type === "toolCall") return `${block.name} ${JSON.stringify(block.arguments)}`;
      return contentText(block.content);
    })
    .join("\n");
}

export function summarize(nodes: readonly SessionNode[]): string {
  const lines = nodes.map(
    (node) => `${node.role}: ${Array.from(contentText(node.content)).slice(0, 200).join("")}`,
  );
  return Array.from(`[compaction]\n${lines.join("\n")}`)
    .slice(0, 2048)
    .join("");
}

const instruction = (node: SessionNodeDraft): boolean =>
  node.kind === "agent" && node.role === "system" && node.source === "instruction";
const intersects = (a: Range, b: Range): boolean => a.start <= b.end && b.start <= a.end;
const contains = (range: Range, index: number): boolean =>
  range.start <= index && index <= range.end;
const summaryMessage = (summary: string): Message => ({
  role: "system",
  content: [{ type: "text", text: summary }],
});

/** Pair the complete stream before applying compactions so summaries cannot hide corrupt history. */
function toolGroups(
  nodes: readonly SessionNodeDraft[],
  visible: (node: SessionNodeDraft, index: number) => boolean = () => true,
): ToolGroup[] {
  const calls = new Map<string, { start: number; result?: number }>();
  const intervals: ToolGroup[] = [];
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== "agent" || !visible(node, index)) continue;
    for (const block of node.content) {
      if (node.role === "assistant" && block.type === "toolCall") {
        if (calls.has(block.id)) throw new PiscesError("storage.corrupt", "Duplicate tool call id");
        calls.set(block.id, { start: index });
      } else if (block.type === "toolResult") {
        const call = calls.get(block.toolCallId);
        if (!call || call.result !== undefined)
          throw new PiscesError("storage.corrupt", "Orphan or duplicate tool result");
        call.result = index;
      }
    }
  }
  for (const call of calls.values())
    intervals.push({
      start: call.start,
      end: call.result ?? nodes.length - 1,
      open: call.result === undefined,
    });
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: ToolGroup[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && intersects(previous, interval)) {
      previous.end = Math.max(previous.end, interval.end);
      previous.open ||= interval.open;
    } else merged.push({ ...interval });
  }
  return merged;
}

function coversToolGroups(range: Range, groups: readonly ToolGroup[]): boolean {
  return groups.every(
    (group) =>
      !intersects(range, group) ||
      (!group.open && range.start <= group.start && range.end >= group.end),
  );
}

function existingSummaries(
  branch: readonly SessionNode[],
  groups: readonly ToolGroup[],
): Summary[] {
  const indices = new Map(branch.map((node, index) => [node.id, index]));
  const accepted: Summary[] = [];
  for (const node of branch) {
    if (node.kind !== "control" || node.role !== "compaction") continue;
    if (node.content.length !== 1 || node.content[0]?.type !== "text") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(node.content[0].text);
    } catch {
      continue;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    const { from, to, summary } = payload as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || typeof summary !== "string") continue;
    const start = indices.get(from as SessionNode["id"]);
    const end = indices.get(to as SessionNode["id"]);
    if (start === undefined || end === undefined || start > end) continue;
    const range = { start, end };
    if (
      accepted.some((other) => intersects(range, other)) ||
      branch.slice(start, end + 1).some(instruction) ||
      !coversToolGroups(range, groups)
    )
      continue;
    accepted.push({ ...range, message: summaryMessage(summary) });
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function projectUnits(
  nodes: readonly SessionNodeDraft[],
  groups: readonly ToolGroup[],
  summaries: readonly Summary[],
  visible: (node: SessionNodeDraft, index: number) => boolean,
): Unit[] {
  const items: { index: number; message: Message; original: boolean; instruction: boolean }[] =
    summaries.map((summary) => ({
      index: summary.start,
      message: summary.message,
      original: false,
      instruction: false,
    }));
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== "agent" || !visible(node, index)) continue;
    if (
      node.role !== "system" &&
      node.role !== "user" &&
      node.role !== "assistant" &&
      node.role !== "tool"
    )
      continue;
    items.push({
      index,
      message: { role: node.role, content: node.content },
      original: true,
      instruction: instruction(node),
    });
  }
  const units: Unit[] = [];
  const grouped = new Map<number, Unit>();
  for (const item of items.sort((a, b) => a.index - b.index)) {
    const group = groups.find((group) => contains(group, item.index));
    const start = group?.start ?? item.index;
    let unit = grouped.get(start);
    if (!unit) {
      unit = { start, indices: [], messages: [], protected: group?.open ?? false, removed: false };
      grouped.set(start, unit);
      units.push(unit);
    }
    unit.protected ||= item.instruction;
    if (item.original) unit.indices.push(item.index);
    unit.messages.push(item.message);
  }
  return units.sort((a, b) => a.start - b.start);
}

function candidates(
  branch: readonly SessionNode[],
  removed: ReadonlySet<number>,
  groups: readonly ToolGroup[],
  budget: number,
): Candidate[] {
  const ranges: Range[] = [];
  for (const [index, node] of branch.entries()) {
    if (!removed.has(index) || node.kind !== "agent" || instruction(node)) continue;
    const previous = ranges.at(-1);
    if (previous && previous.end === index - 1) previous.end = index;
    else ranges.push({ start: index, end: index });
  }
  const result: Candidate[] = [];
  for (const range of ranges) {
    if (!coversToolGroups(range, groups)) continue;
    const nodes = branch.slice(range.start, range.end + 1);
    const tokens = nodes.reduce(
      (sum, node) => sum + estimateTokens({ role: node.role, content: node.content }),
      0,
    );
    if (nodes.length < 4 && tokens < Math.ceil(budget / 5)) continue;
    const summary = summarize(nodes);
    result.push({
      ...range,
      message: summaryMessage(summary),
      draft: {
        kind: "control",
        role: "compaction",
        source: "compaction",
        content: [
          {
            type: "text",
            text: JSON.stringify({ from: nodes[0]?.id, to: nodes.at(-1)?.id, summary }),
          },
        ],
      },
    });
  }
  return result;
}

export function budgetContext({
  branch,
  drafts,
  selection,
  tools,
  contextWindow,
  maxOutput,
}: BudgetInput): {
  messages: Message[];
  compactions: SessionNodeDraft[];
} {
  if (
    !Number.isInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isInteger(maxOutput) ||
    maxOutput < 0
  )
    throw new TypeError(
      "Context window and max output must be finite nonnegative integers; window must be positive",
    );
  const publicTools = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const reserve = publicTools.length ? estimateTokens(publicTools) : 0;
  const budget = Math.max(1024, contextWindow - maxOutput - reserve);
  const nodes = [...branch, ...drafts];
  const groups = toolGroups(nodes);
  const summaries = existingSummaries(branch, groups);
  const selected = new Set(selection);
  const visible = (node: SessionNodeDraft, index: number): boolean =>
    !summaries.some((summary) => contains(summary, index)) &&
    (!isEntryName(node.source) || selected.has(node.source));
  const projectedGroups = toolGroups(nodes, visible);
  const units = projectUnits(nodes, projectedGroups, summaries, visible);
  const removed = new Set<number>();
  const hiddenSummaries = new Set<number>();
  const cost = (messages: readonly Message[]) =>
    messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const remove = (unit: Unit) => {
    unit.removed = true;
    for (const index of unit.indices) removed.add(index);
  };
  const fail = (): never => {
    throw new PiscesError("context.window_exceeded", "Protected context exceeds model window");
  };

  // First trim the original stream. Summaries are derived only after this pass.
  let tokens = units.reduce((sum, unit) => sum + cost(unit.messages), 0);
  for (const unit of units) {
    if (tokens <= budget) break;
    if (unit.protected) continue;
    remove(unit);
    tokens -= cost(unit.messages);
  }
  if (tokens > budget) fail();

  // Every iteration removes a unit or hides a new summary. Hidden summaries stay
  // hidden if neighboring removed ranges merge, so no summary can be resurrected.
  while (true) {
    const compactions = candidates(branch, removed, groups, budget);
    const generated = compactions.filter(
      (candidate) => ![...hiddenSummaries].some((index) => contains(candidate, index)),
    );
    const active = units.filter((unit) => !unit.removed);
    const messages = [
      ...active.map((unit) => ({ start: unit.start, messages: unit.messages })),
      ...generated.map((candidate) => ({ start: candidate.start, messages: [candidate.message] })),
    ]
      .sort((a, b) => a.start - b.start)
      .flatMap((item) => item.messages);
    if (cost(messages) <= budget)
      return {
        messages: structuredClone(messages),
        compactions: compactions.map((candidate) => candidate.draft),
      };
    const unit = active.find((unit) => !unit.protected);
    const summary = generated[0];
    if (summary && (!unit || summary.start < unit.start)) hiddenSummaries.add(summary.start);
    else if (unit) remove(unit);
    else fail();
  }
}

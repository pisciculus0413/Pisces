import { createEventPublisher, type EngineEventPublisher } from "../events.js";
import type { ContentBlock, StopReason, Usage } from "../messages.js";
import type { SessionNodeDraft } from "../sessions/types.js";
import { PiscesError } from "../types.js";
import type {
  AgentLoopDriver,
  AgentLoopDriverOptions,
  LlmEvent,
  RunTurnInput,
  TurnResult,
} from "./types.js";

interface ActiveTurn {
  sessionId: RunTurnInput["sessionId"];
  turnId: RunTurnInput["turnId"];
  state: "running" | "cancelling" | "ended";
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof PiscesError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "provider.invalid_response", message: error.message };
  return { code: "provider.invalid_response", message: String(error) };
}

function appendDelta(blocks: ContentBlock[], type: "text" | "reasoning", delta: string): void {
  const previous = blocks.at(-1);
  if (previous?.type === type) previous.text += delta;
  else if (type === "text") blocks.push({ type: "text", text: delta });
  else blocks.push({ type: "reasoning", text: delta });
}

function validateEvents(value: unknown): LlmEvent[] {
  if (!Array.isArray(value))
    throw new PiscesError("provider.invalid_response", "Adapter returned invalid events");
  for (const event of value) {
    if (event === null || typeof event !== "object")
      throw new PiscesError("provider.invalid_response", "Adapter returned invalid event");
  }
  return value as LlmEvent[];
}

export function createAgentLoopDriver(options: AgentLoopDriverOptions): AgentLoopDriver {
  let active: ActiveTurn | undefined;

  function publisher(input: RunTurnInput): EngineEventPublisher {
    return createEventPublisher({
      sessionId: input.sessionId,
      events: input.events,
      eventClock: input.eventClock,
      now: options.now,
    });
  }

  async function end(
    input: RunTurnInput,
    events: EngineEventPublisher,
    reason: TurnResult["reason"],
    error?: { code: string; message: string },
  ): Promise<TurnResult> {
    await options.runExclusive(input.sessionId, async () => {
      if (active?.state !== undefined) active.state = "ended";
      events.publishTurn("turn.ended", {
        turnId: input.turnId,
        reason,
        endedAt: options.now(),
        ...(error ? { error } : {}),
      });
    });
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      reason,
      ...(error ? { error } : {}),
    };
  }

  return {
    async run(input) {
      const events = publisher(input);
      await options.runExclusive(input.sessionId, async () => {
        if (active) throw new PiscesError("turn.active", "A turn is already active");
        active = { sessionId: input.sessionId, turnId: input.turnId, state: "running" };
        events.publishTurn("turn.started", {
          turnId: input.turnId,
          startedAt: options.now(),
        });
      });

      let headId: RunTurnInput["nodeId"];
      try {
        const assembled = await input.context.assemble({
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
          contextWindow: input.contextWindow,
          maxOutput: input.maxOutput,
          signal: input.signal,
        });
        headId = assembled.headId;
        const wire = input.adapter.buildRequest(assembled.request);
        const blocks: ContentBlock[] = [];
        let usage: Usage | undefined;
        let stopReason: StopReason | undefined;

        for await (const chunk of input.execute(wire, input.signal)) {
          for (const event of validateEvents(input.adapter.parseChunk(chunk))) {
            if (event.type === "content" || event.type === "reasoning") {
              appendDelta(blocks, event.type === "content" ? "text" : "reasoning", event.delta);
              await options.runExclusive(input.sessionId, async () => {
                events.publishDelta(
                  input.turnId,
                  1,
                  event.type === "content" ? "text" : "reasoning",
                  event.delta,
                );
              });
            } else if (event.type === "usage") usage = structuredClone(event.usage);
            else if (event.type === "stop") stopReason = event.reason;
            else if (event.type === "error") throw new PiscesError(event.code, event.message);
            else if (event.type === "toolCall")
              throw new PiscesError(
                "provider.invalid_response",
                "Tool calls are not supported by this step",
              );
          }
        }
        if (stopReason === undefined)
          throw new PiscesError("provider.invalid_response", "Provider response has no stop");

        const nodes = await options.runExclusive(input.sessionId, async () => {
          const draft: SessionNodeDraft = {
            kind: "agent",
            role: "assistant",
            source: "assistant",
            content: blocks,
          };
          const appended = await input.sessions.append(input.sessionId, [draft], headId);
          headId = appended.at(-1)?.id;
          events.publishSession(appended);
          return appended;
        });
        if (!nodes.length)
          throw new PiscesError("storage.corrupt", "Assistant append produced no nodes");
        await options.runExclusive(input.sessionId, async () => {
          events.publishTurn("turn.step", {
            turnId: input.turnId,
            step: 1,
            stopReason,
            ...(usage ? { usage } : {}),
          });
        });
        return await end(input, events, "completed");
      } catch (error) {
        const errorData = failure(error);
        try {
          return await end(input, events, "failed", errorData);
        } catch {
          return {
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "failed",
            error: errorData,
          };
        }
      } finally {
        active = undefined;
      }
    },
    async cancel(_turnId) {
      return false;
    },
  };
}

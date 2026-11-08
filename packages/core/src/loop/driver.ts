import { createEventPublisher, type EngineEventPublisher } from "../events.js";
import type { ContentBlock, StopReason, Usage } from "../messages.js";
import type { NodeId, SessionNodeDraft } from "../sessions/types.js";
import { PiscesError } from "../types.js";
import { limitDriverContent } from "./content.js";
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
  context: RunTurnInput["context"];
  controller: AbortController;
  state: "running" | "cancelling" | "ended";
}

interface TurnProgress {
  headId: NodeId | undefined;
  blocks: ContentBlock[];
  step: number | undefined;
  stopReason: StopReason | undefined;
  usage: Usage | undefined;
  assistantPersisted: boolean;
  stepPublished: boolean;
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
      if (active) active.state = "ended";
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

  async function append(
    input: RunTurnInput,
    events: EngineEventPublisher,
    parentId: RunTurnInput["nodeId"],
    drafts: SessionNodeDraft[],
  ) {
    return options.runExclusive(input.sessionId, async () => {
      const nodes = await input.sessions.append(input.sessionId, drafts, parentId, {
        validate(nodes) {
          try {
            events.validateSessionNodes(nodes);
          } catch (error) {
            if (error instanceof PiscesError && error.code === "context.source_failed")
              throw new PiscesError(
                "provider.invalid_response",
                "Provider output exceeds node event budget",
                { cause: error },
              );
            throw error;
          }
        },
      });
      events.publishSession(nodes);
      return nodes;
    });
  }

  async function publishStep(
    input: RunTurnInput,
    events: EngineEventPublisher,
    step: number,
    stopReason: StopReason,
    usage?: Usage,
  ) {
    await options.runExclusive(input.sessionId, async () => {
      events.publishTurn("turn.step", {
        turnId: input.turnId,
        step,
        stopReason,
        ...(usage ? { usage } : {}),
      });
    });
  }

  async function clearConfirmations(input: RunTurnInput) {
    await options.runExclusive(input.sessionId, async () => {
      input.context.unconfirm();
    });
  }

  async function finishCancelled(
    input: RunTurnInput,
    events: EngineEventPublisher,
    progress: TurnProgress,
  ): Promise<TurnResult> {
    if (!progress.assistantPersisted && progress.blocks.length) {
      const assistant = await append(input, events, progress.headId, [
        {
          kind: "agent",
          role: "assistant",
          source: "assistant",
          content: limitDriverContent(progress.blocks),
        },
      ]);
      progress.headId = assistant.at(-1)?.id;
      progress.assistantPersisted = true;
    }
    await clearConfirmations(input);
    if (progress.headId) {
      const cancel = await append(input, events, progress.headId, [
        {
          kind: "control",
          role: "cancel",
          source: "driver",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                turnId: input.turnId,
                reason: "cancelled",
                at: progress.headId,
              }),
            },
          ],
        },
      ]);
      progress.headId = cancel.at(-1)?.id;
    }
    if (progress.step !== undefined && !progress.stepPublished) {
      await publishStep(input, events, progress.step, "cancelled", progress.usage);
      progress.stepPublished = true;
    }
    return end(input, events, "cancelled");
  }

  return {
    async run(input) {
      const events = publisher(input);
      const controller = new AbortController();
      const turn: ActiveTurn = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        context: input.context,
        controller,
        state: "running",
      };
      const forwardAbort = () => {
        if (active?.turnId !== input.turnId || active.state === "ended") return;
        active.state = "cancelling";
        controller.abort(input.signal.reason);
      };
      const progress: TurnProgress = {
        headId: undefined,
        blocks: [],
        step: undefined,
        stopReason: undefined,
        usage: undefined,
        assistantPersisted: false,
        stepPublished: false,
      };

      try {
        await options.runExclusive(input.sessionId, async () => {
          if (active) throw new PiscesError("turn.active", "A turn is already active");
          active = turn;
          events.publishTurn("turn.started", {
            turnId: input.turnId,
            startedAt: options.now(),
          });
        });
        input.signal.addEventListener("abort", forwardAbort, { once: true });
        if (input.signal.aborted) forwardAbort();
        if (controller.signal.aborted) return await finishCancelled(input, events, progress);

        for (let step = 1; ; step++) {
          progress.blocks = [];
          progress.step = undefined;
          progress.stopReason = undefined;
          progress.usage = undefined;
          progress.assistantPersisted = false;
          progress.stepPublished = false;

          const assembled = await input.context.assemble({
            ...(progress.headId ? { nodeId: progress.headId } : {}),
            contextWindow: input.contextWindow,
            maxOutput: input.maxOutput,
            signal: controller.signal,
          });
          progress.headId = assembled.headId;
          progress.step = step;
          if (controller.signal.aborted) return await finishCancelled(input, events, progress);

          const wire = input.adapter.buildRequest(assembled.request);
          for await (const chunk of input.execute(wire, controller.signal)) {
            for (const event of validateEvents(input.adapter.parseChunk(chunk))) {
              if (event.type === "content" || event.type === "reasoning") {
                if (typeof event.delta !== "string")
                  throw new PiscesError(
                    "provider.invalid_response",
                    "Provider returned an invalid text delta",
                  );
                if (!event.delta.length) continue;
                const kind = event.type === "content" ? "text" : "reasoning";
                appendDelta(progress.blocks, kind, event.delta);
                await options.runExclusive(input.sessionId, async () => {
                  events.publishDelta(input.turnId, step, kind, event.delta);
                });
              } else if (event.type === "usage") progress.usage = structuredClone(event.usage);
              else if (event.type === "stop") progress.stopReason = event.reason;
              else if (event.type === "error") throw new PiscesError(event.code, event.message);
              else {
                const block = { type: "toolCall", ...structuredClone(event.call) } as ContentBlock;
                progress.blocks.push(block);
              }
            }
          }
          if (controller.signal.aborted) return await finishCancelled(input, events, progress);
          if (progress.stopReason === undefined)
            throw new PiscesError("provider.invalid_response", "Provider response has no stop");

          const assistant = await append(input, events, progress.headId, [
            {
              kind: "agent",
              role: "assistant",
              source: "assistant",
              content: limitDriverContent(progress.blocks),
            },
          ]);
          progress.assistantPersisted = true;
          progress.headId = assistant.at(-1)?.id;
          const calls = progress.blocks.filter(
            (block): block is Extract<ContentBlock, { type: "toolCall" }> =>
              block.type === "toolCall",
          );

          if (calls.length) {
            const results = await Promise.all(
              calls.map((call) =>
                input.tools.invoke(call, assembled.selection, {
                  sessionId: input.sessionId,
                  workspace: input.meta.workspace,
                  signal: controller.signal,
                }),
              ),
            );
            const drafts: SessionNodeDraft[] = calls.map((call, index) => {
              const result = results[index];
              if (!result) throw new TypeError("Missing tool result");
              return {
                kind: "agent",
                role: "tool",
                source: "tool",
                content: [
                  {
                    type: "toolResult",
                    toolCallId: call.id,
                    content: limitDriverContent(result.content),
                    ...(result.isError === undefined ? {} : { isError: result.isError }),
                    ...(result.code === undefined ? {} : { code: result.code }),
                  },
                ],
              };
            });
            const toolNodes = await append(input, events, progress.headId, drafts);
            progress.headId = toolNodes.at(-1)?.id;
            if (controller.signal.aborted) return await finishCancelled(input, events, progress);
            await publishStep(input, events, step, progress.stopReason, progress.usage);
            progress.stepPublished = true;
            continue;
          }

          await publishStep(input, events, step, progress.stopReason, progress.usage);
          progress.stepPublished = true;
          if (controller.signal.aborted) return await finishCancelled(input, events, progress);

          const hasConfirmed = await options.runExclusive(input.sessionId, async () => {
            const queue = input.context.snapshot().queue;
            return queue[0]?.confirmedAt !== undefined;
          });
          if (controller.signal.aborted) return await finishCancelled(input, events, progress);
          if (!hasConfirmed) return await end(input, events, "completed");
        }
      } catch (error) {
        if (error instanceof PiscesError && error.code === "turn.active") throw error;
        if (active?.state === "cancelling" || controller.signal.aborted)
          return await finishCancelled(input, events, progress);
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
        input.signal.removeEventListener("abort", forwardAbort);
        if (active === turn) active = undefined;
      }
    },
    async cancel(turnId) {
      const turn = active;
      if (!turn || turn.turnId !== turnId || turn.state === "ended") return false;
      turn.state = "cancelling";
      turn.controller.abort(new DOMException("Turn cancelled", "AbortError"));
      await options.runExclusive(turn.sessionId, async () => {
        turn.context.unconfirm();
      });
      return true;
    },
  };
}

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
  WireRequest,
} from "./types.js";

interface ActiveTurn {
  sessionId: RunTurnInput["sessionId"];
  turnId: RunTurnInput["turnId"];
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
  return {
    code: "provider.invalid_response",
    message: "Provider response could not be processed",
  };
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
    if (event === null || typeof event !== "object" || Array.isArray(event))
      throw new PiscesError("provider.invalid_response", "Adapter returned invalid event");
    const candidate = event as Record<string, unknown>;
    if (candidate.type === "content" || candidate.type === "reasoning") {
      if (typeof candidate.delta !== "string")
        throw new PiscesError(
          "provider.invalid_response",
          "Provider returned an invalid text delta",
        );
    } else if (candidate.type === "toolCall") {
      const call = candidate.call as Record<string, unknown> | undefined;
      if (
        !call ||
        typeof call.id !== "string" ||
        !call.id ||
        typeof call.name !== "string" ||
        !call.name ||
        !("arguments" in call)
      )
        throw new PiscesError(
          "provider.invalid_response",
          "Provider returned an invalid tool call",
        );
    } else if (candidate.type === "usage") {
      const usage = candidate.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number")
        throw new PiscesError("provider.invalid_response", "Provider returned invalid usage");
    } else if (candidate.type === "stop") {
      if (
        !["stop", "toolCall", "length", "contentFilter", "cancelled", "error"].includes(
          candidate.reason as string,
        )
      )
        throw new PiscesError(
          "provider.invalid_response",
          "Provider returned an invalid stop reason",
        );
    } else if (candidate.type === "error") {
      if (typeof candidate.code !== "string" || typeof candidate.message !== "string")
        throw new PiscesError(
          "provider.invalid_response",
          "Provider returned an invalid error event",
        );
    } else {
      throw new PiscesError("provider.invalid_response", "Provider returned an unknown event");
    }
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

  async function finalizeFailure(
    input: RunTurnInput,
    events: EngineEventPublisher,
    cause: unknown,
  ): Promise<TurnResult> {
    const error = failure(cause);
    if (active?.state === "ended")
      return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        reason: "failed",
        error,
      };
    try {
      return await end(input, events, "failed", error);
    } catch (terminationError) {
      return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        reason: "failed",
        error: failure(terminationError),
      };
    }
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    return options.runExclusive(input.sessionId, async () => {
      if (signal?.aborted) return false;
      events.publishTurn("turn.step", {
        turnId: input.turnId,
        step,
        stopReason,
        ...(usage ? { usage } : {}),
      });
      return true;
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

  async function completeIfIdle(
    input: RunTurnInput,
    events: EngineEventPublisher,
    signal: AbortSignal,
  ): Promise<"confirmed" | "completed" | "cancelled"> {
    return options.runExclusive(input.sessionId, async () => {
      if (signal.aborted) return "cancelled";
      const queue = input.context.snapshot().queue;
      if (queue[0]?.confirmedAt !== undefined) return "confirmed";
      if (active) active.state = "ended";
      events.publishTurn("turn.ended", {
        turnId: input.turnId,
        reason: "completed",
        endedAt: options.now(),
      });
      return "completed";
    });
  }

  return {
    async run(input) {
      const events = publisher(input);
      const controller = new AbortController();
      const turn: ActiveTurn = {
        sessionId: input.sessionId,
        turnId: input.turnId,
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

          let wire: WireRequest;
          try {
            wire = input.adapter.buildRequest(assembled.request);
          } catch (error) {
            if (error instanceof PiscesError) throw error;
            throw new PiscesError(
              "provider.invalid_response",
              "Provider request could not be built",
              { cause: error },
            );
          }
          let iterator: AsyncIterator<string>;
          try {
            iterator = input.execute(wire, controller.signal)[Symbol.asyncIterator]();
          } catch (error) {
            if (error instanceof PiscesError) throw error;
            throw new PiscesError("provider.transport", "Provider transport failed", {
              cause: error,
            });
          }
          while (true) {
            let next: IteratorResult<string>;
            try {
              next = await iterator.next();
            } catch (error) {
              if (controller.signal.aborted || error instanceof PiscesError) throw error;
              throw new PiscesError("provider.transport", "Provider transport failed", {
                cause: error,
              });
            }
            if (next.done) break;
            let parsed: unknown;
            try {
              parsed = input.adapter.parseChunk(next.value);
            } catch (error) {
              if (error instanceof PiscesError) throw error;
              throw new PiscesError(
                "provider.invalid_response",
                "Provider response could not be parsed",
                { cause: error },
              );
            }
            for (const event of validateEvents(parsed)) {
              if (event.type === "content" || event.type === "reasoning") {
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

          const calls = progress.blocks.filter(
            (block): block is Extract<ContentBlock, { type: "toolCall" }> =>
              block.type === "toolCall",
          );
          if (new Set(calls.map((call) => call.id)).size !== calls.length)
            throw new PiscesError(
              "provider.invalid_response",
              "Provider returned duplicate tool call ids",
            );
          if (progress.stopReason === "toolCall" && !calls.length)
            throw new PiscesError(
              "provider.invalid_response",
              "Provider returned toolCall stop without calls",
            );
          if (progress.stopReason === "error")
            throw new PiscesError(
              "provider.invalid_response",
              "Provider returned error stop without an error event",
            );
          if (progress.stopReason === "cancelled")
            throw new PiscesError(
              "provider.invalid_response",
              "Provider returned cancelled stop without cancellation",
            );

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
          if (controller.signal.aborted) return await finishCancelled(input, events, progress);

          if (calls.length) {
            if (controller.signal.aborted) return await finishCancelled(input, events, progress);
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
            if (
              !(await publishStep(
                input,
                events,
                step,
                progress.stopReason,
                progress.usage,
                controller.signal,
              ))
            )
              return await finishCancelled(input, events, progress);
            progress.stepPublished = true;
            continue;
          }

          if (
            !(await publishStep(
              input,
              events,
              step,
              progress.stopReason,
              progress.usage,
              controller.signal,
            ))
          )
            return await finishCancelled(input, events, progress);
          progress.stepPublished = true;
          if (controller.signal.aborted) return await finishCancelled(input, events, progress);

          const completion = await completeIfIdle(input, events, controller.signal);
          if (controller.signal.aborted) return await finishCancelled(input, events, progress);
          if (completion === "completed")
            return {
              sessionId: input.sessionId,
              turnId: input.turnId,
              reason: "completed",
            };
          if (completion === "cancelled") return await finishCancelled(input, events, progress);
        }
      } catch (error) {
        if (error instanceof PiscesError && error.code === "turn.active") throw error;
        if (active?.state === "ended") return await finalizeFailure(input, events, error);
        if (active?.state === "cancelling" || controller.signal.aborted) {
          try {
            return await finishCancelled(input, events, progress);
          } catch (finalizationError) {
            return await finalizeFailure(input, events, finalizationError);
          }
        }
        return await finalizeFailure(input, events, error);
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
      return true;
    },
  };
}

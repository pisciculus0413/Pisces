import type { EngineEvent, EventBus, SessionId, SessionNode } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import { createEventBus } from "../src/runtime/event-bus.js";
import {
  createBootstrapRecoveryFixture,
  createGatewayHarness,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./support/gateway-harness.js";

const NOW = "2026-11-08T05:00:00.000Z";
const open: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function openHarness(options?: GatewayHarnessOptions): Promise<GatewayHarness> {
  const harness = await createGatewayHarness(options);
  open.push(harness);
  return harness;
}

async function collect(source: AsyncIterable<SessionNode>): Promise<SessionNode[]> {
  const nodes: SessionNode[] = [];
  for await (const node of source) nodes.push(node);
  return nodes;
}

interface RecordedSubscription {
  handler: (event: EngineEvent) => void;
  off: () => void;
  calls: number;
}

function recordingBus(): {
  bus: EventBus;
  subscriptions: RecordedSubscription[];
  deliveries: EngineEvent[];
} {
  const base = createEventBus();
  const subscriptions: RecordedSubscription[] = [];
  const deliveries: EngineEvent[] = [];
  return {
    bus: {
      subscribe(handler) {
        const entry: RecordedSubscription = { handler, off: () => undefined, calls: 0 };
        entry.off = base.subscribe((event) => {
          entry.calls += 1;
          handler(event);
        });
        subscriptions.push(entry);
        return entry.off;
      },
      publish(event) {
        deliveries.push(structuredClone(event));
        base.publish(event);
      },
    },
    subscriptions,
    deliveries,
  };
}

test("recovers the interrupted turn before the gateway is constructed", async () => {
  const { harness, sessionId } = await createBootstrapRecoveryFixture();
  open.push(harness);

  const branch = await collect(harness.store.readBranch(sessionId));

  expect(branch).toHaveLength(4);
  const synthetic = branch.at(-2);
  expect(synthetic).toMatchObject({
    kind: "agent",
    role: "tool",
    source: "recovery",
    content: [{ type: "toolResult", toolCallId: "call_1", synthetic: "interrupted" }],
  });
  const cancel = branch.at(-1);
  expect(cancel).toMatchObject({ kind: "control", role: "cancel" });
  const block = cancel?.content[0];
  if (block?.type !== "text") throw new Error("Expected a textual cancel payload");
  expect(JSON.parse(block.text)).toEqual({
    turnId: "t-recovered",
    reason: "daemon_restart",
    at: branch.at(-3)?.id,
  });
  expect(await harness.markers.read(sessionId)).toBeUndefined();
});

test("allocates a distinct EventBus handler per gateway and survives one off()", async () => {
  const recording = recordingBus();
  await openHarness({ bus: recording.bus });
  await openHarness({ bus: recording.bus });

  expect(recording.subscriptions).toHaveLength(2);
  const first = recording.subscriptions[0];
  const second = recording.subscriptions[1];
  if (!first || !second) throw new Error("Expected two gateway subscriptions");
  expect(first.handler).not.toBe(second.handler);

  first.off();

  const withSession: EngineEvent = {
    type: "turn.ended",
    sessionId: "unknown" as SessionId,
    at: NOW,
    data: { turnId: "unknown", reason: "completed" },
  };
  expect(() => recording.bus.publish(withSession)).not.toThrow();
  expect(first.calls).toBe(0);
  expect(second.calls).toBe(1);

  const withoutSession: EngineEvent = {
    type: "turn.ended",
    at: NOW,
    data: { turnId: "unknown", reason: "completed" },
  };
  expect(() => recording.bus.publish(withoutSession)).not.toThrow();
  expect(first.calls).toBe(0);
  expect(second.calls).toBe(2);
  expect(recording.deliveries).toEqual([withSession, withoutSession]);
});

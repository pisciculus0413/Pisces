import { PiscesError } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import type { ClientRegistry } from "../src/client-registry/registry.js";
import type { ClientRegistration } from "../src/extensions/types.js";
import {
  createGatewayHarness,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./support/gateway-harness.js";

const open: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

const REGISTRATION: ClientRegistration = {
  id: "repl",
  source: "@demo/x",
  entry: "/tmp/demo/client.mjs",
};

interface FakeRegistry extends ClientRegistry {
  started: string[];
}

function fakeRegistry(overrides: Partial<ClientRegistry> = {}): FakeRegistry {
  const started: string[] = [];
  return {
    started,
    list: async () => [REGISTRATION],
    start: async (id) => {
      started.push(id);
      return { pid: 4242 };
    },
    ...overrides,
  };
}

async function openHarness(options?: GatewayHarnessOptions): Promise<GatewayHarness> {
  const harness = await createGatewayHarness(options);
  open.push(harness);
  return harness;
}

test("projects registered clients", async () => {
  const h = await openHarness({ clients: fakeRegistry() });

  const response = await h.gateway.handle({ id: "1", method: "client.list", params: {} });

  expect(response).toEqual({ id: "1", result: { clients: [REGISTRATION] } });
});

test("starts a client by id", async () => {
  const registry = fakeRegistry();
  const h = await openHarness({ clients: registry });

  const response = await h.gateway.handle({
    id: "1",
    method: "client.start",
    params: { id: "repl" },
  });

  expect(response).toEqual({ id: "1", result: { pid: 4242 } });
  expect(registry.started).toEqual(["repl"]);
});

test("rejects invalid client.start parameters", async () => {
  const registry = fakeRegistry();
  const h = await openHarness({ clients: registry });

  for (const params of [{}, { id: 1 }, { id: "" }, { id: null }]) {
    const response = await h.gateway.handle({ id: "1", method: "client.start", params });
    expect(response).toEqual({
      id: "1",
      error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
    });
  }
  expect(registry.started).toEqual([]);
});

test("keeps client methods unknown without a registry", async () => {
  const h = await openHarness();

  for (const method of ["client.list", "client.start"]) {
    const response = await h.gateway.handle({ id: "1", method, params: { id: "repl" } });
    expect(response).toEqual({
      id: "1",
      error: { code: "protocol.unknown_method", message: "Unknown protocol method" },
    });
  }
});

test("propagates registry errors", async () => {
  const h = await openHarness({
    clients: fakeRegistry({
      start: async () => {
        throw new PiscesError("client.not_found", "Client is not registered");
      },
    }),
  });

  const response = await h.gateway.handle({
    id: "1",
    method: "client.start",
    params: { id: "missing" },
  });

  expect(response).toEqual({
    id: "1",
    error: { code: "client.not_found", message: "Client is not registered" },
  });
});

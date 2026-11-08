import { createProviderManagement, PiscesError, type ProviderManagement } from "@pisces/core";
import { afterEach, expect, test } from "vitest";
import {
  createGatewayHarness,
  descriptor,
  type GatewayHarness,
  type GatewayHarnessOptions,
} from "./support/gateway-harness.js";

const open: GatewayHarness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

async function openHarness(options?: GatewayHarnessOptions): Promise<GatewayHarness> {
  const harness = await createGatewayHarness(options);
  open.push(harness);
  return harness;
}

function throwingProviders(error: unknown): ProviderManagement {
  const providers = createProviderManagement();
  providers.list = () => {
    throw error;
  };
  return providers;
}

test("projects providers and models without configuration details", async () => {
  const h = await openHarness();
  h.providers.registerProvider(descriptor({ id: "empty", models: [] }));

  const response = await h.gateway.handle({ id: "1", method: "provider.list", params: {} });

  expect(response).toEqual({
    id: "1",
    result: {
      providers: [
        { id: "empty", ready: false, models: [] },
        {
          id: "p",
          ready: true,
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    },
  });
  expect(JSON.stringify(response)).not.toMatch(/baseUrl|dialect|credentialRef|headers/);
});

test("returns an empty provider catalogue", async () => {
  const h = await openHarness({ providers: createProviderManagement() });

  const response = await h.gateway.handle({ id: "1", method: "provider.list", params: {} });

  expect(response).toEqual({ id: "1", result: { providers: [] } });
});

test("rejects an unknown method with protocol.unknown_method", async () => {
  const h = await openHarness();

  const response = await h.gateway.handle({ id: "1", method: "provider.unknown", params: {} });

  expect(response).toEqual({
    id: "1",
    error: { code: "protocol.unknown_method", message: "Unknown protocol method" },
  });
});

test("rejects null params with protocol.invalid_request", async () => {
  const h = await openHarness();

  const response = await h.gateway.handle({ id: "1", method: "provider.list", params: null });

  expect(response).toEqual({
    id: "1",
    error: { code: "protocol.invalid_request", message: "Invalid request parameters" },
  });
});

test("maps a non-protocol failure to a fixed internal error without leaking details", async () => {
  const h = await openHarness({
    providers: throwingProviders(new Error("secret=sk-live headers={authorization} body=...")),
  });

  const response = await h.gateway.handle({ id: "1", method: "provider.list", params: {} });

  expect(response).toEqual({
    id: "1",
    error: { code: "internal.error", message: "Internal error" },
  });
  const serialized = JSON.stringify(response);
  expect(serialized).not.toMatch(/secret=sk-live|authorization|headers=|body=/);
});

test("maps a PiscesError to code and message without cause, data, or secrets", async () => {
  const h = await openHarness({
    providers: throwingProviders(
      new PiscesError("session.invalid_model", "Invalid model", {
        cause: new Error("raw cause"),
        data: { headers: { authorization: "secret" } },
      }),
    ),
  });

  const response = await h.gateway.handle({ id: "1", method: "provider.list", params: {} });

  expect(response).toEqual({
    id: "1",
    error: { code: "session.invalid_model", message: "Invalid model" },
  });
  const serialized = JSON.stringify(response);
  expect(serialized).not.toMatch(/raw cause|authorization|secret|"data"|"cause"/);
});

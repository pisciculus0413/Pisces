import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type ClientSpawn, createClientRegistry } from "../src/client-registry/registry.js";
import { makePackage } from "./extensions-fixtures.js";

const SOCKET = "/tmp/pisces-test.sock";

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  unref(): void {}
}

interface Captured {
  command: string;
  args: readonly string[];
  options: { stdio: ["ignore", "inherit", "inherit"]; env: NodeJS.ProcessEnv };
}

function fakeSpawn(outcome: "spawn" | "error" = "spawn"): ClientSpawn & { captured?: Captured } {
  const spawn = ((command, args, options) => {
    spawn.captured = { command, args, options };
    const child = new FakeChild();
    queueMicrotask(() => child.emit(outcome, new Error("boom")));
    return child as unknown as ChildProcess;
  }) as ClientSpawn & { captured?: Captured };
  return spawn;
}

let root = "";
let configDir = "";
let builtinDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pisces-client-registry-"));
  configDir = join(root, "config");
  builtinDir = join(root, "builtin");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function declareClient(id: string, packageName: string): Promise<void> {
  await makePackage(join(configDir, "extensions", "demo"), {
    name: packageName,
    manifest: { clients: [{ id, entry: "./client.mjs" }] },
    files: { "client.mjs": "process.exit(0);\n" },
  });
}

test("lists discovered clients", async () => {
  await declareClient("repl", "@demo/x");
  const registry = createClientRegistry({
    extensions: { configDir, builtinDir },
    socketPath: SOCKET,
  });

  const clients = await registry.list();

  expect(clients).toHaveLength(1);
  expect(clients[0]).toMatchObject({ id: "repl", source: "@demo/x" });
});

test("rediscovers on every list call", async () => {
  const registry = createClientRegistry({
    extensions: { configDir, builtinDir },
    socketPath: SOCKET,
  });
  expect(await registry.list()).toEqual([]);

  await declareClient("repl", "@demo/x");

  expect(await registry.list()).toHaveLength(1);
});

test("lists nothing without an extension assembly", async () => {
  const registry = createClientRegistry({ socketPath: SOCKET });

  expect(await registry.list()).toEqual([]);
  await expect(registry.start("repl")).rejects.toMatchObject({ code: "client.not_found" });
});

test("spawns the entry with a whitelisted environment", async () => {
  await declareClient("repl", "@demo/x");
  const spawn = fakeSpawn();
  const registry = createClientRegistry({
    extensions: { configDir, builtinDir },
    socketPath: SOCKET,
    env: { PATH: "/usr/bin:/bin", PISCES_TEST_KEY: "sk-secret" },
    spawn,
  });

  await expect(registry.start("repl")).resolves.toEqual({ pid: 4242 });

  expect(spawn.captured?.command).toBe(process.execPath);
  expect(spawn.captured?.args).toEqual([(await registry.list())[0]?.entry]);
  expect(spawn.captured?.options.stdio).toEqual(["ignore", "inherit", "inherit"]);
  expect(spawn.captured?.options.env).toEqual({
    PATH: "/usr/bin:/bin",
    PISCES_SOCKET_PATH: SOCKET,
    PISCES_CLIENT_ID: "repl",
  });
});

test("rejects an unknown client without spawning", async () => {
  const spawn = fakeSpawn();
  const registry = createClientRegistry({
    extensions: { configDir, builtinDir },
    socketPath: SOCKET,
    spawn,
  });

  await expect(registry.start("repl")).rejects.toMatchObject({ code: "client.not_found" });
  expect(spawn.captured).toBeUndefined();
});

test("maps a spawn failure to client.launch_failed", async () => {
  await declareClient("repl", "@demo/x");
  const registry = createClientRegistry({
    extensions: { configDir, builtinDir },
    socketPath: SOCKET,
    spawn: fakeSpawn("error"),
  });

  await expect(registry.start("repl")).rejects.toMatchObject({ code: "client.launch_failed" });
});

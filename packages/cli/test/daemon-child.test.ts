import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StartDaemonOptions } from "@pisces/daemon";
import { afterEach, expect, test, vi } from "vitest";

/**
 * The background child is a thin assembler: the exact `--config` file it was
 * spawned with must reach extension mode, because the daemon reads `defaults`
 * and `defaultWorkspace` from that file on every `session.create`. A real
 * `startDaemon` is replaced so no native transport or socket is involved.
 */

const mocks = vi.hoisted(() => ({ startDaemon: vi.fn() }));

vi.mock("@pisces/daemon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pisces/daemon")>();
  return { ...actual, startDaemon: mocks.startDaemon };
});

import { daemonChildMain } from "../src/daemon-child.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.startDaemon.mockReset();
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Removes only the listeners this run appended, keyed by how many existed before. */
const removeAddedListeners = (signal: "SIGTERM" | "SIGINT", before: number): void => {
  for (const listener of process.listeners(signal).slice(before)) {
    process.removeListener(signal, listener);
  }
};

test("forwards its config path into extension mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pisces-daemon-child-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const templatesDir = join(root, "templates");
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      providers: [
        {
          id: "fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKeyEnv: "PISCES_DAEMON_CHILD_TEST_KEY",
          models: [{ id: "m", contextWindow: 1000, maxOutput: 100, modalities: ["text"] }],
        },
      ],
    }),
    "utf8",
  );

  mocks.startDaemon.mockResolvedValue({
    socketPath: join(root, "pisces.sock"),
    stop: async () => {},
  });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const termBefore = process.listeners("SIGTERM").length;
  const intBefore = process.listeners("SIGINT").length;

  await daemonChildMain([configPath, dataDir, templatesDir]);

  removeAddedListeners("SIGTERM", termBefore);
  removeAddedListeners("SIGINT", intBefore);

  expect(mocks.startDaemon).toHaveBeenCalledTimes(1);
  const options = mocks.startDaemon.mock.calls[0]?.[0] as StartDaemonOptions;
  expect(options.extensions).toEqual({ configPath: resolve(configPath) });
  expect(options).not.toHaveProperty("defaults");
  expect(options.templates).toEqual({ configDir: templatesDir });
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("running"));
});

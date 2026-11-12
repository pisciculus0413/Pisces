import { type ChildProcess, spawn } from "node:child_process";
import { PiscesError } from "@pisces/core";
import { discoverClients } from "../extensions/discovery.js";
import type { ClientRegistration, ExtensionsOptions } from "../extensions/types.js";

/**
 * Clients are ordinary extension packages: the daemon only resolves the declared entry to an
 * absolute path inside the package and starts it as a separate process. Nothing links the
 * client's lifetime to the daemon's.
 */

const NOT_FOUND_MESSAGE = "Client is not registered";
const LAUNCH_FAILED_MESSAGE = "Client could not be started";
const STDIO = ["ignore", "inherit", "inherit"] as const;

export type ClientSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "inherit", "inherit"]; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface ClientRegistryOptions {
  /** Absent means no extension assembly: nothing can be registered. */
  extensions?: ExtensionsOptions;
  socketPath: string;
  /** Only `PATH` is read from it; the child never sees the rest of the daemon environment. */
  env?: NodeJS.ProcessEnv;
  /** Test seam; production uses the real `node:child_process` spawn. */
  spawn?: ClientSpawn;
}

export interface ClientRegistry {
  list(): Promise<ClientRegistration[]>;
  start(id: string): Promise<{ pid: number }>;
}

const defaultSpawn: ClientSpawn = (command, args, options) => spawn(command, [...args], options);

function childEnv(options: ClientRegistryOptions, id: string): NodeJS.ProcessEnv {
  const path = (options.env ?? process.env).PATH;
  return {
    ...(path === undefined ? {} : { PATH: path }),
    PISCES_SOCKET_PATH: options.socketPath,
    PISCES_CLIENT_ID: id,
  };
}

/** Resolves once the child exists; a spawn failure maps to one fixed safe code. */
function started(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(new PiscesError("client.launch_failed", LAUNCH_FAILED_MESSAGE)),
    );
    child.once("spawn", () => resolve());
  });
}

export function createClientRegistry(options: ClientRegistryOptions): ClientRegistry {
  const spawnClient = options.spawn ?? defaultSpawn;

  async function list(): Promise<ClientRegistration[]> {
    if (options.extensions === undefined) return [];
    return (await discoverClients(options.extensions)).clients;
  }

  async function start(id: string): Promise<{ pid: number }> {
    const registration = (await list()).find((client) => client.id === id);
    if (registration === undefined) throw new PiscesError("client.not_found", NOT_FOUND_MESSAGE);
    const entry = registration.entry;

    const child = spawnClient(process.execPath, [entry], {
      stdio: [...STDIO],
      env: childEnv(options, id),
    });
    // The child outlives the daemon: no handle is retained, so stop() never waits for it.
    try {
      await started(child);
    } finally {
      child.unref();
    }
    const pid = child.pid;
    if (pid === undefined) throw new PiscesError("client.launch_failed", LAUNCH_FAILED_MESSAGE);
    return { pid };
  }

  return { list, start };
}

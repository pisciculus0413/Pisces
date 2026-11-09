import { PiscesError } from "@pisces/core";
import { type DaemonHost, startDaemon } from "@pisces/daemon";
import { buildDaemonOptions } from "./assembly.js";
import { loadConfig } from "./config.js";
import { isEntryPath } from "./entry.js";

/** Usage error: wrong argument count, nothing to start. */
const USAGE = "usage: daemon-child <config-path> <data-dir>";
/** Normalized code when the failure is not a PiscesError. */
const START_FAILED = "daemon.start_failed";

function failureCode(error: unknown): string {
  return error instanceof PiscesError ? error.code : START_FAILED;
}

/** Only the socket path and safe codes are ever written; never keys or config values. */
function run(host: DaemonHost): void {
  process.stdout.write(`running ${host.socketPath}\n`);

  const shutdown = (): void => {
    host.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/**
 * Background child entry: assemble providers from the config file plus environment,
 * start the daemon, then stay alive until a signal stops it.
 */
export async function daemonChildMain(argv: string[]): Promise<void> {
  const [configPath, dataDir] = argv;
  if (argv.length !== 2 || configPath === undefined || dataDir === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const config = await loadConfig(configPath);
    run(await startDaemon(buildDaemonOptions(config, dataDir, process.env)));
  } catch (error) {
    process.stderr.write(`error: ${failureCode(error)}\n`);
    process.exitCode = 1;
  }
}

// Only the spawned entry runs; importing this module from tests has no side effects.
if (isEntryPath(process.argv[1], import.meta.url)) {
  await daemonChildMain(process.argv.slice(2));
}

import { pathToFileURL } from "node:url";

// Bounded fresh-process probe: imports the compiled daemon discovery build so a
// package-provided async schema cannot take down the Vitest parent process.
const [distPath, configDir, workspace, builtinDir] = process.argv.slice(2);
if (!distPath || !configDir || !workspace || !builtinDir) {
  process.stderr.write(
    "usage: node extensions-async-child.mjs <dist> <configDir> <workspace> <builtinDir>\n",
  );
  process.exit(2);
}

const { discoverExtensions } = await import(pathToFileURL(distPath).href);
const result = await discoverExtensions({ configDir, builtinDir }, workspace, {});
process.stdout.write(
  JSON.stringify({
    names: result.inventory.entries.map((entry) => entry.name),
    codes: result.issues.map((issue) => issue.code),
  }),
);

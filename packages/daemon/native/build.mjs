#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDir = dirname(fileURLToPath(import.meta.url));
const target = join(nativeDir, "peercred.node");
const built = join(nativeDir, "build", "Release", "peercred.node");

const fail = (message) => {
  process.stderr.write(`native build failed: ${message}\n`);
  process.exit(1);
};

const resolveNodeGyp = () => {
  try {
    const pkg = createRequire(import.meta.url).resolve("node-gyp/package.json");
    return join(dirname(pkg), "bin", "node-gyp.js");
  } catch {
    const local = join(nativeDir, "..", "node_modules", "node-gyp", "bin", "node-gyp.js");
    return existsSync(local) ? local : undefined;
  }
};

const nodeGyp = resolveNodeGyp();
if (nodeGyp === undefined || !existsSync(nodeGyp)) {
  fail("pinned node-gyp is not installed; run pnpm install");
}

const result = spawnSync(process.execPath, [nodeGyp, "rebuild", "--release"], {
  cwd: nativeDir,
  stdio: "inherit",
});
if (result.status !== 0) {
  fail(`node-gyp exited with ${result.status ?? result.signal}`);
}
if (!existsSync(built)) {
  fail(`missing compiled addon at ${built}`);
}

copyFileSync(built, target);
process.stdout.write(`built ${target}\n`);

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATCH_RELATIVE = join("patches", "jiti@2.7.0.patch");
const DOC_RELATIVE = join("patches", "jiti-2.7.0.md");

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runStep(label, command, args, options) {
  log(`\n$ ${command} ${args.join(" ")}`);
  const result = await run(command, args, options);
  log(`${label}: exit=${result.code ?? result.signal}`);
  if (result.code !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-40).join("\n");
    if (detail.length > 0) log(detail);
  }
  return result;
}

const SKIP_NAMES = new Set([".git", ".superpowers", ".cache", "coverage", "dist", "node_modules"]);

async function copyWorkspace(destination) {
  await cp(REPO_ROOT, destination, {
    recursive: true,
    filter(source) {
      const rel = relative(REPO_ROOT, source);
      if (rel === "") return true;
      const parts = rel.split(sep);
      if (parts.some((part) => SKIP_NAMES.has(part))) return false;
      if (rel === join("packages", "daemon", "native", "build")) return false;
      if (source.endsWith(".node")) return false;
      return true;
    },
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyPatchIntegrity(workspace) {
  const patchPath = join(workspace, PATCH_RELATIVE);
  if (!(await exists(patchPath))) throw new Error(`missing ${PATCH_RELATIVE}`);
  const patchHash = sha256(await readFile(patchPath));

  const lock = await readFile(join(workspace, "pnpm-lock.yaml"), "utf8");
  const lockMatch = /patchedDependencies:\s*\n\s*jiti@2\.7\.0:\s*([a-f0-9]{64})/u.exec(lock);
  if (lockMatch === null)
    throw new Error("pnpm-lock.yaml has no jiti@2.7.0 patchedDependencies hash");
  if (lockMatch[1] !== patchHash) {
    throw new Error(`patch hash ${patchHash} does not match lockfile ${lockMatch[1]}`);
  }

  const docPath = join(workspace, DOC_RELATIVE);
  if (!(await exists(docPath))) throw new Error(`missing ${DOC_RELATIVE}`);
  const doc = await readFile(docPath, "utf8");
  const docPatch = /Patch file SHA-256: `([a-f0-9]{64})`/u.exec(doc);
  if (docPatch === null) throw new Error("patch notes have no patch file SHA-256");
  if (docPatch[1] !== patchHash) {
    throw new Error(`patch hash ${patchHash} does not match notes ${docPatch[1]}`);
  }

  const runtime = /\| `dist\/jiti\.cjs` \| `[a-f0-9]{64}` \| `([a-f0-9]{64})` \|/u.exec(doc);
  const types = /\| `lib\/types\.d\.ts` \| `[a-f0-9]{64}` \| `([a-f0-9]{64})` \|/u.exec(doc);
  if (runtime === null || types === null)
    throw new Error("patch notes have no installed file hashes");

  const installedRuntime = join(
    workspace,
    "packages",
    "daemon",
    "node_modules",
    "jiti",
    "dist",
    "jiti.cjs",
  );
  const installedTypes = join(
    workspace,
    "packages",
    "daemon",
    "node_modules",
    "jiti",
    "lib",
    "types.d.ts",
  );
  if (!(await exists(installedRuntime))) throw new Error("installed jiti runtime is missing");
  if (!(await exists(installedTypes))) throw new Error("installed jiti types are missing");
  if (sha256(await readFile(installedRuntime)) !== runtime[1]) {
    throw new Error("installed jiti runtime hash does not match patch notes");
  }
  if (sha256(await readFile(installedTypes)) !== types[1]) {
    throw new Error("installed jiti types hash does not match patch notes");
  }
}

async function pnpmInstall(workspace, store) {
  return runStep(
    "install",
    "pnpm",
    ["install", "--frozen-lockfile", "--store-dir", store, "--reporter", "append-only"],
    { cwd: workspace, timeout: 300_000 },
  );
}

async function main() {
  const temp = await mkdtemp(join(tmpdir(), "pisces-extension-install-"));
  const failures = [];
  try {
    const version = await runStep("pnpm-version", "pnpm", ["--version"], {
      cwd: REPO_ROOT,
      timeout: 30_000,
    });
    if (version.stdout.trim() !== "12.8.1") {
      throw new Error(`expected pnpm 12.8.1, got ${version.stdout.trim()}`);
    }

    const workspace = join(temp, "workspace");
    await copyWorkspace(workspace);
    log(`workspace copy: ${workspace}`);

    const install = await pnpmInstall(workspace, join(temp, "store-main"));
    if (install.code !== 0) failures.push("main install");

    try {
      await verifyPatchIntegrity(workspace);
      log("integrity: exit=0");
    } catch (error) {
      log(`integrity: failed: ${String(error?.message ?? error)}`);
      failures.push("main integrity");
    }

    if (install.code === 0) {
      const native = await runStep(
        "native-build",
        process.execPath,
        [join("packages", "daemon", "native", "build.mjs")],
        { cwd: workspace, timeout: 180_000 },
      );
      if (native.code !== 0) failures.push("main native build");

      const build = await runStep(
        "tsc-build",
        "pnpm",
        ["exec", "tsc", "-b", "tsconfig.build.json"],
        {
          cwd: workspace,
          timeout: 180_000,
        },
      );
      if (build.code !== 0) failures.push("main tsc build");

      const typecheck = await runStep("tsc-test", "pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
        cwd: workspace,
        timeout: 180_000,
      });
      if (typecheck.code !== 0) failures.push("main typecheck");

      const dist = await runStep(
        "dist-runtime",
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "packages/daemon/test/extensions-jiti-patch.test.ts",
          "packages/daemon/test/extensions-loader-dist.test.ts",
          "packages/daemon/test/extensions-loader-cjs.test.ts",
        ],
        { cwd: workspace, timeout: 300_000 },
      );
      if (dist.code !== 0) failures.push("main dist/runtime");
    } else {
      failures.push("main build skipped after install failure");
    }

    for (const control of [
      {
        name: "missing-patch",
        mutate: async (root) => rm(join(root, PATCH_RELATIVE), { force: true }),
      },
      {
        name: "corrupt-patch",
        mutate: async (root) => {
          const path = join(root, PATCH_RELATIVE);
          await writeFile(path, `${await readFile(path, "utf8")}\n`, "utf8");
        },
      },
    ]) {
      const negative = join(temp, control.name);
      await copyWorkspace(negative);
      await control.mutate(negative);
      const negativeInstall = await pnpmInstall(negative, join(temp, `store-${control.name}`));
      let integrityError = "";
      try {
        await verifyPatchIntegrity(negative);
      } catch (error) {
        integrityError = String(error?.message ?? error);
      }
      log(
        `negative-control ${control.name}: install exit=${negativeInstall.code ?? negativeInstall.signal} integrity=${integrityError === "" ? "pass" : "fail"}`,
      );
      if (negativeInstall.code === 0 && integrityError === "") {
        failures.push(`negative control ${control.name} unexpectedly passed`);
      }
    }

    if (failures.length > 0) {
      log(`\ninstall verification failed: ${failures.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    log("\ninstall verification passed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});

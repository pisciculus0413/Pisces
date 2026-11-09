import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

// Top-level side effect proves whether discovery imported the entry module.
export function toolSource(sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export default async function run() {",
    '  return { content: [{ type: "text", text: "ran" }] };',
    "}",
    "",
  ].join("\n");
}

export function wrapperSource(sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export default function createWrapper() {",
    "  return (tool) => tool;",
    "}",
    "",
  ].join("\n");
}

export function contextSource(sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "executed");`,
    "export default async function resolve() {",
    "  return [];",
    "}",
    "",
  ].join("\n");
}

export interface PackageSpec {
  name: string;
  manifest?: unknown;
  files?: Record<string, string>;
}

export async function makePackage(root: string, spec: PackageSpec): Promise<string> {
  const manifest: Record<string, unknown> = { name: spec.name };
  if (spec.manifest !== undefined) manifest.pisces = spec.manifest;
  await writeJson(join(root, "package.json"), manifest);
  for (const [relative, text] of Object.entries(spec.files ?? {})) {
    await writeText(join(root, relative), text);
  }
  return root;
}

export async function writeSidecar(
  packageRoot: string,
  relative: string,
  meta: unknown,
): Promise<void> {
  await writeJson(join(packageRoot, `${relative}.meta.json`), meta);
}

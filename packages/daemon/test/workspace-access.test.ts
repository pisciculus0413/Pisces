import { mkdir, mkdtemp, access as probe, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiscesError, type WorkspaceAccess } from "@pisces/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createWorkspaceAccess } from "../src/workspace/access.js";

const OUTSIDE = "Path is outside the workspace";
const IO = "Workspace access failed";

async function capture(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error to be thrown");
}

async function expectFailure(run: () => unknown, code: string, message: string): Promise<void> {
  const error = await capture(run);
  expect(error).toBeInstanceOf(PiscesError);
  expect(error).toMatchObject({ code, message });
}

let base = "";
let root = "";
let outside = "";
let access: WorkspaceAccess;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pisces-workspace-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  access = createWorkspaceAccess(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test("resolves a relative path inside the root", () => {
  expect(access.resolve("a/b.txt")).toBe(join(root, "a/b.txt"));
});

test("folds inner dots and keeps the root itself", () => {
  expect(access.resolve("a/../b.txt")).toBe(join(root, "b.txt"));
  expect(access.resolve("./a/./b.txt")).toBe(join(root, "a/b.txt"));
  expect(access.resolve(".")).toBe(root);
});

test("rejects a parent segment that crosses the root", async () => {
  await expectFailure(() => access.resolve("../escape.txt"), "workspace.path_outside", OUTSIDE);
  await expectFailure(
    () => access.resolve("a/../../escape.txt"),
    "workspace.path_outside",
    OUTSIDE,
  );
  await expectFailure(() => access.resolve(".."), "workspace.path_outside", OUTSIDE);
});

test("rejects absolute paths", async () => {
  await expectFailure(() => access.resolve(join(root, "a.txt")), "workspace.path_outside", OUTSIDE);
  await expectFailure(() => access.resolve("/etc/passwd"), "workspace.path_outside", OUTSIDE);
});

test("rejects empty, NUL and non-string paths", async () => {
  await expectFailure(() => access.resolve(""), "workspace.path_outside", OUTSIDE);
  await expectFailure(() => access.resolve("a\0b"), "workspace.path_outside", OUTSIDE);
  const resolveAny = access.resolve as unknown as (path: unknown) => string;
  await expectFailure(() => resolveAny(42), "workspace.path_outside", OUTSIDE);
});

test("resolves a not-yet-existing nested path", async () => {
  expect(access.resolve("new/deep/file.txt")).toBe(join(root, "new/deep/file.txt"));
  await expect(access.exists("new/deep/file.txt")).resolves.toBe(false);
});

test("rejects a symlink that points outside the root", async () => {
  await mkdir(outside, { recursive: true });
  await symlink(join(outside, "file.txt"), join(root, "link.txt"), "file");
  await expectFailure(() => access.resolve("link.txt"), "workspace.path_outside", OUTSIDE);
  await expectFailure(() => access.exists("link.txt"), "workspace.path_outside", OUTSIDE);
});

test("rejects a symlink ancestor outside the root even when the target does not exist", async () => {
  await symlink(outside, join(root, "dirlink"), "dir");
  await expectFailure(
    () => access.resolve("dirlink/new/deep.txt"),
    "workspace.path_outside",
    OUTSIDE,
  );
  await expectFailure(
    () => access.exists("dirlink/new/deep.txt"),
    "workspace.path_outside",
    OUTSIDE,
  );
  await expectFailure(
    () => access.writeFile("dirlink/new/deep.txt", "x"),
    "workspace.path_outside",
    OUTSIDE,
  );
  await expectFailure(
    () => access.ensureDirectory("dirlink/new"),
    "workspace.path_outside",
    OUTSIDE,
  );
});

test("resolves a symlink that stays inside the root", async () => {
  await mkdir(join(root, "real"));
  await symlink(join(root, "real"), join(root, "alias"), "dir");
  expect(access.resolve("alias/new.txt")).toBe(join(root, "real/new.txt"));
});

test("write through a dangling symlink cannot create files outside the root", async () => {
  await symlink(join(outside, "created.txt"), join(root, "ghost.txt"), "file");
  await expectFailure(() => access.writeFile("ghost.txt", "x"), "workspace.path_outside", OUTSIDE);
  await expect(probe(join(outside, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("ensureDirectory creates nested directories", async () => {
  await access.ensureDirectory("a/b/c");
  await expect(access.exists("a/b/c")).resolves.toBe(true);
  await access.ensureDirectory("a/b/c");
  await expectFailure(() => access.ensureDirectory("../evil"), "workspace.path_outside", OUTSIDE);
});

test("writeFile and readFile round-trip through nested directories", async () => {
  await access.writeFile("nested/dir/file.txt", "hello");
  await expect(access.exists("nested/dir/file.txt")).resolves.toBe(true);
  await expect(access.readFile("nested/dir/file.txt")).resolves.toBe("hello");
});

test("exists reports false inside the root and throws outside it", async () => {
  await mkdir(outside, { recursive: true });
  await expect(access.exists("missing.txt")).resolves.toBe(false);
  await expectFailure(() => access.exists("../outside.txt"), "workspace.path_outside", OUTSIDE);
  await expectFailure(() => access.exists("/etc/passwd"), "workspace.path_outside", OUTSIDE);
  await expectFailure(() => access.exists("a\0b"), "workspace.path_outside", OUTSIDE);
});

test("write failures surface storage.io", async () => {
  await mkdir(join(root, "adir"));
  await expectFailure(() => access.writeFile("adir", "x"), "storage.io", IO);
});

test("read failures surface storage.io", async () => {
  await expectFailure(() => access.readFile("missing.txt"), "storage.io", IO);
});

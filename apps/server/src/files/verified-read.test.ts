import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { FileChangedError, FileNotFoundError, FileTooLargeError } from "./errors.ts";
import { resolveWorkspaceEntry } from "./file-access.ts";
import { readVerifiedBytes } from "./verified-read.ts";

/**
 * The read is anchored to the inode the allow-list check saw. Each test resolves an entry, then
 * moves the path out from under it and reads with that stale entry — which is exactly the window a
 * plain `readFile(entry.absolutePath)` would have served.
 */

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corral-read-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.png"), "outside bytes");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const LIMIT = 4 * 1024 * 1024;

test("reads the bytes of the file it checked", async () => {
  writeFileSync(join(workspace, "shot.png"), "png bytes");
  const entry = await resolveWorkspaceEntry(workspace, "shot.png");
  expect((await readVerifiedBytes(entry, LIMIT)).toString()).toBe("png bytes");
});

test("a symlink planted after the check is refused, not followed", async () => {
  const path = join(workspace, "shot.png");
  writeFileSync(path, "png bytes");
  const entry = await resolveWorkspaceEntry(workspace, "shot.png");

  rmSync(path);
  symlinkSync(join(outside, "secret.png"), path);

  // Without the anchor this returned "outside bytes".
  await expect(readVerifiedBytes(entry, LIMIT)).rejects.toThrow(FileChangedError);
});

test("another file swapped over the checked one is refused by its inode", async () => {
  const path = join(workspace, "shot.png");
  writeFileSync(path, "png bytes");
  const entry = await resolveWorkspaceEntry(workspace, "shot.png");

  const replacement = join(workspace, "replacement.png");
  writeFileSync(replacement, "other bytes");
  renameSync(replacement, path);

  await expect(readVerifiedBytes(entry, LIMIT)).rejects.toThrow(FileChangedError);
});

test("a file past the bound is refused by the bytes read, not only by the earlier stat", async () => {
  const path = join(workspace, "shot.png");
  writeFileSync(path, "png bytes");
  const entry = await resolveWorkspaceEntry(workspace, "shot.png");

  writeFileSync(path, Buffer.alloc(LIMIT + 1));

  await expect(readVerifiedBytes(entry, LIMIT)).rejects.toThrow(FileTooLargeError);
});

test("a path that vanished is a miss, not a changed file", async () => {
  const path = join(workspace, "shot.png");
  writeFileSync(path, "png bytes");
  const entry = await resolveWorkspaceEntry(workspace, "shot.png");
  rmSync(path);

  await expect(readVerifiedBytes(entry, LIMIT)).rejects.toThrow(FileNotFoundError);
});

test("a file that became a directory is refused by the handle's own stat", async () => {
  const path = join(workspace, "shot.png");
  writeFileSync(path, "png bytes");
  const entry = await resolveWorkspaceEntry(workspace, "shot.png");

  rmSync(path);
  mkdirSync(path);

  await expect(readVerifiedBytes(entry, LIMIT)).rejects.toThrow(FileChangedError);
});

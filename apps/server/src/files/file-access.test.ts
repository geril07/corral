import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { FileNotFoundError, FileOutsideWorkspaceError } from "./errors.ts";
import { resolveWorkspaceEntry } from "./file-access.ts";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corral-files-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), "const answer = 42;\n");
  writeFileSync(join(workspace, "shot.png"), "not really a png");
  writeFileSync(join(outside, "secret.txt"), "outside\n");
});

afterEach(() => {
  chmodSync(join(root, "workspace"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

test("a relative or absolute path inside the workspace resolves to its canonical form", async () => {
  const relative = await resolveWorkspaceEntry(workspace, "src/app.ts");
  expect(relative).toMatchObject({
    relativePath: "src/app.ts",
    name: "app.ts",
    kind: "file",
    media: undefined,
  });
  expect(relative.absolutePath).toBe(join(workspace, "src", "app.ts"));
  expect(relative.size).toBe("const answer = 42;\n".length);

  const absolute = await resolveWorkspaceEntry(workspace, join(workspace, "src", "app.ts"));
  expect(absolute.relativePath).toBe("src/app.ts");

  // A `..` that stays inside is inside: it normalises to the same file.
  expect(await resolveWorkspaceEntry(workspace, "src/../shot.png")).toMatchObject({
    kind: "file",
    relativePath: "shot.png",
  });
});

test("media comes from the extension, and a directory is not a file", async () => {
  expect(await resolveWorkspaceEntry(workspace, "shot.png")).toMatchObject({
    media: "image",
    mime: "image/png",
  });
  expect(await resolveWorkspaceEntry(workspace, "src")).toMatchObject({
    kind: "directory",
    relativePath: "src",
    size: 0,
  });
});

test("a `..` that leaves the workspace is refused, not reported missing", async () => {
  await expect(resolveWorkspaceEntry(workspace, "../outside/secret.txt")).rejects.toThrow(
    FileOutsideWorkspaceError,
  );
  await expect(resolveWorkspaceEntry(workspace, "src/../../outside/secret.txt")).rejects.toThrow(
    FileOutsideWorkspaceError,
  );
});

test("an absolute path outside the workspace is refused with the same typed error", async () => {
  await expect(resolveWorkspaceEntry(workspace, join(outside, "secret.txt"))).rejects.toThrow(
    FileOutsideWorkspaceError,
  );
  await expect(resolveWorkspaceEntry(workspace, "/etc/hostname")).rejects.toThrow(
    FileOutsideWorkspaceError,
  );
});

test("a symlink pointing out of the workspace cannot escape the allow-list", async () => {
  symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
  await expect(resolveWorkspaceEntry(workspace, "link.txt")).rejects.toThrow(
    FileOutsideWorkspaceError,
  );
  symlinkSync(outside, join(workspace, "linkdir"));
  await expect(resolveWorkspaceEntry(workspace, "linkdir/secret.txt")).rejects.toThrow(
    FileOutsideWorkspaceError,
  );
});

test("a `..` after a symlink is lexical: it names the link's own parent, not its target's", async () => {
  // `link/../app.ts` is `app.ts` beside `link`, which is what `path.resolve` (and this allow-list)
  // means. A shell would follow `link` first and reach the target's parent instead; that
  // component-wise reading is not built (see `resolveWorkspaceEntry`).
  mkdirSync(join(outside, "nested"), { recursive: true });
  writeFileSync(join(outside, "nested", "app.ts"), "outside\n");
  symlinkSync(join(outside, "nested"), join(workspace, "linkdir"));
  writeFileSync(join(workspace, "app.ts"), "inside\n");

  const entry = await resolveWorkspaceEntry(workspace, "linkdir/../app.ts");
  expect(entry).toMatchObject({ relativePath: "app.ts", absolutePath: join(workspace, "app.ts") });
  // The target's own parent is out of reach, and a `..` that leaves through the link is refused.
  await expect(resolveWorkspaceEntry(workspace, "linkdir/../../outside/app.ts")).rejects.toThrow(
    FileOutsideWorkspaceError,
  );
});

test("a workspace that is itself a symlink confines reads to its target", async () => {
  // The root is the workspace's `realpath`, not the lexical path a task row holds: a sibling of
  // the link is outside even though it looks adjacent.
  writeFileSync(join(root, "sibling.txt"), "sibling\n");
  symlinkSync(outside, join(workspace, "root-link"));
  writeFileSync(join(outside, "inside.txt"), "inside\n");

  expect(await resolveWorkspaceEntry(join(workspace, "root-link"), "inside.txt")).toMatchObject({
    relativePath: "inside.txt",
  });
  await expect(
    resolveWorkspaceEntry(join(workspace, "root-link"), "../sibling.txt"),
  ).rejects.toThrow(FileOutsideWorkspaceError);
});

test("a symlink that stays inside resolves to the file it names", async () => {
  symlinkSync(join(workspace, "src", "app.ts"), join(workspace, "alias.ts"));
  expect(await resolveWorkspaceEntry(workspace, "alias.ts")).toMatchObject({
    relativePath: "src/app.ts",
    kind: "file",
  });
});

test("nothing at the path is a not-found refusal, and so is a dangling symlink", async () => {
  await expect(resolveWorkspaceEntry(workspace, "src/missing.ts")).rejects.toThrow(
    FileNotFoundError,
  );
  symlinkSync(join(workspace, "gone.ts"), join(workspace, "dangling.ts"));
  await expect(resolveWorkspaceEntry(workspace, "dangling.ts")).rejects.toThrow(FileNotFoundError);
  await expect(resolveWorkspaceEntry(workspace, "")).rejects.toThrow(FileNotFoundError);
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { runGit } from "../../test/git-repo.ts";
import { commit, pushBranch, stagePaths, stagedPaths } from "./writes.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corral-git-writes-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repository with a commit, `files` written and one commit already made. */
function repo(files: Record<string, string> = {}): string {
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  runGit(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  runGit(dir, "add", ".");
  runGit(dir, "commit", "-m", "initial commit");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test("a repository whose first commit is still ahead can unstage everything", async () => {
  // No commit at all: `git restore --staged` needs HEAD, so the path must be the index itself.
  const dir = join(root, "unborn");
  mkdirSync(dir, { recursive: true });
  runGit(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "two\n");

  await stagePaths(dir, "all", true);
  expect(await stagedPaths(dir)).toEqual(["a.txt", "b.txt"]);
  await stagePaths(dir, "all", false);
  expect(await stagedPaths(dir)).toEqual([]);
  // The files stay on disk: this empties the index, it does not delete anything.
  expect(runGit(dir, "status", "--porcelain").trim().split("\n")).toEqual(["?? a.txt", "?? b.txt"]);

  await stagePaths(dir, ["a.txt"], true);
  await stagePaths(dir, ["a.txt"], false);
  expect(await stagedPaths(dir)).toEqual([]);

  // A second "unstage everything" with nothing staged is a no-op, not git's "pathspec '.' did not
  // match any files".
  await stagePaths(dir, "all", false);
  expect(await stagedPaths(dir)).toEqual([]);
  // Nor does naming a path that is not staged fail.
  await stagePaths(dir, ["a.txt"], false);
  expect(await stagedPaths(dir)).toEqual([]);
});

test("staging records a deletion and a path is never a glob", async () => {
  const dir = repo({ "*.txt": "one\n", "gone.txt": "bye\n" });
  runGit(dir, "add", ".");
  runGit(dir, "commit", "-m", "files");
  writeFileSync(join(dir, "*.txt"), "two\n");
  rmSync(join(dir, "gone.txt"));

  await stagePaths(dir, ["*.txt", "gone.txt"], true);
  expect(await stagedPaths(dir)).toEqual(["*.txt", "gone.txt"]);
  expect(runGit(dir, "diff", "--cached", "--name-status").trim().split("\n").toSorted()).toEqual([
    "D\tgone.txt",
    "M\t*.txt",
  ]);
});

test("a rename stages and unstages both of its paths, and a commit records the move", async () => {
  const dir = repo({ "old.txt": "one\ntwo\nthree\n" });
  runGit(dir, "add", ".");
  runGit(dir, "commit", "-m", "files");
  renameSync(join(dir, "old.txt"), join(dir, "new.txt"));

  // What the bar sends for one R row: the old path and the new one.
  await stagePaths(dir, ["old.txt", "new.txt"], true);
  expect(await stagedPaths(dir)).toEqual(["new.txt", "old.txt"]);
  expect(runGit(dir, "diff", "--cached", "--name-status").trim()).toBe("R100\told.txt\tnew.txt");

  // A commit from the bar records the rename and leaves no old file, in HEAD or the index.
  await commit(dir, "refactor: rename old to new");
  expect(runGit(dir, "ls-tree", "--name-only", "HEAD").trim().split("\n")).toEqual([
    "README.md",
    "new.txt",
  ]);
  expect(runGit(dir, "status", "--porcelain").trim()).toBe("");

  renameSync(join(dir, "new.txt"), join(dir, "final.txt"));
  // Unstage after Stage all moves both paths too, and leaves the worktree rename intact.
  await stagePaths(dir, "all", true);
  expect(await stagedPaths(dir)).toEqual(["final.txt", "new.txt"]);
  await stagePaths(dir, ["new.txt", "final.txt"], false);
  expect(await stagedPaths(dir)).toEqual([]);
  expect(runGit(dir, "diff", "--cached", "--name-status").trim()).toBe("");
  expect(existsSync(join(dir, "new.txt"))).toBe(false);
  expect(readFileSync(join(dir, "final.txt"), "utf8")).toBe("one\ntwo\nthree\n");

  // Unstage after staging the selected row does the same.
  await stagePaths(dir, ["new.txt", "final.txt"], true);
  expect(await stagedPaths(dir)).toEqual(["final.txt", "new.txt"]);
  await stagePaths(dir, ["new.txt", "final.txt"], false);
  expect(await stagedPaths(dir)).toEqual([]);
  expect(runGit(dir, "status", "--porcelain").trimEnd().split("\n").toSorted()).toEqual([
    " D new.txt",
    "?? final.txt",
  ]);
});

test("a committed rename stages its new path without the old one and unstages it again", async () => {
  const dir = repo({ "old.txt": "one\ntwo\nthree\n" });
  runGit(dir, "add", ".");
  runGit(dir, "commit", "-m", "files");
  renameSync(join(dir, "old.txt"), join(dir, "new.txt"));
  await stagePaths(dir, ["old.txt", "new.txt"], true);
  await commit(dir, "refactor: rename old to new");
  writeFileSync(join(dir, "new.txt"), "one\ntwo\nthree\nfour\n");

  // The read model still shows R old -> new, so the bar sends both; the old path is in neither the
  // index nor the worktree after the commit and must be dropped instead of failing the write.
  await stagePaths(dir, ["old.txt", "new.txt"], true);
  expect(await stagedPaths(dir)).toEqual(["new.txt"]);
  expect(runGit(dir, "diff", "--cached", "--name-status").trim()).toBe("M\tnew.txt");

  // A second Stage click from the same committed R row is safe, and Unstage drops the missing old
  // path too.
  await stagePaths(dir, ["old.txt", "new.txt"], true);
  expect(await stagedPaths(dir)).toEqual(["new.txt"]);
  await stagePaths(dir, ["old.txt", "new.txt"], false);
  expect(await stagedPaths(dir)).toEqual([]);
  expect(runGit(dir, "diff", "--cached", "--name-status").trim()).toBe("");
  expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("one\ntwo\nthree\nfour\n");
  expect(existsSync(join(dir, "old.txt"))).toBe(false);

  // No path left to stage is still git's refusal, not a silent no-op.
  await expect(stagePaths(dir, ["old.txt"], true)).rejects.toThrow(/did not match/);
});

test("a commit takes the message as typed and a push reaches the given remote", async () => {
  const dir = repo({ "a.txt": "one\n" });
  const origin = join(root, "origin.git");
  runGit(root, "clone", "--bare", dir, origin);
  runGit(dir, "remote", "add", "origin", origin);

  await stagePaths(dir, "all", true);
  const committed = await commit(dir, "feat: one\n\nbody line");
  expect(committed.subject).toBe("feat: one");
  expect(runGit(dir, "log", "-1", "--format=%B").trim()).toBe("feat: one\n\nbody line");

  const pushed = await pushBranch(dir, "origin", "main");
  expect(pushed.commit).toBe(runGit(dir, "rev-parse", "HEAD").trim());
  expect(runGit(origin, "rev-parse", "refs/heads/main").trim()).toBe(pushed.commit);
  // No upstream was configured by the push, and the branch kept its name.
  expect(runGit(dir, "config", "--list")).not.toContain("branch.main.remote");
  expect(runGit(dir, "branch", "--show-current").trim()).toBe("main");
});

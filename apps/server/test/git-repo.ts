import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Runs the real git, isolated from the user's git config, and returns stdout. */
export function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

export function commitFile(repo: string, name: string, content: string, message = name): void {
  writeFiles(repo, { [name]: content });
  runGit(repo, "add", name);
  runGit(repo, "commit", "-m", message);
}

/** A repository on `branch` with one commit. */
export function initRepo(dir: string, branch = "main"): string {
  mkdirSync(dir, { recursive: true });
  runGit(dir, "init", "-b", branch);
  commitFile(dir, "README.md", "hello\n", "initial commit");
  return dir;
}

/**
 * A bare repository `origin.git` whose default branch is `trunk` (with one more branch,
 * `release/1.0`), and a clone of it at `clone`, which therefore has `origin/HEAD`.
 */
export function cloneOfOrigin(root: string): { origin: string; clone: string } {
  const seed = initRepo(join(root, "seed"), "trunk");
  runGit(seed, "branch", "release/1.0");
  const origin = join(root, "origin.git");
  runGit(root, "clone", "--bare", seed, origin);
  runGit(origin, "symbolic-ref", "HEAD", "refs/heads/trunk");
  const clone = join(root, "clone");
  runGit(root, "clone", origin, clone);
  return { origin, clone };
}

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Where this run's repositories live; the global setup deletes it at the end. */
export const REPOS_DIR = join(tmpdir(), `corral-web-repos-${process.pid}`);

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
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

/**
 * A repository on `main` with one commit, plus a branch for each of `branches`. `files` are
 * written before that commit, so a test can start from a file whose edit spans two hunks.
 */
export function createGitRepo(
  _context: unknown,
  name: string,
  branches: string[] = [],
  files: Record<string, string> = {},
): string {
  mkdirSync(REPOS_DIR, { recursive: true });
  const dir = mkdtempSync(join(REPOS_DIR, `${name}-`));
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
  for (const branch of branches) git(dir, "branch", branch);
  return dir;
}

export function removeGitRepos() {
  rmSync(REPOS_DIR, { recursive: true, force: true });
}

/**
 * A repository on `main` whose `origin` is a local **bare** repository in the same temp root: the
 * remote the commit/push/pull-request flow writes to. Nothing here
 * knows a real forge; the fake `gh`/`glab` stand in for one.
 */
export function createGitRepoWithRemote(
  _context: unknown,
  name: string,
): { repo: string; origin: string } {
  mkdirSync(REPOS_DIR, { recursive: true });
  const root = mkdtempSync(join(REPOS_DIR, `${name}-`));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "initial commit");
  const origin = join(root, "origin.git");
  git(root, "clone", "--bare", seed, origin);
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  const repo = join(root, "clone");
  git(root, "clone", origin, repo);
  return { repo, origin };
}

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

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

/** A repository at `dir` on `main` with one commit. */
export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  runGit(dir, "init", "-b", "main");
  writeFileSync(`${dir}/README.md`, "hello\n");
  runGit(dir, "add", "README.md");
  runGit(dir, "commit", "-m", "initial commit");
  return dir;
}

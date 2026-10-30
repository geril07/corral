import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** git exited non-zero; `message` is its stderr, meant for the user. */
export class GitError extends Error {}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs `git <args>` in `cwd` and returns stdout. Output is untranslated and git never prompts,
 * so the server cannot hang on credentials. Failing to start git at all rejects with the
 * original error, not a `GitError`.
 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (typeof error.code === "number") {
          reject(
            new GitError(stderr.trim() || `git ${args[0]} failed with exit code ${error.code}`),
          );
        } else if (error.code === "ENOENT" && !existsSync(cwd)) {
          // spawn reports a missing working directory like a missing executable.
          reject(new GitError(`no such directory: ${cwd}`));
        } else {
          reject(error);
        }
      },
    );
  });
}

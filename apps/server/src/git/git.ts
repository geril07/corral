import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** git exited non-zero; `message` is its stderr, meant for the user. */
export class GitError extends Error {}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * A git call that has not answered in this long is killed and becomes a `GitError`: one hung
 * helper (a textconv driver, a credential helper) must not hold an RPC open forever. Generous
 * enough for a worktree checkout on a cold filesystem, short enough for a request to fail visibly.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GitOptions {
  /** Extra environment for this call, on top of the base (`LC_ALL`, no prompts). */
  env?: Record<string, string>;
  /** Deadline for this call; the default is `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Test seam; the default is 64 MiB, past which git's output is not one reply. */
  maxOutputBytes?: number;
}

/**
 * Runs `git <args>` in `cwd` and returns stdout. Output is untranslated and git never prompts,
 * so the server cannot hang on credentials; stdin is closed at once, so a command or helper that
 * reads it sees EOF instead of waiting. A timeout, an output overflow and a non-zero exit each
 * become a `GitError`; failing to start git at all rejects with the original error.
 */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...options.env },
        maxBuffer,
        timeout: timeoutMs,
        // The default signal leaves a git that ignores SIGTERM; a killed call is a refusal anyway.
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (error.code === "ENOENT" && !existsSync(cwd)) {
          // spawn reports a missing working directory like a missing executable.
          reject(new GitError(`no such directory: ${cwd}`));
        } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(
            new GitError(`git ${args[0]} wrote more than ${Math.round(maxBuffer / 1024)} KiB`),
          );
        } else if (error.killed === true) {
          reject(new GitError(`git ${args[0]} did not finish within ${timeoutMs} ms`));
        } else if (typeof error.code === "number") {
          reject(
            new GitError(stderr.trim() || `git ${args[0]} failed with exit code ${error.code}`),
          );
        } else {
          reject(error);
        }
      },
    );
    // Every command Corral runs is non-interactive; a closed stdin makes that structural, and a
    // helper that reads stdin (a textconv driver) gets EOF instead of blocking the child.
    child.stdin?.end();
  });
}

/**
 * A read-only git call: `GIT_OPTIONAL_LOCKS=0` keeps `status` and `diff` from refreshing and
 * rewriting `.git/index`, `diff.autoRefreshIndex=false` says the same to the diff machinery, and
 * `GIT_LITERAL_PATHSPECS=1` means a path such as `*.txt` is the file with that name, not a glob.
 * Everything that only reads a task's workspace goes through here.
 */
export function gitRead(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  return git(cwd, args, {
    ...options,
    env: {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "diff.autoRefreshIndex",
      GIT_CONFIG_VALUE_0: "false",
      ...options.env,
    },
  });
}

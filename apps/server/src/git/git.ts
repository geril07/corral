import { ProcessFailure, runProcess } from "../process/run-process.ts";

/** git exited non-zero; `message` is its stderr, meant for the user. */
export class GitError extends Error {}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * A git call that has not answered in this long is killed — with its process group, so a hook or a
 * textconv helper it started dies too — and becomes a `GitError`: one hung helper (a credential
 * helper, a `pre-push` hook) must not hold an RPC open forever.
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
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  try {
    const result = await runProcess({
      command: "git",
      args,
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...options.env },
      timeoutMs,
      maxBufferBytes: maxBuffer,
      signal: undefined,
    });
    if (result.exitCode === 0) return result.stdout;
    throw new GitError(
      result.stderr.trim() ||
        `git ${args[0]} failed with exit code ${result.exitCode ?? result.signal ?? "unknown"}`,
    );
  } catch (error) {
    if (error instanceof ProcessFailure) {
      if (error.kind === "timeout") {
        throw new GitError(`git ${args[0]} did not finish within ${timeoutMs} ms`);
      }
      if (error.kind === "overflow") {
        throw new GitError(`git ${args[0]} wrote more than ${Math.round(maxBuffer / 1024)} KiB`);
      }
      if (error.kind === "missing-directory") throw new GitError(`no such directory: ${cwd}`);
      // A missing executable or any other spawn failure is the original error, as before.
      throw error.cause ?? new GitError(`git ${args[0]} could not be started`);
    }
    throw error;
  }
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

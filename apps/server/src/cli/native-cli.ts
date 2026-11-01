import type { IssueProvider } from "@corral/protocol/rpc";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The one way Corral runs a native forge CLI (`gh`, `glab`) on the server host: bounded in time
 * and output, no prompts, no pager, no debug output, and no vendor token of the other provider in
 * the child's environment. The issue import (C0/a) and the pull-request calls (C6) share it so the
 * two cannot drift on what a CLI call inherits.
 */
const NATIVE_CLI_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const GITHUB_TOKEN_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
const GITLAB_TOKEN_ENV = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] as const;
const DEBUG_ENV = [
  "GH_DEBUG",
  "GLAB_DEBUG",
  "DEBUG",
  "GIT_TRACE",
  "GIT_TRACE_CURL",
  "GIT_CURL_VERBOSE",
  "GIT_TRACE_PACKET",
] as const;

/** How a native CLI call failed; the caller maps it to its own typed refusal. */
export type NativeCliFailureKind =
  /** The executable is not on the server's PATH. */
  | "missing"
  /** The working directory the call ran in is gone. */
  | "missing-directory"
  | "timeout"
  /** More stdout than the caller may buffer. */
  | "overflow"
  /** The caller's abort signal fired. */
  | "aborted"
  /** A non-zero exit; `exitCode` and `stderr` are the CLI's own. */
  | "failed";

/**
 * A native CLI call that did not answer. `stderr` is the CLI's raw text and is never forwarded to a
 * client: it can carry tokens, URLs or host output. Callers map the kind to their own error.
 */
export class NativeCliFailure extends Error {
  readonly kind: NativeCliFailureKind;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(options: {
    kind: NativeCliFailureKind;
    command: string;
    cwd: string;
    exitCode?: number | undefined;
    stderr?: string;
  }) {
    super(`native CLI ${options.command}: ${options.kind}`);
    this.kind = options.kind;
    this.command = options.command;
    this.cwd = options.cwd;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? "";
  }
}

/** Runs one native CLI call and resolves its stdout. */
export function runNativeCli(options: NativeCliOptions): Promise<string> {
  return runNativeCliResult(options).then((result) => {
    if (result.exitCode === 0) return result.stdout;
    throw new NativeCliFailure({
      kind: "failed",
      command: options.command,
      cwd: options.cwd,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  });
}

/**
 * A native CLI call whose non-zero exit is part of the answer: `gh pr checks` exits 1 (checks
 * failing) and 8 (checks pending), which is a report, not a failed read. Missing executables,
 * timeouts, overflow and an abort still reject.
 */
export function runNativeCliAllowingFailure(
  options: NativeCliOptions,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  return runNativeCliResult(options);
}

export interface NativeCliOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  provider: IssueProvider;
  /** Drops the operator's GitHub tokens for a host its own remote did not vouch for. */
  stripGitHubTokens: boolean;
  signal: AbortSignal | undefined;
  /** Written to the child's stdin, which is then closed; `--body-file -` and `--description-file -` read it. */
  stdin?: string;
}

/** The call itself: stdout, exit code and stderr, whatever the exit code was. */
function runNativeCliResult(
  options: NativeCliOptions,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const { command, args, cwd, timeoutMs, provider, stripGitHubTokens, signal, stdin } = options;
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    const child = execFile(
      command,
      args,
      {
        cwd,
        // Nothing may wait for a prompt, a pager, an update check or print a token in debug output.
        env: nativeCliEnvironment(provider, { stripGitHubTokens }),
        encoding: "utf8",
        maxBuffer: NATIVE_CLI_MAX_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        signal: controller.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!error) {
          resolve({ stdout, exitCode: 0, stderr });
          return;
        }
        if (timedOut) {
          reject(new NativeCliFailure({ kind: "timeout", command, cwd }));
          return;
        }
        if (signal?.aborted) {
          // Do not forward execFile's error: it can carry stderr with credentials.
          reject(new NativeCliFailure({ kind: "aborted", command, cwd }));
          return;
        }
        if (error.code === "ENOENT") {
          reject(
            new NativeCliFailure({
              kind: existsSync(cwd) ? "missing" : "missing-directory",
              command,
              cwd,
            }),
          );
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new NativeCliFailure({ kind: "overflow", command, cwd }));
          return;
        }
        // A non-zero exit is the CLI's answer: the two callers decide whether it is a failure.
        resolve({ stdout, exitCode: typeof error.code === "number" ? error.code : 1, stderr });
      },
    );
    // `--body-file -`/`--description-file -` read the body from stdin. A call with no body does not
    // touch the stream at all: writing EOF into a child that never spawned (a missing executable)
    // is a stream error the `execFile` callback already reports as the call's failure.
    if (stdin !== undefined && child.pid !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
    }
  });
}

/** The child's environment: no debug tracing, no other provider's token, no prompts or pager. */
export function nativeCliEnvironment(
  provider: IssueProvider,
  options: { stripGitHubTokens: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DEBUG_ENV) delete env[name];
  if (provider === "gitlab" || options.stripGitHubTokens) {
    for (const name of GITHUB_TOKEN_ENV) delete env[name];
  }
  if (provider === "github") {
    for (const name of GITLAB_TOKEN_ENV) delete env[name];
  }
  return {
    ...env,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    GLAB_NO_PROMPT: "1",
    GLAB_CHECK_UPDATE: "false",
    GLAB_PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
  };
}

/** Whether a failed call is the CLI's way of saying "no login for this host". */
export function isAuthFailure(
  provider: IssueProvider,
  exitCode: number | undefined,
  message: string,
): boolean {
  if (provider === "github") {
    // `gh help exit-codes`: 4 is "requires authentication".
    return (
      exitCode === 4 ||
      /gh auth login|authentication required|not logged (?:in|into)|requires authentication|\b401\s+Unauthorized\b|HTTP\s+401\b/i.test(
        message,
      )
    );
  }
  return /glab auth login|authentication required|not logged (?:in|into)|requires authentication|\b401\s+Unauthorized\b|HTTP\s+401\b|no token|authenticated host/i.test(
    message,
  );
}

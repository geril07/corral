import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  IssueAuthRequiredError,
  IssueCliMissingError,
  IssueFetchFailedError,
  IssueFetchTimeoutError,
  IssueHostUntrustedError,
} from "./errors.ts";
import { parseIssueOutput } from "./issue-output.ts";
import { parseIssueUrl, type IssueRef } from "./issue-url.ts";
import { isTrustedIssueHost } from "./trusted-hosts.ts";

export const DEFAULT_ISSUE_TIMEOUT_MS = 10_000;
const MAX_ISSUE_TIMEOUT_MS = 60_000;
const MIN_ISSUE_TIMEOUT_MS = 50;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEBUG_ENV = [
  "GH_DEBUG",
  "GLAB_DEBUG",
  "DEBUG",
  "GIT_TRACE",
  "GIT_TRACE_CURL",
  "GIT_CURL_VERBOSE",
  "GIT_TRACE_PACKET",
] as const;

/** A read-only issue lookup through the server host's own `gh` or `glab` login. */
export class IssueImportService {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_ISSUE_TIMEOUT_MS);
  }

  async resolve(
    projectPath: string,
    input: { url: string; provider?: IssueProvider | undefined },
    signal?: AbortSignal,
  ): Promise<TaskSource> {
    signal?.throwIfAborted();
    const ref = parseIssueUrl(input.url, input.provider);
    if (!(await isTrustedIssueHost(projectPath, ref, process.env)))
      throw new IssueHostUntrustedError(ref.provider, ref.host);
    signal?.throwIfAborted();
    const { command, args } = readCommand(ref);
    const stdout = await runReadOnlyCommand({
      command,
      args,
      cwd: projectPath,
      timeoutMs: this.#timeoutMs,
      provider: ref.provider,
      signal,
    });
    return parseIssueOutput(ref.provider, stdout, ref, Date.now());
  }
}

/** Reads the timeout override once at server start; tests set it to keep timeouts short. */
export function issueImportTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env["CORRAL_ISSUE_IMPORT_TIMEOUT_MS"]);
  return Number.isFinite(value) && value > 0 ? clampTimeout(value) : DEFAULT_ISSUE_TIMEOUT_MS;
}

function clampTimeout(value: number): number {
  return Math.min(Math.max(Math.floor(value), MIN_ISSUE_TIMEOUT_MS), MAX_ISSUE_TIMEOUT_MS);
}

function readCommand(ref: IssueRef): { command: string; args: string[] } {
  if (ref.provider === "github") {
    return {
      command: "gh",
      args: [
        "issue",
        "view",
        ref.url,
        `--repo=${ref.host}/${ref.repository}`,
        "--json=number,title,body,url",
      ],
    };
  }
  return { command: "glab", args: ["issue", "view", ref.url, "--output=json"] };
}

function runReadOnlyCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  provider: IssueProvider;
  signal: AbortSignal | undefined;
}): Promise<string> {
  const { command, args, cwd, timeoutMs, provider, signal } = options;
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

    execFile(
      command,
      args,
      {
        cwd,
        // Nothing may wait for a prompt, a pager, an update check or print a token in debug output.
        env: childEnvironment(),
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        signal: controller.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!error) {
          resolve(stdout);
          return;
        }
        if (timedOut) {
          reject(new IssueFetchTimeoutError(provider));
          return;
        }
        if (signal?.aborted) {
          reject(error);
          return;
        }
        if (error.code === "ENOENT") {
          reject(
            existsSync(cwd) ? new IssueCliMissingError(command) : missingDirectory(provider, cwd),
          );
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new IssueFetchFailedError(provider, "The issue tool returned too much output."));
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : undefined;
        reject(
          isAuthFailure(provider, exitCode, stderr)
            ? new IssueAuthRequiredError(provider)
            : new IssueFetchFailedError(provider, failureMessage(stderr)),
        );
      },
    );
  });
}

function missingDirectory(provider: IssueProvider, cwd: string): IssueFetchFailedError {
  return new IssueFetchFailedError(provider, `The project directory is gone: ${cwd}`);
}

function isAuthFailure(
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

/** Never forward CLI text: it can carry tokens, URLs or host output. */
function failureMessage(stderr: string): string {
  if (/\b404\b|not found|could not resolve|no such issue/i.test(stderr))
    return "The issue was not found.";
  if (
    /dial tcp|no such host|connection refused|network is unreachable|TLS|certificate|timed? out|timeout/i.test(
      stderr,
    )
  )
    return "Could not reach the issue host.";
  return "The issue tool failed.";
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DEBUG_ENV) delete env[name];
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

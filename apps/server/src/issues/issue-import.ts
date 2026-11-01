import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { isAuthFailure, NativeCliFailure, runNativeCli } from "../cli/native-cli.ts";
import {
  IssueAuthRequiredError,
  IssueCliMissingError,
  IssueFetchFailedError,
  IssueFetchTimeoutError,
  IssueHostUntrustedError,
} from "./errors.ts";
import { parseIssueOutput } from "./issue-output.ts";
import { parseIssueUrl, type IssueRef } from "./issue-url.ts";
import { issueHostTrust } from "./trusted-hosts.ts";

export const DEFAULT_ISSUE_TIMEOUT_MS = 10_000;
const MAX_ISSUE_TIMEOUT_MS = 60_000;
const MIN_ISSUE_TIMEOUT_MS = 50;

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
    const trust = await issueHostTrust(projectPath, ref, process.env);
    if (trust === undefined) throw new IssueHostUntrustedError(ref.provider, ref.host);
    signal?.throwIfAborted();
    const { command, args } = readCommand(ref);
    const stdout = await runReadOnlyCommand({
      command,
      args,
      cwd: projectPath,
      timeoutMs: this.#timeoutMs,
      provider: ref.provider,
      // A project remote alone does not bind the operator's global GitHub tokens to that vendor.
      // Only GH_HOST-bound (or public) GitHub hosts keep them; host-scoped CLI auth still applies.
      stripGitHubTokens: ref.provider === "github" && !trust.publicHost && !trust.operatorHost,
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
  stripGitHubTokens: boolean;
  signal: AbortSignal | undefined;
}): Promise<string> {
  const { command, args, cwd, timeoutMs, provider, stripGitHubTokens, signal } = options;
  return runNativeCli({
    command,
    args,
    cwd,
    timeoutMs,
    provider,
    stripGitHubTokens,
    signal,
  }).catch((error: unknown) => {
    if (!(error instanceof NativeCliFailure)) throw error;
    switch (error.kind) {
      case "aborted":
        throw new DOMException("The issue import was cancelled.", "AbortError");
      case "timeout":
        throw new IssueFetchTimeoutError(provider);
      case "overflow":
        throw new IssueFetchFailedError(provider, "The issue tool returned too much output.");
      case "missing":
        throw new IssueCliMissingError(command);
      case "missing-directory":
        throw missingDirectory(provider, cwd);
      case "failed":
        if (isAuthFailure(provider, error.exitCode, error.stderr)) {
          throw new IssueAuthRequiredError(provider);
        }
        throw new IssueFetchFailedError(provider, failureMessage(error.stderr));
    }
  });
}

function missingDirectory(provider: IssueProvider, cwd: string): IssueFetchFailedError {
  return new IssueFetchFailedError(provider, `The project directory is gone: ${cwd}`);
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

import type { IssueProvider, PullRequestChecks, PullRequestState } from "@corral/protocol/rpc";
import { z } from "zod";
import {
  isAuthFailure,
  NativeCliFailure,
  runNativeCli,
  runNativeCliAllowingFailure,
} from "../cli/native-cli.ts";
import {
  PullRequestAuthRequiredError,
  PullRequestCliMissingError,
  PullRequestFailedError,
  PullRequestInvalidResponseError,
} from "./errors.ts";

/**
 * The `gh`/`glab` calls behind a task's pull or merge request, shaped like the issue import next
 * door: a fixed argv per provider, `execFile` with a deadline and no prompts, and the answer parsed
 * by a schema rather than by string surgery. Credentials are the server host's own CLI login; the
 * only token handling is the shared rule that the other vendor's tokens do not travel along.
 */
export const DEFAULT_PULL_REQUEST_TIMEOUT_MS = 20_000;

/** What a create or a read answered, before it is stored on the task. */
export interface PullRequestSnapshot {
  provider: IssueProvider;
  host: string;
  number: number;
  url: string;
  title: string;
  branch: string | null;
  base: string | null;
  state: PullRequestState;
  stateReason: string | null;
  checks: PullRequestChecks | null;
  fetchedAt: number | null;
}

export interface PullRequestCallOptions {
  provider: IssueProvider;
  /** The task's workspace: the CLI resolves its repository from the git remote there. */
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  /** A GitHub token is dropped when the project's remote did not vouch for the host. */
  stripGitHubTokens: boolean;
}

const GhView = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  baseRefName: z.string().optional(),
  headRefName: z.string().optional(),
});

const GhCheck = z.object({
  bucket: z.string(),
  name: z.string().optional(),
  state: z.string().optional(),
});

const GlabView = z.object({
  iid: z.number().int().positive(),
  web_url: z.string().min(1),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
});

/** `gh pr create --base <base> --head <branch> --title <t> --body-file -`, body on stdin. */
export function createCommand(input: {
  provider: IssueProvider;
  branch: string;
  base: string;
  title: string;
  draft: boolean;
}): { command: string; args: string[] } {
  if (input.provider === "github") {
    return {
      command: "gh",
      args: [
        "pr",
        "create",
        "--base",
        input.base,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body-file",
        "-",
        ...(input.draft ? ["--draft"] : []),
      ],
    };
  }
  return {
    command: "glab",
    args: [
      "mr",
      "create",
      "--title",
      input.title,
      "--description-file",
      "-",
      "--source-branch",
      input.branch,
      "--target-branch",
      input.base,
      "--yes",
      ...(input.draft ? ["--draft"] : []),
    ],
  };
}

/** `gh pr view --json …` / `glab mr view -F json`: the current branch's request, no host named. */
export function viewCommand(provider: IssueProvider): { command: string; args: string[] } {
  return provider === "github"
    ? {
        command: "gh",
        args: [
          "pr",
          "view",
          "--json",
          "number,url,title,state,isDraft,baseRefName,headRefName,statusCheckRollup",
        ],
      }
    : { command: "glab", args: ["mr", "view", "-F", "json"] };
}

/** `gh pr checks --json bucket,name,state`; GitLab reports no per-check list to Corral. */
export function checksCommand(
  provider: IssueProvider,
): { command: string; args: string[] } | undefined {
  return provider === "github"
    ? { command: "gh", args: ["pr", "checks", "--json", "bucket,name,state"] }
    : undefined;
}

/** The URL a create printed, used when the follow-up read cannot answer. */
export function createdUrl(stdout: string, provider: IssueProvider): string | undefined {
  const pattern =
    provider === "github" ? /https?:\/\/\S+\/pull\/\d+/ : /https?:\/\/\S+\/-\/merge_requests\/\d+/;
  for (const line of stdout.split("\n")) {
    const match = pattern.exec(line.trim());
    if (match !== null) return match[0];
  }
  return undefined;
}

function stateOf(provider: IssueProvider, raw: string, draft: boolean): PullRequestState {
  const state = raw.trim().toUpperCase();
  if (state === "OPEN" || state === "OPENED") return draft ? "draft" : "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "unknown";
}

/** The provider's state word when Corral does not know it: the reason the row says `unknown`. */
function unknownStateReason(provider: IssueProvider, raw: string): string {
  return `the ${provider === "github" ? "GitHub" : "GitLab"} CLI reported the state "${raw}", which Corral does not know`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Parses `gh pr view` and `gh pr checks`, or their GitLab equivalents. */
export function parsePullRequest(
  provider: IssueProvider,
  stdout: string,
  checksStdout: string | undefined,
  now: number,
): PullRequestSnapshot {
  const raw: unknown = JSON.parse(stdout);
  if (provider === "github") {
    const view = GhView.safeParse(raw);
    if (!view.success) throw new PullRequestInvalidResponseError(provider);
    const host = hostOf(view.data.url);
    if (host === undefined) throw new PullRequestInvalidResponseError(provider);
    const state = stateOf(provider, view.data.state, view.data.isDraft === true);
    return {
      provider,
      host,
      number: view.data.number,
      url: view.data.url,
      title: view.data.title,
      branch: view.data.headRefName ?? null,
      base: view.data.baseRefName ?? null,
      state,
      stateReason: state === "unknown" ? unknownStateReason(provider, view.data.state) : null,
      checks: checksStdout === undefined ? null : parseChecks(checksStdout),
      fetchedAt: now,
    };
  }
  const view = GlabView.safeParse(raw);
  if (!view.success) throw new PullRequestInvalidResponseError(provider);
  const host = hostOf(view.data.web_url);
  if (host === undefined) throw new PullRequestInvalidResponseError(provider);
  const state = stateOf(provider, view.data.state, view.data.draft === true);
  return {
    provider,
    host,
    number: view.data.iid,
    url: view.data.web_url,
    title: view.data.title,
    branch: view.data.source_branch ?? null,
    base: view.data.target_branch ?? null,
    state,
    stateReason: state === "unknown" ? unknownStateReason(provider, view.data.state) : null,
    checks: null,
    fetchedAt: now,
  };
}

/** A check summary from `gh pr checks --json bucket,name,state`; `null` when there is no check. */
export function parseChecks(stdout: string): PullRequestChecks | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const checks: PullRequestChecks = { total: 0, passing: 0, failing: 0, pending: 0, skipped: 0 };
  for (const entry of parsed) {
    const check = GhCheck.safeParse(entry);
    if (!check.success) continue;
    checks.total += 1;
    switch (check.data.bucket) {
      case "pass":
        checks.passing += 1;
        break;
      case "fail":
        checks.failing += 1;
        break;
      case "skipping":
      case "cancel":
        checks.skipped += 1;
        break;
      default:
        checks.pending += 1;
    }
  }
  return checks.total === 0 ? null : checks;
}

/** Opens the request and reads what the CLI reports about it. */
export async function createPullRequest(
  options: PullRequestCallOptions & {
    branch: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  },
): Promise<PullRequestSnapshot> {
  const { command, args } = createCommand(options);
  let stdout: string;
  try {
    stdout = await runNativeCli({
      command,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      provider: options.provider,
      stripGitHubTokens: options.stripGitHubTokens,
      signal: options.signal,
      stdin: options.body,
    });
  } catch (error) {
    throw refusal(options.provider, command, error);
  }
  try {
    return await readPullRequest(options);
  } catch (error) {
    // The create itself succeeded; a read that fails leaves the link from its own output.
    const url = createdUrl(stdout, options.provider);
    const host = url === undefined ? undefined : hostOf(url);
    if (url === undefined || host === undefined) throw error;
    const number = /(\d+)\s*$/.exec(url)?.[1];
    return {
      provider: options.provider,
      host,
      number: Number(number ?? 0),
      url,
      title: options.title,
      branch: options.branch,
      base: options.base,
      // A link that was just created is at least open; a read that failed says nothing about it,
      // and this snapshot is only used for a create that already answered with its URL.
      state: options.draft ? "draft" : "open",
      stateReason: null,
      checks: null,
      fetchedAt: Date.now(),
    };
  }
}

/** The current state of the branch's request, as the CLI reports it now. */
export async function readPullRequest(
  options: PullRequestCallOptions,
): Promise<PullRequestSnapshot> {
  const view = viewCommand(options.provider);
  let stdout: string;
  try {
    stdout = await runNativeCli({
      command: view.command,
      args: view.args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      provider: options.provider,
      stripGitHubTokens: options.stripGitHubTokens,
      signal: options.signal,
    });
  } catch (error) {
    throw refusal(options.provider, view.command, error);
  }
  const checks = checksCommand(options.provider);
  let checksStdout: string | undefined;
  if (checks !== undefined) {
    // `gh pr checks` exits non-zero when checks fail or are pending: a report, not a failed read.
    const result = await runNativeCliAllowingFailure({
      command: checks.command,
      args: checks.args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      provider: options.provider,
      stripGitHubTokens: options.stripGitHubTokens,
      signal: options.signal,
    }).catch(() => undefined);
    checksStdout = result?.stdout;
  }
  try {
    return parsePullRequest(options.provider, stdout, checksStdout, Date.now());
  } catch (error) {
    if (error instanceof PullRequestInvalidResponseError) throw error;
    throw new PullRequestInvalidResponseError(options.provider);
  }
}

/** A sentence for the `unknown` state a failed read leaves behind; never claims the request closed. */
export function describeReadFailure(error: unknown): string {
  if (error instanceof PullRequestAuthRequiredError) {
    return `the server's ${error.provider === "github" ? "GitHub" : "GitLab"} CLI is not logged in`;
  }
  if (error instanceof PullRequestCliMissingError) {
    return `${error.command} is not on the server's PATH`;
  }
  if (error instanceof PullRequestInvalidResponseError) {
    return "the CLI returned something Corral could not read";
  }
  if (error instanceof PullRequestFailedError) return error.message;
  if (error instanceof NativeCliFailure) {
    return error.kind === "timeout" ? "the CLI did not answer in time" : "the CLI call failed";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Maps the shared runner's failure onto this caller's typed refusals. */
function refusal(provider: IssueProvider, command: string, error: unknown): Error {
  if (!(error instanceof NativeCliFailure))
    return error instanceof Error ? error : new Error(String(error));
  switch (error.kind) {
    case "missing":
      return new PullRequestCliMissingError(command);
    case "missing-directory":
      return new PullRequestFailedError(provider, `the task's workspace is gone: ${error.cwd}`);
    case "timeout":
      return new PullRequestFailedError(provider, "The CLI did not answer in time.");
    case "overflow":
      return new PullRequestInvalidResponseError(provider);
    case "aborted":
      return new PullRequestFailedError(provider, "The call was cancelled.");
    case "failed":
      if (isAuthFailure(provider, error.exitCode, error.stderr)) {
        return new PullRequestAuthRequiredError(provider);
      }
      return new PullRequestFailedError(provider, failureSentence(provider, error.stderr));
    default:
      return new PullRequestFailedError(provider, "The CLI failed.");
  }
}

function failureSentence(provider: IssueProvider, stderr: string): string {
  const name = provider === "github" ? "GitHub" : "GitLab";
  if (/\b404\b|not found|could not resolve to a pull request|no merge request/i.test(stderr)) {
    return "The request was not found.";
  }
  if (
    /dial tcp|no such host|connection refused|network is unreachable|TLS|certificate|timed? out|timeout/i.test(
      stderr,
    )
  ) {
    return `Could not reach ${name}.`;
  }
  return `The ${name} CLI failed.`;
}

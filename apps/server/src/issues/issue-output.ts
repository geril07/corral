import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { z } from "zod";
import { IssueFetchFailedError, IssueResponseInvalidError } from "./errors.ts";
import { parseIssueUrl, type IssueRef } from "./issue-url.ts";

const MAX_BODY_CHARS = 1024 * 1024;
const PULL_REQUEST_MESSAGE =
  "That URL is a pull request, not an issue. Import an issue URL or create the task manually.";

const GitHubIssue = z.object({
  number: z.number().int().positive(),
  title: z.string().trim().min(1).max(1024),
  body: z.string().max(MAX_BODY_CHARS).nullable().optional(),
  url: z.string().min(1).max(2048),
});

const GitLabIssue = z.object({
  iid: z.number().int().positive(),
  title: z.string().trim().min(1).max(1024),
  description: z.string().max(MAX_BODY_CHARS).nullable().optional(),
  web_url: z.string().min(1).max(2048),
});

type GitHubIssue = z.infer<typeof GitHubIssue>;
type GitLabIssue = z.infer<typeof GitLabIssue>;

/**
 * Turns `gh issue view --json` or `glab issue view --output=json` output into our snapshot.
 * Everything here is untrusted: only the documented fields are read, the issue number must be
 * the one that was asked for, and the URL comes from our own validated reference.
 */
export function parseIssueOutput(
  provider: IssueProvider,
  text: string,
  ref: IssueRef,
  fetchedAt: number,
): TaskSource {
  const issue = provider === "github" ? parseGitHub(text, ref) : parseGitLab(text, ref);
  return {
    provider,
    host: ref.host,
    repository: ref.repository,
    number: ref.number,
    url: ref.url,
    title: issue.title,
    body: issue.body,
    fetchedAt,
  };
}

function parseGitHub(text: string, ref: IssueRef): { title: string; body: string } {
  const parsed = GitHubIssue.safeParse(parseJson(text));
  if (!parsed.success) throw new IssueResponseInvalidError("github");
  if (isPullRequestUrl(parsed.data.url, "github")) throw pullRequestRefusal("github");
  if (parsed.data.number !== ref.number || !sameIdentity(parsed.data.url, ref, "github"))
    throw new IssueResponseInvalidError("github");
  return { title: parsed.data.title, body: parsed.data.body ?? "" };
}

function parseGitLab(text: string, ref: IssueRef): { title: string; body: string } {
  const parsed = GitLabIssue.safeParse(parseJson(text));
  if (!parsed.success) throw new IssueResponseInvalidError("gitlab");
  if (isPullRequestUrl(parsed.data.web_url, "gitlab")) throw pullRequestRefusal("gitlab");
  if (parsed.data.iid !== ref.number || !sameIdentity(parsed.data.web_url, ref, "gitlab"))
    throw new IssueResponseInvalidError("gitlab");
  return { title: parsed.data.title, body: parsed.data.description ?? "" };
}

/**
 * `gh issue view` succeeds on a number that is a pull request and answers with the `/pull/` URL.
 * That is a fact about the URL, not an unreadable answer, so it uses the fetch error's message
 * channel rather than adding a contract error.
 */
function isPullRequestUrl(value: string, provider: IssueProvider): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  return provider === "github"
    ? segments.length === 4 && segments[2] === "pull"
    : segments.at(-2) === "merge_requests";
}

function pullRequestRefusal(provider: IssueProvider): IssueFetchFailedError {
  return new IssueFetchFailedError(provider, PULL_REQUEST_MESSAGE);
}

/** The returned URL must name the same host, repository and issue that was requested. */
function sameIdentity(returnedUrl: string, ref: IssueRef, provider: IssueProvider): boolean {
  try {
    const returned = parseIssueUrl(returnedUrl, provider);
    return (
      returned.host === ref.host &&
      sameRepository(provider, returned.repository, ref.repository) &&
      returned.number === ref.number
    );
  } catch {
    return false;
  }
}

/** GitHub owner/repo names are case-insensitive; GitLab paths stay exact until its rules are verified. */
function sameRepository(provider: IssueProvider, left: string, right: string): boolean {
  return provider === "github" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

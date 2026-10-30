import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { z } from "zod";
import { IssueResponseInvalidError } from "./errors.ts";
import { parseIssueUrl, type IssueRef } from "./issue-url.ts";

const MAX_BODY_CHARS = 1024 * 1024;

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
  if (
    !parsed.success ||
    parsed.data.number !== ref.number ||
    !sameIdentity(parsed.data.url, ref, "github")
  )
    throw new IssueResponseInvalidError("github");
  return { title: parsed.data.title, body: parsed.data.body ?? "" };
}

function parseGitLab(text: string, ref: IssueRef): { title: string; body: string } {
  const parsed = GitLabIssue.safeParse(parseJson(text));
  if (
    !parsed.success ||
    parsed.data.iid !== ref.number ||
    !sameIdentity(parsed.data.web_url, ref, "gitlab")
  )
    throw new IssueResponseInvalidError("gitlab");
  return { title: parsed.data.title, body: parsed.data.description ?? "" };
}

/** The returned URL must name the same host, repository and issue that was requested. */
function sameIdentity(returnedUrl: string, ref: IssueRef, provider: IssueProvider): boolean {
  try {
    const returned = parseIssueUrl(returnedUrl, provider);
    return (
      returned.host === ref.host &&
      returned.repository === ref.repository &&
      returned.number === ref.number
    );
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

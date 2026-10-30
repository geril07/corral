import type { IssueProvider } from "@corral/protocol/rpc";
import {
  InvalidIssueUrlError,
  IssueProviderRequiredError,
  IssueUnsupportedPortError,
} from "./errors.ts";

/** The validated identity of an issue URL; every part that reaches a CLI comes from here. */
export interface IssueRef {
  provider: IssueProvider;
  /** `URL.host`: hostname and, when given, port. */
  host: string;
  /** `OWNER/REPO` for GitHub, the project path for GitLab. */
  repository: string;
  number: number;
  /** Rebuilt from the validated parts, without query, fragment or credentials. */
  url: string;
}

const SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const NUMBER = /^\d{1,10}$/;
const MAX_ISSUE_NUMBER = 2_147_483_647;

/**
 * Validates a pasted issue URL and decides which provider it belongs to. `github.com` and
 * `*.ghe.com` are GitHub, `gitlab.com` is GitLab; any other host is only trusted when the caller
 * names its provider, because a self-hosted hostname alone does not say which product it runs.
 */
export function parseIssueUrl(input: string, selected?: IssueProvider): IssueRef {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidIssueUrlError("This is not an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new InvalidIssueUrlError("Issue URLs must start with http:// or https://.");
  if (url.username !== "" || url.password !== "")
    throw new InvalidIssueUrlError("Issue URLs must not carry credentials.");

  const hostname = url.hostname;
  if (!HOSTNAME.test(hostname) || hostname.includes(".."))
    throw new InvalidIssueUrlError("The issue URL's host is not a plain hostname.");

  const known = knownProvider(hostname);
  if (selected !== undefined && known !== undefined && selected !== known)
    throw new InvalidIssueUrlError(
      `This host is ${providerName(known)}, not ${providerName(selected)}.`,
    );
  if (selected === undefined && known === undefined) throw new IssueProviderRequiredError(url.host);
  const provider = selected ?? known!;
  if (provider === "github" && url.port !== "")
    throw new IssueUnsupportedPortError(provider, url.host);

  const parts = pathSegments(url);
  const parsed = provider === "github" ? githubParts(parts) : gitlabParts(parts);
  const number = issueNumber(parsed.number);
  const base = `${url.protocol}//${url.host}`;
  const path =
    provider === "github"
      ? `/${parsed.repository}/issues/${number}`
      : `/${parsed.repository}/-/issues/${number}`;
  return { provider, host: url.host, repository: parsed.repository, number, url: `${base}${path}` };
}

/** The provider a public host belongs to; `undefined` means it needs an explicit, trusted choice. */
export function publicProviderForHost(hostname: string): IssueProvider | undefined {
  return knownProvider(hostname);
}

function knownProvider(hostname: string): IssueProvider | undefined {
  if (hostname === "github.com" || hostname.endsWith(".ghe.com")) return "github";
  if (hostname === "gitlab.com") return "gitlab";
  return undefined;
}

function providerName(provider: IssueProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

function pathSegments(url: URL): string[] {
  const raw = url.pathname.split("/").slice(1);
  if (raw.at(-1) === "") raw.pop();
  if (raw.length === 0) throw new InvalidIssueUrlError("The URL has no issue path.");
  return raw.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new InvalidIssueUrlError("The URL has an invalid escape sequence.");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      (decoded.startsWith("-") && decoded !== "-") ||
      !SEGMENT.test(decoded)
    )
      throw new InvalidIssueUrlError(
        "Issue URL parts may only contain letters, digits, dots, underscores and dashes.",
      );
    return decoded;
  });
}

function githubParts(parts: string[]): { repository: string; number: string } {
  if (parts.length !== 4 || parts[2] !== "issues" || parts[0] === "-" || parts[1] === "-")
    throw new InvalidIssueUrlError(
      "GitHub issue URLs look like https://github.com/OWNER/REPO/issues/NUMBER.",
    );
  return { repository: `${parts[0]}/${parts[1]}`, number: parts[3]! };
}

function gitlabParts(parts: string[]): { repository: string; number: string } {
  const repository = parts.slice(0, -3);
  const kind = parts.at(-2);
  if (
    parts.length < 5 ||
    parts.at(-3) !== "-" ||
    (kind !== "issues" && kind !== "work_items") ||
    repository.includes("-")
  )
    throw new InvalidIssueUrlError(
      "GitLab issue URLs look like https://gitlab.com/GROUP/PROJECT/-/issues/NUMBER or /-/work_items/NUMBER.",
    );
  return { repository: repository.join("/"), number: parts.at(-1)! };
}

function issueNumber(text: string): number {
  if (!NUMBER.test(text)) throw new InvalidIssueUrlError("The issue number must be digits only.");
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_ISSUE_NUMBER)
    throw new InvalidIssueUrlError("The issue number is out of range.");
  return number;
}

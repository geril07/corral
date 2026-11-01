import type { PullRequest } from "@corral/protocol/rpc";
import { Button } from "../../common/ui/index.ts";
import { openWebLink } from "../../common/lib/open-web-link.ts";

/** "PR #7" for GitHub, "MR !12" for GitLab: the provider's own word for a merge request. */
export function pullRequestName(request: PullRequest): string {
  return request.provider === "github" ? `PR #${request.number}` : `MR !${request.number}`;
}

/** The check summary in words; nothing when the provider reported no checks. */
export function pullRequestChecks(request: PullRequest): string | undefined {
  const checks = request.checks;
  if (checks === null || checks.total === 0) return undefined;
  const parts = [
    checks.passing > 0 ? `${checks.passing} passing` : undefined,
    checks.failing > 0 ? `${checks.failing} failing` : undefined,
    checks.pending > 0 ? `${checks.pending} running` : undefined,
    checks.skipped > 0 ? `${checks.skipped} skipped` : undefined,
  ].filter((part) => part !== undefined);
  return `${checks.total} ${checks.total === 1 ? "check" : "checks"}: ${parts.join(", ")}`;
}

/**
 * One line for the header, the sidebar row and the Changes tab: the request's name, its state, and
 * for `unknown` the reason instead of a state — a read that failed never reads as closed.
 */
export function pullRequestText(request: PullRequest): string {
  const name = pullRequestName(request);
  if (request.state === "unknown") {
    return `${name} state unknown — ${request.stateReason ?? "the state could not be read"}`;
  }
  return `${name} ${request.state}`;
}

/** The compact form a sidebar row carries: `PR #7 open`, `MR !12 unknown`. */
export function pullRequestShortText(request: PullRequest): string {
  return `${pullRequestName(request)} ${request.state}`;
}

/** The one-sentence explanation a hover or an accessible name carries. */
export function pullRequestTitle(request: PullRequest): string {
  const checks = pullRequestChecks(request);
  const base = [pullRequestText(request), checks, request.url].filter((part) => part !== undefined);
  return base.join(" · ");
}

/**
 * The task header's and the Changes tab's badge (`layout.md`, **Task header**): the request's name
 * and state, opening the forge page in the OS browser. It is a button, not an anchor, because the
 * link must never load in the capability-bearing window (`docs/design.md`, **Local trust
 * boundary**), and a copy of the URL is what the title shows.
 */
export function PullRequestBadge({ request }: { request: PullRequest }) {
  return (
    <Button
      variant="secondary"
      size="xs"
      aria-label={pullRequestTitle(request)}
      title={pullRequestTitle(request)}
      onClick={() => openWebLink(request.url)}
    >
      <span className="max-w-40 truncate">{pullRequestText(request)}</span>
    </Button>
  );
}

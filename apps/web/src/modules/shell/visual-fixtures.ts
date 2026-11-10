import type { VisualTaskRow } from "../../common/ui/index.ts";

/**
 * Rare visual states for the review host. These are fixture rows rendered through the same
 * `VisualShellView` as production; they never enter the server's task list.
 */
export const VISUAL_REVIEW_ROWS: readonly VisualTaskRow[] = [
  {
    id: "fixture-blocked",
    workspacePath: "/home/dev/.dev/worktrees/orbit/fix-oauth-token-refresh",
    hasSource: true,
    copyBranch: "fix/oauth-token-refresh",
    title: "Fix OAuth callback token refresh on rotated credentials",
    project: "orbit",
    projectInitial: "O",
    status: {
      tone: "blocked",
      label: "Blocked",
      time: "2m",
      message: "The agent is waiting for permission to run the database migration.",
    },
    metadata: {
      project: "orbit",
      branch: "fix/oauth-token-refresh",
      agent: { kind: "pi", provider: "anthropic", model: "claude-sonnet-4-5" },
      prompt:
        "Refresh rotated OAuth credentials in the callback without dropping the pending upload.",
    },
  },
  {
    id: "fixture-error",
    workspacePath:
      "/home/dev/.dev/worktrees/open-telemetry-collector-contrib/fix-upload-retry-pipeline",
    hasSource: false,
    copyBranch: "fix/upload-retry-pipeline",
    title: "Investigate the flaky image upload retry pipeline",
    project: "open-telemetry-collector-contrib",
    projectInitial: "O",
    status: {
      tone: "error",
      label: "Error",
      time: "1h",
      message: "The agent could not reach the local image service.",
    },
    metadata: {
      project: "open-telemetry-collector-contrib",
      branch: "fix/upload-retry-pipeline",
      agent: { kind: "claude" },
    },
  },
  {
    id: "fixture-done-unseen",
    workspacePath: "/home/dev/.dev/worktrees/atlas/feat-billing-export-endpoint",
    hasSource: false,
    copyBranch: "feat/billing-export-endpoint",
    title: "Ship the new billing export endpoint",
    project: "atlas",
    projectInitial: "A",
    status: { tone: "done", label: "Done", time: "4m" },
    metadata: {
      project: "atlas",
      branch: "feat/billing-export-endpoint",
      agent: { kind: "opencode" },
    },
  },
  {
    id: "fixture-working",
    workspacePath: "/home/dev/.dev/worktrees/orbit/refactor-session-reconnect-handshake",
    hasSource: false,
    copyBranch: "refactor/session-reconnect-handshake",
    title:
      "Refactor the terminal session reconnect handshake and exponential backoff while keeping the snapshot replay contract intact",
    project: "orbit",
    projectInitial: "O",
    status: { tone: "working", label: "Working" },
    metadata: {
      project: "orbit",
      branch: "refactor/session-reconnect-handshake",
      agent: { kind: "codex", provider: "openai", model: "gpt-5-codex" },
    },
  },
  {
    id: "fixture-done-seen",
    workspacePath: "/home/dev/.dev/worktrees/atlas/chore-upload-modal",
    hasSource: false,
    copyBranch: "chore/upload-modal",
    title: "Migrate the legacy upload modal to the shared dialog",
    project: "atlas",
    projectInitial: "A",
    status: { tone: "neutral", muted: true, time: "2h" },
    metadata: {
      project: "atlas",
      branch: "chore/upload-modal",
      agent: { kind: "pi", provider: "openrouter", model: "anthropic/claude-sonnet-4" },
    },
  },
  {
    id: "fixture-idle",
    workspacePath: "/home/dev/.dev/worktrees/orbit/chore-workspace-cache",
    hasSource: false,
    copyBranch: "chore/workspace-cache",
    title: "Trace the stale workspace cache invalidation",
    project: "orbit",
    projectInitial: "O",
    status: { tone: "neutral", muted: true, time: "6h" },
    metadata: {
      project: "orbit",
      branch: "chore/workspace-cache",
      agent: { kind: "codex" },
    },
  },
  {
    id: "fixture-no-status",
    workspacePath: "/home/dev/.dev/worktrees/atlas/docs-onboarding",
    hasSource: false,
    copyBranch: "docs/onboarding",
    title: "Update contributor onboarding notes",
    project: "atlas",
    projectInitial: "A",
    metadata: {
      project: "atlas",
      branch: "docs/onboarding",
    },
  },
];

export const VISUAL_REVIEW_SELECTED = "fixture-blocked";

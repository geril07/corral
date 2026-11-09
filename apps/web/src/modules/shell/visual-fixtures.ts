import type { VisualTaskRow } from "../../common/ui/index.ts";

/**
 * Rare visual states for the review host. These are fixture rows rendered through the same
 * `VisualShellView` as production; they never enter the server's task list.
 */
export const VISUAL_REVIEW_ROWS: readonly VisualTaskRow[] = [
  {
    id: "fixture-blocked",
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
      workspace: "/home/me/code/worktrees/orbit/fix-oauth-token-refresh",
      agent: "pi",
      status:
        "blocked · permission — The agent is waiting for permission to run the database migration.",
      prompt:
        "Refresh rotated OAuth credentials in the callback without dropping the pending upload.",
    },
  },
  {
    id: "fixture-error",
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
      workspace:
        "/home/me/code/worktrees/open-telemetry-collector-contrib/fix-upload-retry-pipeline",
      agent: "claude",
      status: "error — The agent could not reach the local image service.",
    },
  },
  {
    id: "fixture-done-unseen",
    title: "Ship the new billing export endpoint",
    project: "atlas",
    projectInitial: "A",
    status: { tone: "done", label: "Done", time: "4m" },
    metadata: {
      project: "atlas",
      branch: "feat/billing-export-endpoint",
      workspace: "/home/me/code/worktrees/atlas/feat-billing-export-endpoint",
      agent: "opencode",
      status: "done",
    },
  },
  {
    id: "fixture-working",
    title:
      "Refactor the terminal session reconnect handshake and exponential backoff while keeping the snapshot replay contract intact",
    project: "orbit",
    projectInitial: "O",
    status: { tone: "working", label: "Working" },
    metadata: {
      project: "orbit",
      branch: "refactor/session-reconnect-handshake",
      workspace: "/home/me/code/worktrees/orbit/refactor-session-reconnect-handshake",
      agent: "codex",
      status: "working",
    },
  },
  {
    id: "fixture-done-seen",
    title: "Migrate the legacy upload modal to the shared dialog",
    project: "atlas",
    projectInitial: "A",
    status: { tone: "neutral", muted: true, time: "2h" },
    metadata: {
      project: "atlas",
      branch: "chore/upload-modal",
      workspace: "/home/me/code/worktrees/atlas/chore-upload-modal",
      agent: "pi",
      status: "done",
    },
  },
  {
    id: "fixture-idle",
    title: "Trace the stale workspace cache invalidation",
    project: "orbit",
    projectInitial: "O",
    status: { tone: "neutral", muted: true, time: "6h" },
    metadata: {
      project: "orbit",
      branch: "chore/workspace-cache",
      workspace: "/home/me/code/worktrees/orbit/chore-workspace-cache",
      agent: "codex",
      status: "idle",
    },
  },
  {
    id: "fixture-no-status",
    title: "Update contributor onboarding notes",
    project: "atlas",
    projectInitial: "A",
    metadata: {
      project: "atlas",
      branch: "docs/onboarding",
      workspace: "/home/me/code/worktrees/atlas/docs-onboarding",
    },
  },
];

export const VISUAL_REVIEW_SELECTED = "fixture-blocked";

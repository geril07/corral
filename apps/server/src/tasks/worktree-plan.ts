import type { CreateTaskInput } from "@corral/protocol/rpc";
import { branchNameTaken, slugifyTitle, uniqueName } from "../git/names.ts";

export interface BranchCatalog {
  local: readonly string[];
  remote: readonly string[];
}

/** How a task's worktree gets its branch. */
export type WorktreePlan =
  | { kind: "new-branch"; branch: string; base: string }
  /** `remoteBranch` is `origin/x`; the new local branch `branch` tracks it. */
  | { kind: "track-remote"; branch: string; remoteBranch: string }
  | { kind: "existing-branch"; branch: string };

export type PlanFailure = { problem: string };

/** What to do for a `new-branch` or `existing-branch` workspace; `main-worktree` has no plan. */
export function planWorktree(
  workspace: Exclude<CreateTaskInput["workspace"], { type: "main-worktree" }>,
  context: { title: string; defaultBaseBranch: string; branches: BranchCatalog },
): WorktreePlan | PlanFailure {
  const local = new Set(context.branches.local);
  if (workspace.type === "new-branch") {
    const base = workspace.baseBranch ?? context.defaultBaseBranch;
    if (workspace.branch === undefined) {
      const branch = uniqueName(slugifyTitle(context.title), (name) =>
        branchNameTaken(name, local),
      );
      return { kind: "new-branch", branch, base };
    }
    if (local.has(workspace.branch))
      return { problem: `a branch named '${workspace.branch}' already exists` };
    return { kind: "new-branch", branch: workspace.branch, base };
  }

  const { branch } = workspace;
  if (local.has(branch)) return { kind: "existing-branch", branch };
  if (context.branches.remote.includes(branch)) {
    const localName = branch.slice(branch.indexOf("/") + 1);
    return local.has(localName)
      ? { kind: "existing-branch", branch: localName }
      : { kind: "track-remote", branch: localName, remoteBranch: branch };
  }
  return { problem: `no such branch: ${branch}` };
}

export function isPlanFailure(plan: WorktreePlan | PlanFailure): plan is PlanFailure {
  return "problem" in plan;
}

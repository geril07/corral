import type { CreateTaskInput } from "@corral/protocol/rpc";
import { branchNameTaken, slugifyTitle, uniqueName } from "../git/names.ts";

export interface BranchCatalog {
  local: readonly string[];
  remote: readonly string[];
}

export interface WorktreeNaming {
  title: string;
  /** A slug from A4's generated name; without one it is derived from the title. */
  generatedSlug?: string;
  /** From settings, in front of a branch name derived here. */
  branchPrefix: string;
}

/**
 * How a task's worktree gets its branch. `slug` names the worktree directory before sanitizing:
 * the task's slug when the branch name is derived, the branch name when the user chose one.
 */
export type WorktreePlan = { slug: string } & (
  | { kind: "new-branch"; branch: string; base: string }
  /** `remoteBranch` is `origin/x`; the new local branch `branch` tracks it. */
  | { kind: "track-remote"; branch: string; remoteBranch: string }
  | { kind: "existing-branch"; branch: string }
);

export type PlanFailure = { problem: string };

/**
 * The slug a task's branch and worktree are named after. It comes from the title until A4's
 * generated name supplies one; every derived name hangs off this single value.
 */
export function taskSlug(naming: Pick<WorktreeNaming, "title" | "generatedSlug">): string {
  return naming.generatedSlug ?? slugifyTitle(naming.title);
}

/** What to do for a `new-branch` or `existing-branch` workspace; `main-worktree` has no plan. */
export function planWorktree(
  workspace: Exclude<CreateTaskInput["workspace"], { type: "main-worktree" }>,
  context: { defaultBaseBranch: string; branches: BranchCatalog } & WorktreeNaming,
): WorktreePlan | PlanFailure {
  const local = new Set(context.branches.local);
  if (workspace.type === "new-branch") {
    const base = workspace.baseBranch ?? context.defaultBaseBranch;
    if (workspace.branch === undefined) {
      const slug = taskSlug(context);
      const branch = uniqueName(`${context.branchPrefix}${slug}`, (name) =>
        branchNameTaken(name, local),
      );
      return { kind: "new-branch", branch, base, slug };
    }
    if (local.has(workspace.branch))
      return { problem: `a branch named '${workspace.branch}' already exists` };
    return { kind: "new-branch", branch: workspace.branch, base, slug: workspace.branch };
  }

  const { branch } = workspace;
  if (local.has(branch)) return { kind: "existing-branch", branch, slug: branch };
  if (context.branches.remote.includes(branch)) {
    const localName = branch.slice(branch.indexOf("/") + 1);
    return local.has(localName)
      ? { kind: "existing-branch", branch: localName, slug: localName }
      : { kind: "track-remote", branch: localName, remoteBranch: branch, slug: localName };
  }
  return { problem: `no such branch: ${branch}` };
}

export function isPlanFailure(plan: WorktreePlan | PlanFailure): plan is PlanFailure {
  return "problem" in plan;
}

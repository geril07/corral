import type { ResolvedTaskSettings } from "@corral/protocol/config";
import type { CreateTaskInput } from "@corral/protocol/rpc";

/** One entry of the workspace picker (`layout.md`: "main tree" / "new worktree" / branch). */
export interface ComposerWorkspace {
  key: string;
  label: string;
  input: CreateTaskInput["workspace"];
}

export const MAIN_TREE = "main-tree";
export const NEW_WORKTREE = "new-worktree";

/** The main working tree, a new worktree, then every existing branch, in that order. */
export function workspaceChoices(branches: readonly string[]): ComposerWorkspace[] {
  return [
    { key: MAIN_TREE, label: "main tree", input: { type: "main-worktree" } },
    { key: NEW_WORKTREE, label: "new worktree", input: { type: "new-branch" } },
    ...branches.map((branch): ComposerWorkspace => ({
      key: branchKey(branch),
      label: branch,
      input: { type: "existing-branch", branch },
    })),
  ];
}

/** What A0 resolved for the project: a new worktree or the project's main working tree. */
export function defaultWorkspace(settings: ResolvedTaskSettings): ComposerWorkspace {
  const key = settings.workspace.value === "new-worktree" ? NEW_WORKTREE : MAIN_TREE;
  return workspaceChoices([]).find((choice) => choice.key === key)!;
}

/** The picker value of an existing branch. */
export function branchKey(branch: string): string {
  return `branch:${branch}`;
}

/** Whether the workspace choice is an existing branch, which belongs to the project it came from. */
export function isBranchKey(key: string): boolean {
  return key.startsWith("branch:");
}

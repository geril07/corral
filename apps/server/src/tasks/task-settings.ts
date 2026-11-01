import { defaultWorktreeRoot } from "@corral/protocol/config";
import type { SlugMode } from "@corral/protocol/config";
import type { Project } from "@corral/protocol/rpc";

/**
 * What task creation needs from settings, per project (design.md decision 17). A0 replaces the
 * defaults behind this with the config layers; task creation only calls it.
 */
export interface TaskSettings {
  /** Absolute directory whose `<repo>/<slug>` children are the tasks' worktrees. */
  worktreeRoot(project: Project): string;
  /**
   * In front of every branch name derived from a task slug: empty when unset, else a ref prefix
   * ending in the separator (`corral/`). `planWorktree` normalizes a missing, doubled or padded
   * separator and drops empty segments.
   */
  branchPrefix(project: Project): string;
  /**
   * Whether a worktree's branch and directory are named from the generated title (`title`) or
   * from the naming request itself (`generated`); A4 reads it when it decides what to ask for.
   */
  slugMode(project: Project): SlugMode;
}

/** The defaults for callers without config: `<data dir>/worktrees`, no branch prefix, title slugs. */
export function defaultTaskSettings(options: { dataDir: string }): TaskSettings {
  const worktreeRoot = defaultWorktreeRoot(options.dataDir);
  return {
    worktreeRoot: () => worktreeRoot,
    branchPrefix: () => "",
    slugMode: () => "title",
  };
}

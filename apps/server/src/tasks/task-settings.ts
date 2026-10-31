import type { Project } from "@corral/protocol/rpc";
import { join } from "node:path";

/**
 * What task creation needs from settings, per project (design.md decision 17). A0 replaces the
 * defaults behind this with the config layers; task creation only calls it.
 */
export interface TaskSettings {
  /** Absolute directory whose `<repo>/<slug>` children are the tasks' worktrees. */
  worktreeRoot(project: Project): string;
  /** In front of every branch name derived from a task slug; empty when unset. */
  branchPrefix(project: Project): string;
}

/** Today's defaults: `<data dir>/worktrees` and no branch prefix. */
export function defaultTaskSettings(options: { dataDir: string }): TaskSettings {
  const worktreeRoot = join(options.dataDir, "worktrees");
  return { worktreeRoot: () => worktreeRoot, branchPrefix: () => "" };
}

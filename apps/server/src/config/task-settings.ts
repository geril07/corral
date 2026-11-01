import { taskSettingsFor } from "@corral/protocol/config";
import type { Project } from "@corral/protocol/rpc";
import type { TaskSettings } from "../tasks/task-settings.ts";
import type { ConfigWatcher } from "./config-watcher.ts";
import { expandWorktreeRoot } from "./worktree-root.ts";

/**
 * A1's task settings backed by the config: the effective worktree root and branch prefix for the
 * task's project (built-in default → `[tasks]` → `[projects."<path>"]`). Read on every call, so a
 * config edit applies to the next task without a restart, and `~` is expanded here, where the
 * root becomes a directory.
 */
export function configTaskSettings(
  config: Pick<ConfigWatcher, "state">,
  options: { home: string },
): TaskSettings {
  const effective = (project: Project) => taskSettingsFor(config.state().config, project.path);
  return {
    worktreeRoot: (project) =>
      expandWorktreeRoot(effective(project).worktreeRoot.value, options.home),
    branchPrefix: (project) => effective(project).branchPrefix.value,
  };
}

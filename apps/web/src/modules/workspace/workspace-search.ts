import { z } from "zod";
import type { Chosen } from "@corral/client/workspace-tree";

/** `task` value that selects the group of terminals outside any task. */
export const NO_TASK = "none";

export const workspaceSearchSchema = z.object({
  project: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
});

export type WorkspaceSearch = z.infer<typeof workspaceSearchSchema>;

/**
 * The settings route keeps the workspace selection it will return to, plus an optional project
 * path when a project's rows open Settings on that project. The workspace itself never reads
 * `settingsProject`.
 */
export const settingsSearchSchema = workspaceSearchSchema.extend({
  settingsProject: z.string().min(1).optional(),
});

export type SettingsSearch = z.infer<typeof settingsSearchSchema>;

/** True when two route searches describe the same project, task and entry intent. */
export function workspaceSearchEqual(a: WorkspaceSearch, b: WorkspaceSearch): boolean {
  return a.project === b.project && a.task === b.task && a.entry === b.entry;
}

/** Search params that do not validate fall back to the empty selection instead of failing the route. */
export function validateWorkspaceSearch(input: Record<string, unknown>): WorkspaceSearch {
  const parsed = workspaceSearchSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}

/** The settings route also accepts a project target; invalid input falls back to the workspace. */
export function validateSettingsSearch(input: Record<string, unknown>): SettingsSearch {
  const parsed = settingsSearchSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}

export function searchToChosen(search: WorkspaceSearch): Chosen {
  return {
    ...(search.project === undefined ? {} : { projectId: search.project }),
    ...(search.task === undefined ? {} : { taskId: search.task === NO_TASK ? null : search.task }),
    ...(search.entry === undefined ? {} : { entryId: search.entry }),
  };
}

export function chosenToSearch(chosen: Chosen): WorkspaceSearch {
  return {
    ...(chosen.projectId === undefined ? {} : { project: chosen.projectId }),
    ...(chosen.taskId === null
      ? { task: NO_TASK }
      : chosen.taskId === undefined
        ? {}
        : { task: chosen.taskId }),
    ...(chosen.entryId === undefined ? {} : { entry: chosen.entryId }),
  };
}

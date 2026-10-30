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

/** Search params that do not validate fall back to the empty selection instead of failing the route. */
export function validateWorkspaceSearch(input: Record<string, unknown>): WorkspaceSearch {
  const parsed = workspaceSearchSchema.safeParse(input);
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

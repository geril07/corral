import { z } from "zod";
import type { Chosen } from "@corral/client/workspace-tree";

/** `task` value that selects the group of terminals outside any task. */
export const NO_TASK = "none";

/**
 * `entry` value that selects a task's `Changes` tab (`layout.md`, **Changes**). It is deliberately
 * not a session id: the tab is not a session, it has no number hint and no status glyph, and
 * choosing it leaves the current session as it was. `resolveSelection` never sees this value; the
 * workspace keeps the tab's currentness beside the selection (`use-workspace.ts`).
 */
export const CHANGES_ENTRY = "changes";

export const workspaceSearchSchema = z.object({
  project: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  entry: z.string().min(1).optional(),
});

export type WorkspaceSearch = z.infer<typeof workspaceSearchSchema>;

/** True when two route searches describe the same project, task and entry intent. */
export function workspaceSearchEqual(a: WorkspaceSearch, b: WorkspaceSearch): boolean {
  return a.project === b.project && a.task === b.task && a.entry === b.entry;
}

/** Search params that do not validate fall back to the empty selection instead of failing the route. */
export function validateWorkspaceSearch(input: Record<string, unknown>): WorkspaceSearch {
  const parsed = workspaceSearchSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}

export function searchToChosen(search: WorkspaceSearch): Chosen {
  return {
    ...(search.project === undefined ? {} : { projectId: search.project }),
    ...(search.task === undefined ? {} : { taskId: search.task === NO_TASK ? null : search.task }),
    // The Changes tab is not an entry: choosing it must not make a session id out of `changes`.
    ...(search.entry === undefined || search.entry === CHANGES_ENTRY
      ? {}
      : { entryId: search.entry }),
  };
}

/** The search of a task's Changes tab; the session the task shows stays the client's own choice. */
export function changesSearch(chosen: Chosen): WorkspaceSearch {
  return { ...chosenToSearch(chosen), entry: CHANGES_ENTRY };
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

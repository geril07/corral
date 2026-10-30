import type { AgentStatus, Project, Task } from "@corral/protocol/rpc";
import { compareStatuses, taskStatus } from "./agent-status.ts";
import type { WorkspaceTree } from "./workspace-tree.ts";

export interface BoardRow {
  project: Project;
  task: Task;
  /** The session that gives the task its status; absent when no session reported one. */
  sessionId: string | undefined;
  status: AgentStatus | undefined;
}

/**
 * Every active task of every project, most urgent first, then the most recently reported.
 * Tasks without a status come last, newest task first.
 */
export function buildBoard(tree: WorkspaceTree): BoardRow[] {
  return tree.projects
    .flatMap(({ project, active }) =>
      active.map(({ task, sessions }): BoardRow => {
        const own = taskStatus(sessions.map((entry) => entry.session));
        return { project, task, sessionId: own?.sessionId, status: own?.status };
      }),
    )
    .toSorted(
      (a, b) =>
        compareStatuses(a.status, b.status) ||
        b.task.createdAt - a.task.createdAt ||
        a.task.id.localeCompare(b.task.id),
    );
}

/** The row "jump to blocked" goes to: the first blocked task on the board. */
export function mostUrgentBlocked(rows: readonly BoardRow[]): BoardRow | undefined {
  return rows.find((row) => row.status?.state === "blocked");
}

import type { Project, Task, TerminalInfo } from "@corral/protocol/rpc";
import { effectiveActive } from "./terminal-selection.ts";

export interface TaskNode {
  task: Task;
  terminals: readonly TerminalInfo[];
}

export interface ProjectNode {
  project: Project;
  active: readonly TaskNode[];
  archived: readonly TaskNode[];
}

/** What the sidebar shows: project → tasks → terminals, plus the terminals outside any task. */
export interface WorkspaceTree {
  projects: readonly ProjectNode[];
  /** Terminals with `taskId: null`. */
  loose: readonly TerminalInfo[];
}

/**
 * Terminals or tasks whose parent is not in the lists yet (the watches are separate streams)
 * are left out until it arrives.
 */
export function buildWorkspaceTree(
  projects: readonly Project[],
  tasks: readonly Task[],
  terminals: readonly TerminalInfo[],
): WorkspaceTree {
  const node = (task: Task): TaskNode => ({
    task,
    terminals: terminals.filter((terminal) => terminal.taskId === task.id),
  });
  return {
    projects: projects.map((project) => {
      const own = tasks.filter((task) => task.projectId === project.id);
      return {
        project,
        active: own.filter((task) => task.state === "active").map(node),
        archived: own.filter((task) => task.state === "archived").map(node),
      };
    }),
    loose: terminals.filter((terminal) => terminal.taskId === null),
  };
}

/** Tasks in the order the sidebar lists them: per project, active first, then archived. */
export function tasksInOrder(tree: WorkspaceTree): Task[] {
  return tree.projects.flatMap(({ active, archived }) =>
    [...active, ...archived].map(({ task }) => task),
  );
}

/** What the user pointed at last; any part may be stale or missing. */
export interface Chosen {
  projectId?: string;
  /** `null`: the group of terminals outside any task. */
  taskId?: string | null;
  terminalId?: string;
}

export interface Selection {
  projectId: string | undefined;
  /** `null`: no task, so new terminals start outside any task. */
  taskId: string | null;
  /** The terminal shown, one of the current task's. */
  terminalId: string | undefined;
}

/**
 * Settles what is current from the choice and the data. A choice that no longer exists falls back:
 * a missing task to the first task of the chosen (else first) project, or to no task when that
 * project has none; a missing terminal to the first one of the task.
 */
export function resolveSelection(tree: WorkspaceTree, chosen: Chosen): Selection {
  const tasks = tasksInOrder(tree);
  const chosenTask =
    typeof chosen.taskId === "string" ? tasks.find((task) => task.id === chosen.taskId) : undefined;
  const chosenProject =
    tree.projects.find(({ project }) => project.id === chosen.projectId) ?? tree.projects[0];

  let task: Task | undefined;
  if (chosenTask) task = chosenTask;
  else if (chosen.taskId !== null) {
    task = [...(chosenProject?.active ?? []), ...(chosenProject?.archived ?? [])][0]?.task;
  }

  const terminals = terminalsOf(tree, task?.id ?? null);
  return {
    projectId: task?.projectId ?? chosenProject?.project.id,
    taskId: task?.id ?? null,
    terminalId: effectiveActive(
      terminals.map((terminal) => terminal.id),
      chosen.terminalId,
    ),
  };
}

/** The terminals of the task `taskId`, or the loose ones for `null`. */
export function terminalsOf(tree: WorkspaceTree, taskId: string | null): readonly TerminalInfo[] {
  return taskId === null ? tree.loose : taskTerminals(tree, taskId);
}

function taskTerminals(tree: WorkspaceTree, taskId: string): readonly TerminalInfo[] {
  for (const { active, archived } of tree.projects) {
    const found = [...active, ...archived].find((node) => node.task.id === taskId);
    if (found) return found.terminals;
  }
  return [];
}

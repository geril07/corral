import type { AgentStatus, Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { isUnseenDone, taskStatus } from "./agent-status.ts";
import { effectiveActive } from "./terminal-selection.ts";

/** What can be current in a group: a session of a task, or a terminal outside any task. */
export type Entry = SessionEntry | TerminalEntry;

export interface SessionEntry {
  type: "session";
  /** The session's id. */
  id: string;
  session: Session;
  /** Absent while the session is stopped, and while the terminal list has not caught up yet. */
  terminal: TerminalInfo | undefined;
}

export interface TerminalEntry {
  type: "terminal";
  /** The terminal's id. */
  id: string;
  terminal: TerminalInfo;
}

export interface TaskNode {
  task: Task;
  sessions: readonly SessionEntry[];
}

export interface ProjectNode {
  project: Project;
  active: readonly TaskNode[];
  settled: readonly TaskNode[];
}

/** What the sidebar shows: project → tasks → sessions, plus the terminals outside any task. */
export interface WorkspaceTree {
  projects: readonly ProjectNode[];
  /** Terminals with `taskId: null`. */
  loose: readonly TerminalEntry[];
}

/**
 * Sessions or tasks whose parent is not in the lists yet (the watches are separate streams)
 * are left out until it arrives. Sessions are listed in the order they were created.
 */
export function buildWorkspaceTree(
  projects: readonly Project[],
  tasks: readonly Task[],
  sessions: readonly Session[],
  terminals: readonly TerminalInfo[],
): WorkspaceTree {
  const node = (task: Task): TaskNode => ({
    task,
    sessions: sessions
      .filter((session) => session.taskId === task.id)
      .toSorted((a, b) => a.createdAt - b.createdAt)
      .map((session): SessionEntry => ({
        type: "session",
        id: session.id,
        session,
        terminal:
          session.terminalId === null
            ? undefined
            : terminals.find((terminal) => terminal.id === session.terminalId),
      })),
  });
  return {
    projects: projects.map((project) => {
      const own = tasks.filter((task) => task.projectId === project.id);
      return {
        project,
        active: own.filter((task) => task.state === "active").map(node),
        settled: own.filter((task) => task.state === "settled").map(node),
      };
    }),
    loose: terminals
      .filter((terminal) => terminal.taskId === null)
      .map((terminal): TerminalEntry => ({ type: "terminal", id: terminal.id, terminal })),
  };
}

/** Tasks in the order the sidebar lists them: per project, active first, then settled. */
export function tasksInOrder(tree: WorkspaceTree): Task[] {
  return tree.projects.flatMap(({ active, settled }) =>
    [...active, ...settled].map(({ task }) => task),
  );
}

/** What the user pointed at last; any part may be stale or missing. */
export interface Chosen {
  projectId?: string | undefined;
  /** `null`: the group of terminals outside any task. */
  taskId?: string | null | undefined;
  /** A session of the chosen task, or a terminal of the no-task group. */
  entryId?: string | undefined;
}

export interface Selection {
  projectId: string | undefined;
  /** `null`: no task, so new terminals start outside any task. */
  taskId: string | null;
  /** The entry shown, one of the current group's. */
  entryId: string | undefined;
}

/**
 * Settles what is current from the choice and the data. A choice that no longer exists falls back:
 * a missing task to the first task of the chosen (else first) project, or to no task when that
 * project has none; a missing entry to the first one of the group.
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
    task = [...(chosenProject?.active ?? []), ...(chosenProject?.settled ?? [])][0]?.task;
  }

  const entries = entriesOf(tree, task?.id ?? null);
  return {
    projectId: task?.projectId ?? chosenProject?.project.id,
    taskId: task?.id ?? null,
    entryId: effectiveActive(
      entries.map((entry) => entry.id),
      chosen.entryId,
    ),
  };
}

/** The node of the task `taskId`, in whichever project holds it. */
export function taskNodeOf(tree: WorkspaceTree, taskId: string): TaskNode | undefined {
  for (const { active, settled } of tree.projects) {
    const found = [...active, ...settled].find((node) => node.task.id === taskId);
    if (found) return found;
  }
  return undefined;
}

/** The entries of the task `taskId`, or the loose terminals for `null`. */
export function entriesOf(tree: WorkspaceTree, taskId: string | null): readonly Entry[] {
  return taskId === null ? tree.loose : taskSessions(tree, taskId);
}

/** How the sidebar lists tasks: flat by status, or grouped by project (`layout.md`, **Sidebar**). */
export type SidebarMode = "flat" | "project";

export type FlatSectionKind = "needs-you" | "working" | "done";

/** A task in the flat list, with what its row shows and the status it is ranked by. */
export interface FlatTaskNode extends TaskNode {
  project: Project;
  status: AgentStatus | undefined;
  /** A `done` update newer than the task's `seenAt`; only flat rows mark it (`isUnseenDone`). */
  unseen: boolean;
}

export interface FlatSection {
  kind: FlatSectionKind;
  label: string;
  tasks: readonly FlatTaskNode[];
}

/** Flat mode's list: the ranked sections and the settled shelf. */
export interface FlatSidebar {
  /** In display order, empty sections left out. */
  sections: readonly FlatSection[];
  settled: readonly FlatTaskNode[];
}

export const FLAT_SECTION_LABELS: Readonly<Record<FlatSectionKind, string>> = {
  "needs-you": "Needs you",
  working: "Working",
  done: "Done",
};

const FLAT_SECTION_KINDS: readonly FlatSectionKind[] = ["needs-you", "working", "done"];

/**
 * Flat mode: the active tasks of every project in one list, ordered by status (blocked, error,
 * working, completed and unseen, then the rest), then by the most recent update. Settled tasks
 * keep a shelf of their own (`layout.md`, **Sidebar**).
 */
export function buildFlatSidebar(tree: WorkspaceTree): FlatSidebar {
  const rows = tree.projects.flatMap(({ project, active }) =>
    active.map((node) => flatNode(project, node)),
  );
  return {
    sections: FLAT_SECTION_KINDS.map((kind) => ({
      kind,
      label: FLAT_SECTION_LABELS[kind],
      tasks: rows.filter((row) => flatSectionOf(row) === kind).toSorted(compareFlat),
    })).filter((section) => section.tasks.length > 0),
    settled: tree.projects
      .flatMap(({ project, settled }) => settled.map((node) => flatNode(project, node)))
      .toSorted(compareFlat),
  };
}

/** The tasks flat mode lists, in the order it lists them: the sections, then the settled shelf. */
export function flatTaskOrder(sidebar: FlatSidebar): Task[] {
  return [...sidebar.sections.flatMap(({ tasks }) => tasks), ...sidebar.settled].map(
    ({ task }) => task,
  );
}

/** Which section a flat row belongs to: needs you (blocked or error), working, or done. */
export function flatSectionOf(row: FlatTaskNode): FlatSectionKind {
  const state = row.status?.state;
  if (state === "blocked" || state === "error") return "needs-you";
  if (state === "working") return "working";
  return "done";
}

/**
 * Lower comes first: needs approval or input, error, working, completed and unseen, then the
 * remaining done, idle and statusless tasks.
 */
export function flatRank(row: FlatTaskNode): number {
  const state = row.status?.state;
  if (state === "blocked") return 0;
  if (state === "error") return 1;
  if (state === "working") return 2;
  return state === "done" && row.unseen ? 3 : 4;
}

/** Rank first, then the most recently reported status, then the newest task. */
function compareFlat(a: FlatTaskNode, b: FlatTaskNode): number {
  return (
    flatRank(a) - flatRank(b) ||
    (b.status?.updatedAt ?? 0) - (a.status?.updatedAt ?? 0) ||
    b.task.createdAt - a.task.createdAt ||
    a.task.id.localeCompare(b.task.id)
  );
}

function flatNode(project: Project, node: TaskNode): FlatTaskNode {
  const status = taskStatus(node.sessions.map((entry) => entry.session))?.status;
  return { ...node, project, status, unseen: isUnseenDone(node.task, status) };
}

/** The entry `selection` points at. */
export function currentEntry(tree: WorkspaceTree, selection: Selection): Entry | undefined {
  return entriesOf(tree, selection.taskId).find((entry) => entry.id === selection.entryId);
}

function taskSessions(tree: WorkspaceTree, taskId: string): readonly SessionEntry[] {
  return taskNodeOf(tree, taskId)?.sessions ?? [];
}

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
        // The pane to show follows the session's view, not just its terminal: a `both-live`
        // session keeps its PTY alive while chat is shown (`terminalId` is still the server's
        // fact on `session`), so attaching it here in chat view would render the terminal forever.
        terminal:
          session.view !== "terminal" || session.terminalId === null
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

/** The status a task shows: the most urgent one of its sessions. */
function statusOf(node: TaskNode): AgentStatus | undefined {
  return taskStatus(node.sessions.map((entry) => entry.session))?.status;
}

/** The moment a task's age counts from: its status report, or the task's own creation. */
function activityTime(node: TaskNode): number {
  return statusOf(node)?.updatedAt ?? node.task.createdAt;
}

/**
 * The Settled shelf's one order in both grouping modes: the most recent activity first — the
 * moment the row's age counts from — then the newest task, then the id. A settled task without a
 * status therefore sorts by creation; no separate settle time is recorded
 * (`layout.md`, **Sidebar**).
 */
function compareSettled(a: TaskNode, b: TaskNode): number {
  return (
    activityTime(b) - activityTime(a) ||
    b.task.createdAt - a.task.createdAt ||
    a.task.id.localeCompare(b.task.id)
  );
}

function settledNodesInOrder(nodes: readonly TaskNode[]): TaskNode[] {
  return nodes.toSorted(compareSettled);
}

/** The Settled shelf's rows, across every project, in their one order (`layout.md`, **Sidebar**). */
export function settledInOrder(tree: WorkspaceTree): TaskNode[] {
  return settledNodesInOrder(tree.projects.flatMap(({ settled }) => settled));
}

/** Project groups first, then the shared bottom Settled shelf: the sidebar navigation order. */
export function tasksInOrder(tree: WorkspaceTree): Task[] {
  return [...tree.projects.flatMap(({ active }) => active), ...settledInOrder(tree)].map(
    ({ task }) => task,
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
 * Settles what is current from the choice and the data. A chosen task always wins. A chosen project
 * that names an existing project with no tasks and no task choice of its own is the composer state,
 * so it never falls to a loose terminal; an explicit `taskId: null` still selects the first loose
 * terminal. Any other missing choice falls back: a missing task to the first active task of the
 * chosen (else first) project, else that project's settled shelf's first row, or to no task when
 * the project has none; a missing entry to the first one of the group.
 */
export function resolveSelection(tree: WorkspaceTree, chosen: Chosen): Selection {
  const tasks = tasksInOrder(tree);
  const chosenTask =
    typeof chosen.taskId === "string" ? tasks.find((task) => task.id === chosen.taskId) : undefined;
  const namedProject = tree.projects.find(({ project }) => project.id === chosen.projectId);
  const chosenProject = namedProject ?? tree.projects[0];

  let task: Task | undefined;
  if (chosenTask) task = chosenTask;
  else if (chosen.taskId !== null) {
    task = chosenProject
      ? (chosenProject.active[0] ?? settledNodesInOrder(chosenProject.settled)[0])?.task
      : undefined;
  }

  const entries = entriesOf(tree, task?.id ?? null);
  // A chosen project that names an existing project with no tasks, and no task choice of its own,
  // is the composer state, not the no-task group: its loose terminals belong to another choice
  // (`layout.md`, **Empty states**). An explicit `taskId: null` still selects the first loose
  // terminal; a missing project id keeps the old fallback to the first project.
  const emptyProject =
    chosen.taskId !== null &&
    chosenTask === undefined &&
    namedProject !== undefined &&
    namedProject.active.length === 0 &&
    namedProject.settled.length === 0;
  return {
    projectId: task?.projectId ?? chosenProject?.project.id,
    taskId: task?.id ?? null,
    entryId: emptyProject
      ? undefined
      : effectiveActive(
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
      .toSorted(compareSettled),
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

/**
 * Rank first, then the most recent update — the status report, or the task's own age when it
 * has none, which is what its row displays — then the newest task and its id as a tiebreak.
 */
function compareFlat(a: FlatTaskNode, b: FlatTaskNode): number {
  return flatRank(a) - flatRank(b) || compareSettled(a, b);
}

function flatNode(project: Project, node: TaskNode): FlatTaskNode {
  const status = statusOf(node);
  return { ...node, project, status, unseen: isUnseenDone(node.task, status) };
}

/** The entry `selection` points at. */
export function currentEntry(tree: WorkspaceTree, selection: Selection): Entry | undefined {
  return entriesOf(tree, selection.taskId).find((entry) => entry.id === selection.entryId);
}

function taskSessions(tree: WorkspaceTree, taskId: string): readonly SessionEntry[] {
  return taskNodeOf(tree, taskId)?.sessions ?? [];
}

import { hasUnseen, sessionStatus, type TaskStatus } from "@corral/client/agent-status";
import type { AgentStatus, Project, Session, Task } from "@corral/protocol/rpc";
import type { VisualCardStatus, VisualTaskAgent, VisualTaskRow } from "../../common/ui/index.ts";
import { branchName } from "../tasks/index.ts";

/** A card's compressed age: no seconds, as agreed for the sidebar (`#258`, §6). */
export function formatCompactAge(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The one agent session a task card follows: the session created from its prompt. */
export function primarySession(
  task: Pick<Task, "primarySessionId">,
  sessions: readonly Session[],
): Session | undefined {
  if (task.primarySessionId === null) return undefined;
  return sessions.find((session) => session.id === task.primarySessionId);
}

/** The primary session's status, with the server's stopped-session rule already applied. */
export function primaryTaskStatus(
  task: Pick<Task, "primarySessionId">,
  sessions: readonly Session[],
): TaskStatus | undefined {
  const session = primarySession(task, sessions);
  if (session === undefined) return undefined;
  const status = sessionStatus(session);
  return status === undefined ? undefined : { sessionId: session.id, status };
}

/**
 * What the card's right slot shows. Working deliberately has no time: `AgentStatus.updatedAt` is
 * a report time, not the start of the current run, so a duration derived from it would be invented.
 */
export function cardStatus(
  task: Pick<Task, "seenAt">,
  status: AgentStatus | undefined,
  now: number,
): VisualCardStatus | undefined {
  if (status === undefined) return undefined;
  const unseen = hasUnseen(task, status);
  if (status.state === "working") {
    return { tone: "working", label: "Working", message: status.message };
  }
  if (status.state === "blocked") {
    return {
      tone: "blocked",
      label: "Blocked",
      time: formatCompactAge(now, status.updatedAt),
      message: status.message,
    };
  }
  if (status.state === "error") {
    return {
      tone: "error",
      label: "Error",
      time: formatCompactAge(now, status.updatedAt),
      message: status.message,
    };
  }
  if (status.state === "done") {
    return unseen
      ? {
          tone: "done",
          label: "Done",
          time: formatCompactAge(now, status.updatedAt),
          message: status.message,
        }
      : { tone: "neutral", muted: true, time: formatCompactAge(now, status.updatedAt) };
  }
  return { tone: "neutral", muted: true, time: formatCompactAge(now, status.updatedAt) };
}

/** Blocked/Error, then unseen Done, then Working, then everything else. */
export function cardPriority(task: Pick<Task, "seenAt">, status: AgentStatus | undefined): number {
  if (status === undefined) return 3;
  if (status.state === "blocked" || status.state === "error") return 0;
  if (status.state === "done") return hasUnseen(task, status) ? 1 : 3;
  if (status.state === "working") return 2;
  return 3;
}

function projectInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? "?" : first.toUpperCase();
}

/**
 * The primary agent's known launch identity. A shell is not an agent, and an unknown model or
 * provider stays absent instead of being inferred from another profile or a default.
 */
function visualAgent(session: Session | undefined): VisualTaskAgent | undefined {
  if (session === undefined || session.kind === "shell") return undefined;
  const model = session.launch?.model ?? undefined;
  const provider = session.launch?.provider ?? undefined;
  return {
    kind: session.kind,
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
  };
}

/** A row and the facts each list orders it by; the two lists share the row recipe. */
interface RowEntry {
  row: VisualTaskRow;
  priority: number;
  /** The moment the row's age counts from: its status report, or the task's creation. */
  activity: number;
  title: string;
  createdAt: number;
  id: string;
}

/** One task's row, or `undefined` when its project is not among the ones the client knows. */
function rowOf(
  task: Task,
  projectById: ReadonlyMap<string, Project>,
  sessions: readonly Session[],
  now: number,
): RowEntry | undefined {
  const project = task.projectId === null ? undefined : projectById.get(task.projectId);
  if (task.projectId !== null && project === undefined) return undefined;
  const projectName = project?.name ?? "No project";
  const copyBranch = branchName(task.branch);
  const primary = primarySession(task, sessions);
  const primaryStatus = primary === undefined ? undefined : sessionStatus(primary);
  const agent = visualAgent(primary);
  return {
    priority: cardPriority(task, primaryStatus),
    activity: primaryStatus?.updatedAt ?? task.createdAt,
    title: task.title,
    createdAt: task.createdAt,
    id: task.id,
    row: {
      id: task.id,
      title: task.title,
      project: projectName,
      projectInitial: projectInitial(projectName),
      workspacePath: task.workspacePath,
      hasSource: task.source !== undefined,
      ...(copyBranch === undefined ? {} : { copyBranch }),
      ...(task.state === "settled" ? { settled: true } : {}),
      status: cardStatus(task, primaryStatus, now),
      metadata: {
        project: projectName,
        ...(task.branch === null ? {} : { branch: task.branch }),
        ...(agent === undefined ? {} : { agent }),
        ...(task.prompt === null ? {} : { prompt: task.prompt }),
      },
    },
  };
}

/**
 * The sidebar's active rows: tasks of projects the client already knows, flat and sorted by status
 * priority, then by the last reported status or the task's creation.
 */
export function buildTaskRows(
  projects: readonly Project[],
  tasks: readonly Task[],
  sessions: readonly Session[],
  now: number,
): VisualTaskRow[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const rows: RowEntry[] = [];
  for (const task of tasks) {
    if (task.state !== "active") continue;
    const entry = rowOf(task, projectById, sessions, now);
    if (entry !== undefined) rows.push(entry);
  }
  return rows
    .toSorted(
      (a, b) =>
        a.priority - b.priority ||
        b.activity - a.activity ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(({ row }) => row);
}

/**
 * The Settled shelf's rows across every project, in their one order: the most recent activity
 * first, then the newest task, then the id. A settled task without a status sorts by creation;
 * the server records no settle time (`layout.md`, **Sidebar**).
 */
export function buildSettledRows(
  projects: readonly Project[],
  tasks: readonly Task[],
  sessions: readonly Session[],
  now: number,
): VisualTaskRow[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const rows: RowEntry[] = [];
  for (const task of tasks) {
    if (task.state !== "settled") continue;
    const entry = rowOf(task, projectById, sessions, now);
    if (entry !== undefined) rows.push(entry);
  }
  return rows
    .toSorted(
      (a, b) => b.activity - a.activity || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    )
    .map(({ row }) => row);
}

import type { AgentState, AgentStatus, Session, Task } from "@corral/protocol/rpc";

/** Most urgent first: what a task shows when its sessions disagree. */
export const STATES_BY_URGENCY: readonly AgentState[] = [
  "blocked",
  "error",
  "working",
  "done",
  "idle",
];

/** Lower is more urgent; a missing status is below every state. */
export function urgencyRank(state: AgentState | undefined): number {
  return state === undefined ? STATES_BY_URGENCY.length : STATES_BY_URGENCY.indexOf(state);
}

/**
 * What a session contributes to its task. The server clears a status when the process exits,
 * except `done` and `error`; a stopped session still carrying anything else is stale and ignored.
 */
export function sessionStatus(session: Pick<Session, "state" | "status">): AgentStatus | undefined {
  const { status } = session;
  if (!status) return undefined;
  if (session.state === "running") return status;
  return status.state === "done" || status.state === "error" ? status : undefined;
}

export interface TaskStatus {
  /** The session that gives the task its status, the one that needs attention. */
  sessionId: string;
  status: AgentStatus;
}

/** The most urgent status among the sessions; of equal urgency, the most recently reported. */
export function taskStatus(
  sessions: readonly Pick<Session, "id" | "state" | "status">[],
): TaskStatus | undefined {
  let best: TaskStatus | undefined;
  for (const session of sessions) {
    const status = sessionStatus(session);
    if (!status) continue;
    if (!best || compareStatuses(status, best.status) < 0) best = { sessionId: session.id, status };
  }
  return best;
}

/** Negative when `a` should come first: more urgent, then more recent. */
export function compareStatuses(a: AgentStatus | undefined, b: AgentStatus | undefined): number {
  return urgencyRank(a?.state) - urgencyRank(b?.state) || (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0);
}

/** `blocked · permission`: the text that stands in for the indicator's color and shape. */
export function describeStatus(status: Pick<AgentStatus, "state" | "kind">): string {
  return status.kind ? `${status.state} · ${status.kind}` : status.state;
}

/**
 * True when the task's status is newer than the last time the user saw it. `seenAt` is the
 * server's record of that moment, so every client agrees on which updates are unseen.
 */
export function hasUnseen(task: Pick<Task, "seenAt">, status: AgentStatus | undefined): boolean {
  return status !== undefined && (task.seenAt === null || status.updatedAt > task.seenAt);
}

/** A finished task whose `done` update the user has not looked at yet. */
export function isUnseenDone(task: Pick<Task, "seenAt">, status: AgentStatus | undefined): boolean {
  return status?.state === "done" && hasUnseen(task, status);
}

/** A `done` update the user has already seen: the sidebar row and task header mute it. */
export function isSeenDone(status: AgentStatus | undefined, unseen: boolean): boolean {
  return status?.state === "done" && !unseen;
}

/**
 * The word a flat sidebar row shows instead of the age while the task needs the user. The state
 * name stays visible next to its glyph, rather than relying on shape or color alone.
 */
export function attentionWord(status: AgentStatus | undefined): string | undefined {
  if (status?.state === "error") return "error";
  if (status?.state !== "blocked") return undefined;
  if (status.kind === "permission") return "needs approval";
  if (status.kind === "question") return "needs input";
  if (status.kind === "auth") return "needs auth";
  return "blocked";
}

/** `5m`, `2h`: how long ago, for a list that is read at a glance. */
export function formatAge(now: number, then: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

import type { AgentState, AgentStatus, Session } from "@corral/protocol/rpc";

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

import { AgentKind, type Session } from "@corral/protocol/rpc";

/** The agents a session can run, in the order the picker lists them. */
export const AGENTS: readonly AgentKind[] = AgentKind.options;

export interface SessionStateText {
  /** A short word for the sidebar; absent while the session runs. */
  badge: string | undefined;
  /** What starting a session that is not running does; absent while it runs. */
  note: string | undefined;
}

export function describeSessionState(session: Pick<Session, "kind" | "state">): SessionStateText {
  if (session.state === "running") return { badge: undefined, note: undefined };
  if (session.state === "unresumable") {
    return {
      badge: "unresumable",
      note: "The agent's conversation was never identified, so starting it again will start a new conversation.",
    };
  }
  return {
    badge: "stopped",
    note:
      session.kind === "shell"
        ? "Starting it again opens a fresh shell in the task's workspace."
        : "Starting it again resumes the agent's conversation.",
  };
}

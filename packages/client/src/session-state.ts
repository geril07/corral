import { AgentKind, type Session } from "@corral/protocol/rpc";

/** The agents a session can run, in the order the picker lists them. */
export const AGENTS: readonly AgentKind[] = AgentKind.options;

export interface SessionStateText {
  /** A short word for the tab and pane heading; absent while the session runs. */
  badge: string | undefined;
  /** What the menu and pane button offer; absent while the session runs. */
  action: string | undefined;
  /** What starting a session that is not running does; absent while it runs. */
  note: string | undefined;
}

export function describeSessionState(
  session: Pick<Session, "kind" | "state" | "status" | "launchError">,
): SessionStateText {
  if (session.state === "running") {
    return { badge: undefined, action: undefined, note: undefined };
  }
  if (session.state === "unresumable") {
    return {
      badge: "unresumable",
      action: "Start a new conversation",
      note: "The agent's conversation was never identified, so starting it again will start a new conversation.",
    };
  }
  return {
    badge: session.launchError != null || session.status?.state === "error" ? "failed" : "stopped",
    action: "Restart",
    note:
      session.kind === "shell"
        ? "Starting it again opens a fresh shell in the task's workspace."
        : "Starting it again resumes the agent's conversation.",
  };
}

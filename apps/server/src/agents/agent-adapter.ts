/** How to launch one agent CLI; pure, so the argument lists are testable without running anything. */
export interface AgentAdapter {
  /** Looked up on the server's `PATH`. */
  command: string;
  /** The id a new conversation is started with; `null` for an agent that picks its own (Codex). */
  newSessionId(): string | null;
  /** `agentSessionId` is `null` when the agent picks its own id. */
  startArgs(agentSessionId: string | null): string[];
  resumeArgs(agentSessionId: string): string[];
}

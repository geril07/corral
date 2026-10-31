/** How to launch one agent CLI; pure, so the argument lists are testable without running anything. */
export interface AgentAdapter {
  /** Looked up on the server's `PATH`. */
  command: string;
  /** The id a new conversation is started with; `null` for an agent that picks its own (Codex). */
  newSessionId(): string | null;
  /** The agent-native flags for the model/provider a profile or the user chose; `[]` when neither is set. */
  launchArgs(model: string | null, provider: string | null): string[];
  /** `agentSessionId` is `null` when the agent picks its own id. */
  startArgs(agentSessionId: string | null): string[];
  resumeArgs(agentSessionId: string): string[];
  /**
   * The prompt a first start hands to the agent's TUI, as argv words: one word, never a shell.
   * Only the first start passes it, so a resumed session never repeats the work.
   */
  promptArgs(prompt: string): string[];
  /**
   * For an agent whose resume fails on an id that has no history yet, which is what a session
   * that never got a prompt is: whether `agentSessionId` can be resumed. When it cannot, the
   * session starts again under the same id. Absent for agents that create a missing session.
   */
  hasConversation?(agentSessionId: string, env: NodeJS.ProcessEnv): boolean;
}

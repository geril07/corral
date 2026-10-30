import type { AgentAdapter } from "./agent-adapter.ts";

/** Codex cannot be given an id; the server learns it afterwards (`codex-sessions.ts`). */
export const codex: AgentAdapter = {
  command: "codex",
  newSessionId: () => null,
  startArgs: () => [],
  resumeArgs: (id) => ["resume", id],
};

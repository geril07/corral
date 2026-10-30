import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "./agent-adapter.ts";

/** `--session-id` takes a UUID and starts the conversation under it; `--resume` continues it. */
export const claude: AgentAdapter = {
  command: "claude",
  newSessionId: randomUUID,
  startArgs: (id) => (id === null ? [] : ["--session-id", id]),
  resumeArgs: (id) => ["--resume", id],
};

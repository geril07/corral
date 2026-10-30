import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "./agent-adapter.ts";

/**
 * `--session-id` opens the session or creates it when missing, so start and resume are the same
 * call. Ids are letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit;
 * a UUID is pi's own default.
 */
export const pi: AgentAdapter = {
  command: "pi",
  newSessionId: randomUUID,
  startArgs: (id) => (id === null ? [] : ["--session-id", id]),
  resumeArgs: (id) => ["--session-id", id],
};

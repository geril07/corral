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
  // pi's `--provider` searches for `--model`; both are passed as native pi values.
  launchArgs: (model, provider) => [
    ...(provider === null ? [] : ["--provider", provider]),
    ...(model === null ? [] : ["--model", model]),
  ],
  startArgs: (id) => (id === null ? [] : ["--session-id", id]),
  resumeArgs: (id) => ["--session-id", id],
};

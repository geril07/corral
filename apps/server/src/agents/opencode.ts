import { randomBytes } from "node:crypto";
import type { AgentAdapter } from "./agent-adapter.ts";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_CHARACTERS = 26;

/** OpenCode accepts only ids shaped like its own: `ses_` and 26 letters or digits. */
export function newOpenCodeSessionId(): string {
  const random = Array.from(
    randomBytes(ID_CHARACTERS),
    (byte) => BASE62[byte % BASE62.length],
  ).join("");
  return `ses_${random}`;
}

/** `--session` continues the session, or creates it when missing, so start and resume are the same call. */
export const opencode: AgentAdapter = {
  command: "opencode",
  newSessionId: newOpenCodeSessionId,
  startArgs: (id) => (id === null ? [] : ["--session", id]),
  resumeArgs: (id) => ["--session", id],
};

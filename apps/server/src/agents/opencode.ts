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

/**
 * The flags that attach a TUI to the server Corral started instead of OpenCode's own background
 * service: measured on 2.2.5 with a server whose session the API had created, the TUI opened on
 * that session and both frontends were live. The client resolves the password from
 * `OPENCODE_SERVER_PASSWORD`, which the launch also exports.
 */
export function openCodeServerArgs(url: string): string[] {
  return ["--server", url];
}

/**
 * `--session` continues the session, or creates it when missing, so start and resume are the same call.
 *
 * Opencode 2.2.5 has no model or provider flag on this command; a profile is env-only. A prompt is
 * `--prompt <text>`, and its parser reads a following word that starts with `-` as an option, so
 * such a prompt is attached to the flag instead (`--prompt=<text>`, one argv word either way).
 */
export const opencode: AgentAdapter = {
  command: "opencode",
  newSessionId: newOpenCodeSessionId,
  launchArgs: () => [],
  startArgs: (id) => (id === null ? [] : ["--session", id]),
  resumeArgs: (id) => ["--session", id],
  promptArgs: (prompt) => (prompt.startsWith("-") ? [`--prompt=${prompt}`] : ["--prompt", prompt]),
};

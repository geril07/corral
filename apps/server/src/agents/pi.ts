import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "./agent-adapter.ts";

/**
 * `--session-id` opens the session or creates it when missing, so start and resume are the same
 * call. Ids are letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit;
 * a UUID is pi's own default.
 *
 * pi 1.4.0 prompts with `[--] [messages...]`. A positional that starts with `@` is a file to
 * include (`@path`, resolved from the cwd) even after `--`, and a file that is not there ends the
 * run, so such a prompt gets one leading space: the words are unchanged and pi reads them as a
 * message. A prompt that starts with `-` needs `--`, which pi documents for exactly that.
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
  promptArgs: (prompt) => {
    if (prompt.startsWith("@")) return [` ${prompt}`];
    return prompt.startsWith("-") ? ["--", prompt] : [prompt];
  },
};

import type { AgentAdapter } from "./agent-adapter.ts";

/**
 * Codex cannot be given an id; the server learns it afterwards (`codex-sessions.ts`).
 *
 * codex 0.166.0 prompts with the top-level `[PROMPT]` positional; its option parser (clap) ends
 * options at `--`, so a prompt that starts with `-` follows it.
 */
export const codex: AgentAdapter = {
  command: "codex",
  newSessionId: () => null,
  // `-p/--profile` would layer a user config file; `-c model_provider` keeps this launch ours.
  launchArgs: (model, provider) => [
    ...(model === null ? [] : ["-m", model]),
    ...(provider === null ? [] : ["-c", `model_provider=${provider}`]),
  ],
  startArgs: () => [],
  resumeArgs: (id) => ["resume", id],
  promptArgs: (prompt) => (prompt.startsWith("-") ? ["--", prompt] : [prompt]),
};

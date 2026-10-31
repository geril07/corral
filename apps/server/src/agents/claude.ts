import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "./agent-adapter.ts";

export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
}

/**
 * Workaround: `--resume <id>` exits with "No conversation found" until the first prompt has
 * been sent, and Claude Code has no command that says whether a conversation exists (the only
 * probes, `-p --resume`, would run it). So this reads Claude's internals: the transcript
 * `<config dir>/projects/<escaped cwd>/<id>.jsonl`. Only its existence is used. The directory
 * name is derived from the cwd by a scheme that is not ours (it also hashes long paths), so the
 * project directories are searched for the file instead; ids are unique UUIDs.
 */
function hasTranscript(agentSessionId: string, env: NodeJS.ProcessEnv): boolean {
  const projects = join(claudeConfigDir(env), "projects");
  let directories: string[];
  try {
    directories = readdirSync(projects);
  } catch {
    return false;
  }
  return directories.some((directory) =>
    existsSync(join(projects, directory, `${agentSessionId}.jsonl`)),
  );
}

/**
 * `--session-id` takes a UUID and starts the conversation under it; `--resume` continues it.
 *
 * claude 2.1.316 prompts with the `[prompt]` positional. Its option parser (commander) dispatches
 * the first operand as a subcommand (`claude mcp --help` runs `claude mcp`), so a prompt whose
 * first word is one would run that subcommand, and `--` does not help: commander keeps the words
 * after `--` as operands and dispatches on those too. One leading space keeps the word out of both
 * roles — it is no option, and it matches no subcommand name — for `-x` and `mcp` alike.
 */
export const claude: AgentAdapter = {
  command: "claude",
  newSessionId: randomUUID,
  // Claude Code has no provider flag; a gateway is routed with ANTHROPIC_BASE_URL/AUTH_TOKEN.
  launchArgs: (model) => (model === null ? [] : ["--model", model]),
  startArgs: (id) => (id === null ? [] : ["--session-id", id]),
  resumeArgs: (id) => ["--resume", id],
  promptArgs: (prompt) => [` ${prompt}`],
  hasConversation: hasTranscript,
};

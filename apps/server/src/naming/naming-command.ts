import type { AgentKind } from "@corral/protocol/config";
import { AGENTS } from "../agents/agents.ts";

/** The agent `[naming]` resolved to, and the model/provider a profile or the section chose. */
export interface NamingLaunch {
  kind: AgentKind;
  model: string | null;
  provider: string | null;
}

/**
 * argv for one unattended naming request: the agent's own model/provider flags, its
 * non-interactive mode with no session saved and no tools, then the prompt. Each flag was checked
 * against the installed CLI's `--help` (see docs/agent-profiles.md).
 *
 * `undefined` for OpenCode: `opencode run` has no way to avoid saving a session (2.2.5), and a
 * naming run must leave nothing behind. The config refuses it before this point; this keeps a
 * direct caller honest.
 */
export function namingArgs(launch: NamingLaunch, prompt: string): string[] | undefined {
  const adapter = AGENTS[launch.kind];
  const model = adapter.launchArgs(launch.model, launch.provider);
  switch (launch.kind) {
    case "claude":
      // `--tools` is variadic, so its one empty value sits before the next option, not at the end
      // where the prompt positional would be read as another tool name.
      return [
        "-p",
        "--tools",
        "",
        "--no-session-persistence",
        ...model,
        ...adapter.promptArgs(prompt),
      ];
    case "pi":
      return ["-p", "--no-session", "--no-tools", ...model, ...adapter.promptArgs(prompt)];
    case "codex":
      return [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        ...model,
        ...adapter.promptArgs(prompt),
      ];
    case "opencode":
      return undefined;
  }
  return undefined;
}

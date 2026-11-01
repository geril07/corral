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
 * non-interactive mode with no session saved and no tools where the agent has such a mode, then
 * the prompt. Each flag was checked against the installed CLI's `--help` (see
 * docs/agent-profiles.md).
 *
 * Codex has no flag that removes its read-only tools, so it runs with the read-only sandbox and
 * approvals disabled: it can read inside the empty temporary directory, and cannot write or ask
 * to. Claude and pi disable tools outright.
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
      // `-s read-only` overrides the user's `~/.codex/config.toml`; `approval_policy=never`
      // keeps an unattended run from waiting on an approval prompt.
      return [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-c",
        "approval_policy=never",
        ...model,
        ...adapter.promptArgs(prompt),
      ];
    case "opencode":
      return undefined;
  }
  return undefined;
}

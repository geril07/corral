import type { AgentKind } from "@corral/protocol/config";

// Pi's parser treats positional tokens as prompts and unknown flags as extension flags:
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/cli/args.ts
// This is deliberately a Pi-only metadata boundary, not a universal safe-flag list. Model and
// provider are exclusively the typed profile fields; mode, session, resume and prompt belong to
// Corral. No equals forms are accepted. Extension-specific flags cannot be distinguished safely
// from a flag whose following value becomes a prompt, so they are refused.
const PI_SWITCHES = new Set([
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-tools",
  "--no-mcp",
  "--offline",
  "--verbose",
]);
const PI_VALUES = new Set(["--extension", "--skill", "--prompt-template", "--theme"]);

/** Returns a safe, non-echoing error, or the original argv when the metadata driver supports it. */
export function instanceArgsProblem(kind: AgentKind, args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (kind !== "pi") return "Extra arguments are not supported for this agent's model discovery.";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (PI_SWITCHES.has(arg)) continue;
    if (PI_VALUES.has(arg)) {
      const value = args[++i];
      if (value !== undefined && value !== "" && !value.startsWith("-")) continue;
    }
    return "The instance has unsupported or Corral-owned Pi arguments. Check its configuration.";
  }
  return undefined;
}

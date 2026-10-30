import type { AgentKind } from "@corral/protocol/config";

/** A native model id, passed as one argv value: no whitespace and no control characters. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** A native provider id. Codex receives it in `-c model_provider=…`, so no TOML punctuation. */
export const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface LaunchChoice {
  kind: AgentKind;
  model?: string | null;
  provider?: string | null;
}

export interface LaunchChoiceProblem {
  field: "model" | "provider";
  message: string;
}

/**
 * What each agent CLI in `docs/agent-profiles.md` accepts on its launch command. The same rules
 * validate a profile in the config file and a model override on `sessions.start`, so neither can
 * claim a choice the agent would silently ignore.
 *
 * - Claude Code has `--model` and no provider flag; a gateway is routed by environment variables.
 * - Codex has `--model` and `-c model_provider=<native id>`; `-p/--profile` would layer a user
 *   config file and is never used.
 * - pi has `--provider` together with `--model`, and its model id may carry `provider/id` and
 *   `:thinking`.
 * - OpenCode 2.1.4 has no model or provider flag on its root TUI command; a profile is env-only.
 */
export function launchChoiceProblems({
  kind,
  model,
  provider,
}: LaunchChoice): LaunchChoiceProblem[] {
  const problems: LaunchChoiceProblem[] = [];
  if (model !== undefined && model !== null) {
    if (kind === "opencode") {
      problems.push({
        field: "model",
        message: "opencode has no model flag on its launch command; a profile for it is env-only",
      });
    } else if (!MODEL_ID.test(model)) {
      problems.push({
        field: "model",
        message: "the model is not a valid native model id (letters, digits, . _ : / @ + -)",
      });
    }
  }
  if (provider !== undefined && provider !== null) {
    if (kind === "claude") {
      problems.push({
        field: "provider",
        message: "claude has no provider flag; route it with environment references instead",
      });
    } else if (kind === "opencode") {
      problems.push({
        field: "provider",
        message:
          "opencode has no provider flag on its launch command; a profile for it is env-only",
      });
    } else if (!PROVIDER_ID.test(provider)) {
      problems.push({
        field: "provider",
        message: "the provider is not a valid native provider id (letters, digits, . _ -)",
      });
    } else if (kind === "pi" && (model === undefined || model === null)) {
      problems.push({
        field: "provider",
        message: "pi needs a model together with its provider",
      });
    }
  }
  return problems;
}

/** Whether the agent has a launch flag for a model at all. */
export function supportsModel(kind: AgentKind): boolean {
  return kind !== "opencode";
}

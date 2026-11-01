import {
  defaultNamingSettings,
  namingConfigured,
  type AgentKind,
  type LaunchProfile,
  type NamingSettings,
} from "@corral/protocol/config";
import type { EnvRef } from "@corral/protocol/config";
import type { NamingLaunch } from "./naming-command.ts";
import type { NamingName } from "./naming-output.ts";
import { namingPrompt } from "./naming-prompt.ts";
import { parseNamingOutput } from "./naming-output.ts";
import { AGENTS } from "../agents/agents.ts";
import { runNaming } from "./naming-run.ts";

/** What task creation needs from the config to name a task: `[naming]` and the profiles it may use. */
export interface NamingSettingsSource {
  settings(): NamingSettings;
  profiles(): readonly LaunchProfile[];
  /** The executable `[agents.<kind>].command` names, when the source knows it. */
  command?(kind: AgentKind): string;
}

/** Naming that runs nothing: the seed title stays (decision 16). */
export function disabledNaming(): NamingSettingsSource {
  return { settings: defaultNamingSettings, profiles: () => [] };
}

/** One resolved naming run: who to start, with what environment, and how long to wait. */
export interface NamingPlan {
  launch: NamingLaunch;
  /** The executable the run spawns: `[agents.<kind>].command`, else the agent's own name. */
  command: string;
  env: readonly EnvRef[];
  profileId: string | null;
  timeoutMs: number;
  /** Whether the request also asks for the branch and worktree slugs. */
  generatedSlug: boolean;
}

/**
 * `[naming]` resolved to a runnable agent, or `undefined` when there is nothing to run. A profile
 * wins over an agent and contributes its model, provider and environment references; a model in
 * the section overrides the profile's. OpenCode cannot name (it has no non-interactive mode that
 * saves no session) and the config refuses it; a direct caller is refused here too.
 */
export function namingPlan(
  source: NamingSettingsSource,
  options: { generatedSlug: boolean },
): NamingPlan | undefined {
  const settings = source.settings();
  if (!namingConfigured(settings)) return undefined;
  const profileId = settings.profile.value;
  const profile =
    profileId === null
      ? undefined
      : source.profiles().find((candidate) => candidate.id === profileId);
  if (profileId !== null && profile === undefined) {
    logNamingProblem(`no usable launch profile: ${profileId}`);
    return undefined;
  }
  const kind = profile?.agent ?? settings.agent.value;
  if (kind === null || kind === undefined) return undefined;
  if (kind === "opencode") {
    logNamingProblem("opencode cannot run without saving a session");
    return undefined;
  }
  return {
    launch: {
      kind,
      model: settings.model.value ?? profile?.model ?? null,
      provider: profile?.provider ?? null,
    },
    command: source.command?.(kind) ?? AGENTS[kind].command,
    env: profile?.env ?? [],
    profileId: profile?.id ?? null,
    timeoutMs: Math.round(settings.timeoutSeconds.value * 1000),
    generatedSlug: options.generatedSlug,
  };
}

/**
 * One naming request, from the template to the parsed name. A failure is logged and becomes
 * `undefined`, so the caller keeps the seed title; nothing is retried in stage A.
 */
export async function requestName(
  plan: NamingPlan,
  input: { prompt: string; projectName: string },
): Promise<NamingName | undefined> {
  const prompt = namingPrompt({
    prompt: input.prompt,
    projectName: input.projectName,
    generatedSlug: plan.generatedSlug,
  });
  const run = await runNaming({
    launch: plan.launch,
    command: plan.command,
    env: plan.env,
    profileId: plan.profileId,
    timeoutMs: plan.timeoutMs,
    prompt,
  });
  if (!run.ok) {
    logNamingProblem(run.reason);
    return undefined;
  }
  const parsed = parseNamingOutput(run.stdout, { generatedSlug: plan.generatedSlug });
  if (!parsed.ok) {
    logNamingProblem(parsed.reason);
    return undefined;
  }
  return parsed.name;
}

/** One line about a naming request that did not name the task; never the prompt or a secret. */
export function logNamingProblem(reason: string): void {
  console.warn(`corral-server: task naming: ${reason}`);
}

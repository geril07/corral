import {
  AGENT_LAUNCH_CAPABILITY,
  NATIVE_MODEL_ID,
  type AgentSettings,
  type LaunchProfile,
  type ResolvedTaskSettings,
  type TaskView,
} from "@corral/protocol/config";
import { AGENTS } from "@corral/client/session-state";
import type { AgentKind } from "@corral/protocol/rpc";

export interface AgentLaunchChoice {
  kind: AgentKind;
  profileId?: string;
  expectedProfileRevision?: string;
  model?: string;
  view?: TaskView;
}

/** A user selection pins its profile; live config updates cannot silently substitute a launch. */
export interface LaunchSelection {
  kind: AgentKind;
  profile: Pick<LaunchProfile, "id" | "name" | "revision" | "model" | "provider"> | null;
  /** Raw input, including an unfinished/invalid native ID. Only submit trims and validates it. */
  model: string;
}

export function supportsModel(kind: AgentKind): boolean {
  return AGENT_LAUNCH_CAPABILITY[kind].model;
}

export function modelOverride(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function modelProblem(kind: AgentKind, text: string): string | undefined {
  const model = modelOverride(text);
  if (model === undefined || !supportsModel(kind)) return undefined;
  return NATIVE_MODEL_ID.test(model)
    ? undefined
    : "Use a native model id (letters, digits and . _ : / @ + - only).";
}

export function launchKey(selection: LaunchSelection): string {
  return selection.profile
    ? `profile:${selection.profile.id}:${selection.profile.revision}`
    : `native:${selection.kind}`;
}

export function launchName(selection: LaunchSelection): string {
  return selection.profile?.name ?? selection.kind;
}

export function launchModel(selection: LaunchSelection): string {
  return (
    (supportsModel(selection.kind)
      ? (modelOverride(selection.model) ?? selection.profile?.model)
      : undefined) ?? "Agent default"
  );
}

export function launchChoice(selection: LaunchSelection): AgentLaunchChoice {
  const model = supportsModel(selection.kind) ? modelOverride(selection.model) : undefined;
  return {
    kind: selection.kind,
    ...(selection.profile
      ? { profileId: selection.profile.id, expectedProfileRevision: selection.profile.revision }
      : {}),
    ...(model ? { model } : {}),
  };
}

export function launchOptions(
  profiles: readonly LaunchProfile[],
  agents: AgentSettings,
): LaunchSelection[] {
  return [
    ...AGENTS.filter((kind) => agents[kind].enabled.value).map((kind) => ({
      kind,
      profile: null,
      model: "",
    })),
    ...profiles
      .filter((profile) => agents[profile.agent].enabled.value)
      .map((profile) => ({
        kind: profile.agent,
        profile: {
          id: profile.id,
          name: profile.name,
          revision: profile.revision,
          model: profile.model,
          provider: profile.provider,
        },
        model: "",
      })),
  ];
}

export function defaultLaunch(
  settings: ResolvedTaskSettings,
  profiles: readonly LaunchProfile[],
  agents: AgentSettings,
): LaunchSelection | undefined {
  const choices = launchOptions(profiles, agents);
  const profile = choices.find((choice) => choice.profile?.id === settings.profile.value);
  const selected =
    profile ??
    choices.find((choice) => choice.profile === null && choice.kind === settings.agent.value) ??
    choices[0];
  return selected ? { ...selected, model: settings.model.value ?? "" } : undefined;
}

export function launchProblem(
  selection: LaunchSelection,
  profiles: readonly LaunchProfile[],
  agents: AgentSettings,
): string | undefined {
  if (!agents[selection.kind].enabled.value)
    return `The ${selection.kind} agent is disabled in the config file. Choose another agent.`;
  if (selection.profile) {
    const current = profiles.find((profile) => profile.id === selection.profile?.id);
    if (!current)
      return `The profile "${selection.profile.name}" is no longer in the config file. Choose an agent or another profile.`;
    if (current.revision !== selection.profile.revision)
      return `The profile "${current.name}" changed in the config file. Review it and choose it again.`;
  }
  return modelProblem(selection.kind, selection.model);
}

/** Explicit user/project settings win; only a missing driver falls back to the terminal. */
export function launchView(
  settings: ResolvedTaskSettings,
  kind: AgentKind | undefined,
  chatDrivers: readonly AgentKind[],
): TaskView {
  return settings.view.value === "chat" && kind !== undefined && chatDrivers.includes(kind)
    ? "chat"
    : "terminal";
}

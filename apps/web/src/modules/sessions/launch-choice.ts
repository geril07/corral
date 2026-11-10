import {
  AGENT_LAUNCH_CAPABILITY,
  NATIVE_MODEL_ID,
  type AgentSettings,
  type LaunchProfile,
  type ResolvedTaskSettings,
  type TaskView,
} from "@corral/protocol/config";
import type { ChatModel, ChatModelRef } from "@corral/protocol/chat";
import { modelKey, modelScopeKey, type ModelScope } from "@corral/protocol/models";
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

export function launchScope(selection: LaunchSelection): ModelScope {
  return { kind: selection.kind, profileId: selection.profile?.id ?? null };
}

/** A pinned native provider is a launch constraint, not a menu visibility rule. */
export function catalogLaunchModel(
  selection: LaunchSelection,
  model: ChatModelRef,
): string | undefined {
  if (!supportsModel(selection.kind)) return undefined;
  if (selection.profile?.provider && model.provider !== selection.profile.provider)
    return undefined;
  const id =
    selection.kind === "pi" && model.provider && !selection.profile?.provider
      ? `${model.provider}/${model.id}`
      : model.id;
  return modelProblem(selection.kind, id) ? undefined : id;
}

export const CONFIGURED_DEFAULT = "Configured default";

/** The synthetic current row a launch needs when no visible catalog row names its model. */
export const CURRENT_ROW_KEY = "current";

export function launchCurrentModelRow(
  selection: LaunchSelection,
  catalog: readonly ChatModelRef[],
  visible: readonly string[],
  blocked = false,
) {
  const model = launchModel(selection);
  if (model === undefined) return undefined;
  const row = launchCatalogRow(selection, catalog);
  if (row !== undefined && visible.includes(modelKey(row))) return undefined;
  return {
    key: CURRENT_ROW_KEY,
    name: model,
    current: true,
    disabled: blocked,
    detail: row === undefined ? CONFIGURED_DEFAULT : "Current · hidden by filter",
  };
}

/** The catalog row a launch selection names; one mapping for the picker and the manager. */
export function launchCatalogRow<T extends ChatModelRef>(
  selection: LaunchSelection,
  models: readonly T[],
): T | undefined {
  const selectedId = modelOverride(selection.model) ?? selection.profile?.model;
  const candidates = models.filter(
    (model) =>
      catalogLaunchModel(selection, model) !== undefined &&
      (catalogLaunchModel(selection, model) === selectedId || model.id === selectedId),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The row the configured default launch uses in `scope`; no row when it cannot launch there. */
export function configuredDefaultRow(
  scope: ModelScope,
  settings: ResolvedTaskSettings,
  profiles: readonly LaunchProfile[],
  agents: AgentSettings,
  models: readonly ChatModel[],
): ChatModel | undefined {
  const selection = defaultLaunch(settings, profiles, agents);
  if (
    !selection ||
    modelScopeKey(launchScope(selection)) !== modelScopeKey(scope) ||
    launchProblem(selection, profiles, agents) !== undefined
  )
    return undefined;
  return launchCatalogRow(selection, models);
}

export function launchName(selection: LaunchSelection): string {
  return selection.profile?.name ?? selection.kind;
}

/** The model this launch names: an override, else the pinned profile's, else none. */
export function launchModel(selection: LaunchSelection): string | undefined {
  if (!supportsModel(selection.kind)) return undefined;
  const model = modelOverride(selection.model) ?? selection.profile?.model ?? undefined;
  return model === "" ? undefined : model;
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
      .filter((profile) => profile.enabled !== false && agents[profile.agent].enabled.value)
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
    // A disabled instance is not offered, but a retained selection still names it; the server
    // refuses the launch, so the picker says why before the request exists.
    if (current.enabled === false)
      return `The profile "${current.name}" is disabled in the config file. Choose an agent or another profile.`;
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

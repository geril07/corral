import { AGENTS } from "@corral/client/session-state";
import type { LaunchProfile, ResolvedTaskSettings } from "@corral/protocol/config";
import type { AgentKind, CreateTaskInput } from "@corral/protocol/rpc";
import type { AgentLaunchChoice } from "../sessions/index.ts";

/**
 * One entry of the composer's agent · model picker: a native agent or a pinned profile revision,
 * and what `tasks.create` should receive for it. The server resolves the settings; this only
 * renders the choice they amount to (`design.md`, decision 17).
 */
export interface ComposerAgent {
  /** The picker's and the list's value: `native:<kind>` or `profile:<id>:<revision>`. */
  key: string;
  /** What the trigger shows: `${agent} · ${model}` (`layout.md`, **New task view**). */
  label: string;
  choice: AgentLaunchChoice;
}

/** Native agents first, then the config's profiles in file order. */
export function agentChoices(profiles: readonly LaunchProfile[]): ComposerAgent[] {
  return [
    ...AGENTS.map((kind) => nativeAgent(kind, undefined)),
    ...profiles.map((profile) => profileAgent(profile, undefined)),
  ];
}

/**
 * What A0's resolved settings mean for the composer, honoring the server's precedence: a profile
 * wins over an agent, and the model setting overrides the profile's model. A profile the config
 * no longer carries falls back to the configured agent, so a request never carries a stale id.
 */
export function defaultAgent(
  settings: ResolvedTaskSettings,
  profiles: readonly LaunchProfile[],
): ComposerAgent {
  const model = settings.model.value ?? undefined;
  const profile =
    settings.profile.value === null
      ? undefined
      : profiles.find((candidate) => candidate.id === settings.profile.value);
  if (profile !== undefined) return profileAgent(profile, model);
  return nativeAgent(settings.agent.value ?? AGENTS[0] ?? "claude", model);
}

function nativeAgent(kind: AgentKind, model: string | undefined): ComposerAgent {
  return {
    key: `native:${kind}`,
    label: `${kind} · ${model ?? "native default"}`,
    choice: { kind, ...(model === undefined ? {} : { model }) },
  };
}

function profileAgent(profile: LaunchProfile, model: string | undefined): ComposerAgent {
  return {
    key: `profile:${profile.id}:${profile.revision}`,
    label: `${profile.name} · ${model ?? profile.model ?? "agent default"}`,
    choice: {
      kind: profile.agent,
      profileId: profile.id,
      expectedProfileRevision: profile.revision,
      ...(model === undefined ? {} : { model }),
    },
  };
}

/** One entry of the workspace picker (`layout.md`: "main tree" / "new worktree" / branch). */
export interface ComposerWorkspace {
  key: string;
  label: string;
  input: CreateTaskInput["workspace"];
}

export const MAIN_TREE = "main-tree";
export const NEW_WORKTREE = "new-worktree";

/** The main working tree, a new worktree, then every existing branch, in that order. */
export function workspaceChoices(branches: readonly string[]): ComposerWorkspace[] {
  return [
    { key: MAIN_TREE, label: "main tree", input: { type: "main-worktree" } },
    { key: NEW_WORKTREE, label: "new worktree", input: { type: "new-branch" } },
    ...branches.map((branch): ComposerWorkspace => ({
      key: branchKey(branch),
      label: branch,
      input: { type: "existing-branch", branch },
    })),
  ];
}

/** What A0 resolved for the project: a new worktree or the project's main working tree. */
export function defaultWorkspace(settings: ResolvedTaskSettings): ComposerWorkspace {
  const key = settings.workspace.value === "new-worktree" ? NEW_WORKTREE : MAIN_TREE;
  return workspaceChoices([]).find((choice) => choice.key === key)!;
}

/** The picker value of an existing branch. */
export function branchKey(branch: string): string {
  return `branch:${branch}`;
}

/** Whether the workspace choice is an existing branch, which belongs to the project it came from. */
export function isBranchKey(key: string): boolean {
  return key.startsWith("branch:");
}

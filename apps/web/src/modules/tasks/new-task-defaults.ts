import { AGENTS } from "@corral/client/session-state";
import type {
  AgentSettings,
  LaunchProfile,
  ResolvedTaskSettings,
  TaskView,
} from "@corral/protocol/config";
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

/**
 * Native agents first, then the config's profiles in file order. A `[agents.<kind>]` table that
 * disabled an agent takes it — and every profile that launches it — out of every picker.
 */
export function agentChoices(
  profiles: readonly LaunchProfile[],
  agents: AgentSettings,
): ComposerAgent[] {
  return [
    ...AGENTS.filter((kind) => agents[kind].enabled.value).map((kind) =>
      nativeAgent(kind, undefined),
    ),
    ...profiles
      .filter((profile) => agents[profile.agent].enabled.value)
      .map((profile) => profileAgent(profile, undefined)),
  ];
}

/**
 * What A0's resolved settings mean for the composer, honoring the server's precedence: a profile
 * wins over an agent, and the model setting overrides the profile's model. A profile the config
 * no longer carries falls back to the configured agent, so a request never carries a stale id;
 * `undefined` means every agent is disabled, and the composer starts no agent at all.
 */
export function defaultAgent(
  settings: ResolvedTaskSettings,
  profiles: readonly LaunchProfile[],
  agents: AgentSettings,
): ComposerAgent | undefined {
  const model = settings.model.value ?? undefined;
  const profile =
    settings.profile.value === null
      ? undefined
      : profiles.find(
          (candidate) =>
            candidate.id === settings.profile.value && agents[candidate.agent].enabled.value,
        );
  if (profile !== undefined) return profileAgent(profile, model);
  const configured = settings.agent.value;
  const kind =
    configured !== null && agents[configured].enabled.value
      ? configured
      : AGENTS.find((candidate) => agents[candidate].enabled.value);
  return kind === undefined ? undefined : nativeAgent(kind, model);
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

/** One entry of the composer's view picker (`layout.md`, **New task view**). */
export interface ComposerView {
  key: TaskView;
  label: string;
}

/**
 * The views the composer may offer for the agent picked now: the terminal always, chat only when
 * `chat.capabilities` reports a driver for it (goal D7). A configured `chat` view for another
 * agent therefore shows as the terminal here, not as a choice that would be refused.
 */
export function viewChoices(
  kind: AgentKind | undefined,
  chatDrivers: readonly AgentKind[],
): ComposerView[] {
  const views: ComposerView[] = [{ key: "terminal", label: "terminal" }];
  if (kind !== undefined && chatDrivers.includes(kind)) views.push({ key: "chat", label: "chat" });
  return views;
}

/** The settings' view when it applies to this agent, else the terminal. */
export function defaultView(
  settings: ResolvedTaskSettings,
  kind: AgentKind | undefined,
  chatDrivers: readonly AgentKind[],
): ComposerView {
  const choices = viewChoices(kind, chatDrivers);
  const wanted = settings.view.value === "chat" ? "chat" : "terminal";
  return choices.find((choice) => choice.key === wanted) ?? choices[0]!;
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

import type { NamingSettings, ResolvedTaskSettings, SettingSource } from "@corral/protocol/config";

/**
 * The rows the task sections and the search index share. A key is stable: it names the row's DOM
 * id (`settings-defaults-<key>`), so a search result and the row it reveals cannot drift.
 */
export interface TaskSettingRow {
  key: string;
  label: string;
  value: string;
  source: SettingSource;
}

/** The values task creation and the composer use, each with the layer it resolved from. */
export function taskSettingRows(settings: ResolvedTaskSettings): TaskSettingRow[] {
  return [
    {
      key: "agent",
      label: "Agent",
      value: settings.agent.value ?? "none",
      source: settings.agent.source,
    },
    {
      key: "profile",
      label: "Launch profile",
      value: settings.profile.value ?? "none",
      source: settings.profile.source,
    },
    {
      key: "model",
      label: "Model",
      value: settings.model.value ?? "agent default",
      source: settings.model.source,
    },
    {
      key: "workspace",
      label: "Workspace",
      value: settings.workspace.value,
      source: settings.workspace.source,
    },
    {
      key: "worktree-root",
      label: "Worktree root",
      value: settings.worktreeRoot.value,
      source: settings.worktreeRoot.source,
    },
    {
      key: "branch-prefix",
      label: "Branch prefix",
      value: settings.branchPrefix.value === "" ? "none" : settings.branchPrefix.value,
      source: settings.branchPrefix.source,
    },
    {
      key: "slug-mode",
      label: "Slug mode",
      value: settings.slugMode.value,
      source: settings.slugMode.source,
    },
    { key: "view", label: "View", value: settings.view.value, source: settings.view.source },
  ];
}

/** `[naming]`, and the layer each value came from (`design.md`, decision 16). */
export function namingSettingRows(naming: NamingSettings): TaskSettingRow[] {
  return [
    {
      key: "profile",
      label: "Launch profile",
      value: naming.profile.value ?? "none",
      source: naming.profile.source,
    },
    {
      key: "agent",
      label: "Agent",
      value: naming.agent.value ?? "none",
      source: naming.agent.source,
    },
    {
      key: "model",
      label: "Model",
      value: naming.model.value ?? "agent default",
      source: naming.model.source,
    },
    {
      key: "timeout",
      label: "Timeout",
      value: `${naming.timeoutSeconds.value} seconds`,
      source: naming.timeoutSeconds.source,
    },
  ];
}

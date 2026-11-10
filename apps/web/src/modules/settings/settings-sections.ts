import type { IconName } from "../../common/ui/index.ts";

/**
 * Settings navigation: one group per subject, one entry per section. The sidebar renders this
 * order, and the content repeats the active label. Descriptions are one sentence; the search
 * index never reads them (`settings-search.ts`).
 */
export const SETTINGS_GROUPS = [
  { heading: "General", sections: ["appearance", "keyboard"] },
  { heading: "Tasks", sections: ["defaults", "naming"] },
  { heading: "Agents", sections: ["profiles", "agents"] },
  { heading: "Models", sections: ["models"] },
  { heading: "Code", sections: ["projects"] },
  { heading: "Diagnostics", sections: ["diagnostics"] },
] as const;

export const SETTINGS_SECTIONS = {
  appearance: {
    title: "Appearance",
    description: "Saved on this device; model preferences are shared.",
    icon: "appearance",
  },
  keyboard: {
    title: "Keyboard",
    description: "The key each action runs from. Edit config.toml to change a binding.",
    icon: "keyboard",
  },
  defaults: {
    title: "Defaults",
    description: "What a new task starts with, and the layer each value came from.",
    icon: "defaults",
  },
  naming: {
    title: "Naming",
    description: "How a task, its branch and its worktree get named.",
    icon: "naming",
  },
  profiles: {
    title: "Profiles",
    description: "Named launch choices and the server environment they pass through.",
    icon: "profiles",
  },
  agents: {
    title: "Agents",
    description: "Which agents this server offers, and whether this build can chat with them.",
    icon: "agent",
  },
  models: {
    title: "Models",
    description: "Menu visibility per agent or profile. This never changes permissions.",
    icon: "models",
  },
  projects: {
    title: "Projects",
    description: "Per-project task settings, read from config.toml.",
    icon: "project",
  },
  diagnostics: {
    title: "Diagnostics",
    description: "The file Corral reads and the entries it refused.",
    icon: "diagnostics",
  },
} as const satisfies Record<string, { title: string; description: string; icon: IconName }>;

export type SettingsSectionId = keyof typeof SETTINGS_SECTIONS;

export const SETTINGS_SECTION_IDS = SETTINGS_GROUPS.flatMap((group) => group.sections);

export function settingsTitle(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS[id].title;
}

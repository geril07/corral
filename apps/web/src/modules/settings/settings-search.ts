import {
  ActionId,
  AgentKind,
  DIRECT_ACTION_LABELS,
  DirectActionId,
  taskSettingsFor,
  type ClientConfig,
  type LaunchProfile,
} from "@corral/protocol/config";
import type { Project } from "@corral/protocol/rpc";
import { ACTION_LABELS } from "../keymap/index.ts";
import { taskSettingRows } from "./task-settings-rows.ts";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-sections.ts";

/**
 * One searchable row. `id` is the row's DOM id unless `targetId` names a shared destination (a
 * project result selects the project, then reveals the selected-project header). Only the title,
 * the section label and the authored aliases enter the index; descriptions are prose, not names.
 */
export interface SettingsSearchItem {
  id: string;
  title: string;
  section: SettingsSectionId;
  aliases?: readonly string[];
  /** Generated rows (actions, profiles, agents, projects) rank after authored settings. */
  secondary?: boolean;
  targetId?: string;
  /** Selecting the result selects this project before revealing the target. */
  projectPath?: string;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** T3's ranking: exact title, title prefix, title substring, all tokens in the title, phrase. */
export function rankSettingsSearchItem(
  item: SettingsSearchItem,
  normalizedQuery: string,
): number | undefined {
  const queryTokens = normalizedQuery.split(" ");
  const title = normalizeSearchText(item.title);
  const fields = [
    title,
    normalizeSearchText(SETTINGS_SECTIONS[item.section].title),
    ...(item.aliases ?? []).map(normalizeSearchText),
  ];
  if (!queryTokens.every((token) => fields.some((field) => field.includes(token))))
    return undefined;
  if (title === normalizedQuery) return 5;
  if (title.startsWith(normalizedQuery)) return 4;
  if (title.includes(normalizedQuery)) return 3;
  if (queryTokens.every((token) => title.includes(token))) return 2;
  if (fields.some((field) => field.includes(normalizedQuery))) return 1;
  return 0;
}

/** Results in rank order; generated high-volume rows follow real settings at the same rank. */
export function searchSettings(
  query: string,
  items: readonly SettingsSearchItem[],
): SettingsSearchItem[] {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  return items
    .flatMap((item, index) => {
      const rank = rankSettingsSearchItem(item, normalizedQuery);
      return rank === undefined ? [] : [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

const ACTION_ITEMS: readonly SettingsSearchItem[] = ActionId.options.map((action) => ({
  id: `settings-keyboard-binding-${action}`,
  title: ACTION_LABELS[action],
  section: "keyboard",
  aliases: [action],
  secondary: true,
}));

const DIRECT_ITEMS: readonly SettingsSearchItem[] = DirectActionId.options.map((action) => ({
  id: `settings-keyboard-direct-${action}`,
  title: DIRECT_ACTION_LABELS[action],
  section: "keyboard",
  aliases: [action, "direct command"],
  secondary: true,
}));

const DEFAULT_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: "settings-defaults-agent",
    title: "Agent",
    section: "defaults",
    aliases: ["default agent", "runtime"],
  },
  {
    id: "settings-defaults-profile",
    title: "Launch profile",
    section: "defaults",
    aliases: ["profile", "preset"],
  },
  { id: "settings-defaults-model", title: "Model", section: "defaults", aliases: ["llm"] },
  {
    id: "settings-defaults-workspace",
    title: "Workspace",
    section: "defaults",
    aliases: ["worktree mode", "checkout"],
  },
  {
    id: "settings-defaults-worktree-root",
    title: "Worktree root",
    section: "defaults",
    aliases: ["worktrees", "path"],
  },
  {
    id: "settings-defaults-branch-prefix",
    title: "Branch prefix",
    section: "defaults",
    aliases: ["branch"],
  },
  {
    id: "settings-defaults-slug-mode",
    title: "Slug mode",
    section: "defaults",
    aliases: ["title", "generated"],
  },
  {
    id: "settings-defaults-view",
    title: "View",
    section: "defaults",
    aliases: ["chat", "terminal", "default view"],
  },
];

const NAMING_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: "settings-naming-profile",
    title: "Naming profile",
    section: "naming",
    aliases: ["launch profile", "title"],
  },
  {
    id: "settings-naming-agent",
    title: "Naming agent",
    section: "naming",
    aliases: ["title", "runtime"],
  },
  {
    id: "settings-naming-model",
    title: "Naming model",
    section: "naming",
    aliases: ["title", "llm"],
  },
  {
    id: "settings-naming-timeout",
    title: "Naming timeout",
    section: "naming",
    aliases: ["seconds", "title"],
  },
];

const AUTHORED_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: "settings-appearance-tabs",
    title: "Session tab position",
    section: "appearance",
    aliases: ["tabs", "top", "bottom"],
  },
  {
    id: "settings-appearance-scale",
    title: "Interface text scale",
    section: "appearance",
    aliases: ["zoom", "font size", "ui scale"],
  },
  {
    id: "settings-keyboard-prefix",
    title: "Prefix key",
    section: "keyboard",
    aliases: ["leader", "prefix"],
  },
  {
    id: "settings-profiles-list",
    title: "Launch profiles",
    section: "profiles",
    aliases: ["profiles", "environment", "command"],
    targetId: "settings-panel-profiles-title",
  },
  {
    id: "settings-agents-list",
    title: "Agent commands",
    section: "agents",
    aliases: ["enabled", "command", "executable"],
    targetId: "settings-panel-agents-title",
  },
  {
    id: "settings-models-preferences",
    title: "Model visibility",
    section: "models",
    aliases: ["catalog", "favorites", "allow", "deny", "order"],
  },
  {
    id: "settings-projects-picker",
    title: "Project settings",
    section: "projects",
    aliases: ["overrides", "per-project", "repository"],
    targetId: "settings-panel-projects-title",
  },
  {
    id: "settings-diagnostics-path",
    title: "Config file path",
    section: "diagnostics",
    aliases: ["config.toml", "location", "copy"],
  },
  {
    id: "settings-diagnostics-problems",
    title: "Config problems",
    section: "diagnostics",
    aliases: ["errors", "warnings", "rejected"],
  },
];

function projectName(path: string): string {
  if (path === "") return "No project";
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * The full index: authored rows, generated action and profile rows, and project rows. A project
 * row selects its project before revealing the selected-project header, so it needs no row of its
 * own to exist yet.
 */
export function settingsSearchItems({
  config,
  profiles,
  projects,
  selectedProjectPath,
}: {
  config: ClientConfig;
  profiles: readonly LaunchProfile[];
  projects: readonly Project[];
  selectedProjectPath: string | undefined;
}): SettingsSearchItem[] {
  const addedPaths = new Set(projects.map((project) => project.path));
  const configPaths = Object.keys(config.projects);
  const projectRows: SettingsSearchItem[] = [
    ...projects.map((project) => ({
      id: `settings-project-${project.id}`,
      title: project.name,
      section: "projects" as const,
      aliases: [project.path],
      secondary: true,
      targetId: "settings-projects-selected",
      projectPath: project.path,
    })),
    ...configPaths
      .filter((path) => !addedPaths.has(path))
      .map((path) => ({
        id: `settings-project-config-${path}`,
        title: projectName(path),
        section: "projects" as const,
        aliases: [path, "not added"],
        secondary: true,
        targetId: "settings-projects-selected",
        projectPath: path,
      })),
  ];
  const profileRows: SettingsSearchItem[] = profiles.map((profile) => ({
    id: `settings-profile-${profile.id}`,
    title: profile.name,
    section: "profiles",
    aliases: [profile.id, profile.agent, profile.model ?? "", profile.provider ?? ""].filter(
      (part) => part !== "",
    ),
    secondary: true,
  }));
  const agentRows: SettingsSearchItem[] = AgentKind.options.map((kind) => ({
    id: `settings-agent-${kind}`,
    title: kind,
    section: "agents",
    aliases: ["agent", "command", "found", "chat"],
    secondary: true,
  }));
  const taskRows: SettingsSearchItem[] =
    selectedProjectPath === undefined
      ? []
      : taskSettingRows(taskSettingsFor(config, selectedProjectPath)).map((row) => ({
          id: `settings-project-${row.key}`,
          title: row.label,
          section: "projects" as const,
          aliases: [row.label, "project task setting"],
          secondary: true,
        }));
  return [
    ...AUTHORED_ITEMS,
    ...DEFAULT_ITEMS,
    ...NAMING_ITEMS,
    ...taskRows,
    ...profileRows,
    ...agentRows,
    ...projectRows,
    ...ACTION_ITEMS,
    ...DIRECT_ITEMS,
  ];
}

import type { ActionId, ClientConfig } from "@corral/protocol/config";

export type ActionGroup = "Sessions" | "Tasks" | "Projects" | "Navigation" | "General";

export interface ActionEntry {
  label: string;
  group: ActionGroup;
  /** False when the action cannot do anything in the current state; the palette shows it disabled. */
  enabled: boolean;
  run: () => void;
}

/** Every action the keymap dispatches and the command palette lists, in one table. */
export type ActionTable = Record<ActionId, ActionEntry>;

/** The group order the palette and the settings surface keep. */
export const ACTION_GROUPS: readonly ActionGroup[] = [
  "Sessions",
  "Tasks",
  "Projects",
  "Navigation",
  "General",
];

/** Names that do not depend on the current state; the settings surface lists every action. */
export const ACTION_LABELS: Readonly<Record<ActionId, string>> = {
  "new-terminal": "New terminal",
  "new-agent": "New agent session",
  "stop-session": "Stop session",
  "restart-session": "Restart session",
  "rename-session": "Rename session",
  "remove-session": "Remove session",
  "next-session": "Next session",
  "previous-session": "Previous session",
  "new-task": "New task",
  "remove-task": "Remove task",
  "settle-task": "Settle or unsettle task",
  "find-task": "Find task",
  "next-task": "Next task",
  "previous-task": "Previous task",
  "add-project": "Add project",
  board: "Open board",
  "jump-blocked": "Jump to blocked session",
  "command-palette": "Command palette",
  settings: "Settings",
};

export const ACTION_GROUP_OF: Readonly<Record<ActionId, ActionGroup>> = {
  "new-terminal": "Sessions",
  "new-agent": "Sessions",
  "stop-session": "Sessions",
  "restart-session": "Sessions",
  "rename-session": "Sessions",
  "remove-session": "Sessions",
  "next-session": "Sessions",
  "previous-session": "Sessions",
  "new-task": "Tasks",
  "remove-task": "Tasks",
  "settle-task": "Tasks",
  "find-task": "Tasks",
  "next-task": "Tasks",
  "previous-task": "Tasks",
  "add-project": "Projects",
  board: "Navigation",
  "jump-blocked": "Navigation",
  "command-palette": "General",
  settings: "General",
};

/** The chord after the prefix, or `null` when the user unbound the action. */
export function bindingOf(config: ClientConfig, action: ActionId): string | null {
  return config.keys.bindings[action];
}

/** `alt+a c`: the whole key press, in the config's own syntax. Unbound actions name no key. */
export function formatBinding(config: ClientConfig, action: ActionId): string {
  const binding = bindingOf(config, action);
  return binding === null ? "unbound" : `${config.keys.prefix} ${binding}`;
}

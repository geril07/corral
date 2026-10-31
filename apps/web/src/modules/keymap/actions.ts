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
  "session-1": "Go to session 1",
  "session-2": "Go to session 2",
  "session-3": "Go to session 3",
  "session-4": "Go to session 4",
  "session-5": "Go to session 5",
  "session-6": "Go to session 6",
  "session-7": "Go to session 7",
  "session-8": "Go to session 8",
  "session-9": "Go to session 9",
  "new-task": "New task",
  "remove-task": "Remove task",
  "rename-task": "Rename task",
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
  "session-1": "Sessions",
  "session-2": "Sessions",
  "session-3": "Sessions",
  "session-4": "Sessions",
  "session-5": "Sessions",
  "session-6": "Sessions",
  "session-7": "Sessions",
  "session-8": "Sessions",
  "session-9": "Sessions",
  "new-task": "Tasks",
  "remove-task": "Tasks",
  "rename-task": "Tasks",
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

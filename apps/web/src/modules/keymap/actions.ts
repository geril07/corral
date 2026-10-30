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

/** The chord after the prefix, or `null` when the user unbound the action. */
export function bindingOf(config: ClientConfig, action: ActionId): string | null {
  return config.keys.bindings[action];
}

/** `alt+a c`: the whole key press, in the config's own syntax. Unbound actions name no key. */
export function formatBinding(config: ClientConfig, action: ActionId): string {
  const binding = bindingOf(config, action);
  return binding === null ? "unbound" : `${config.keys.prefix} ${binding}`;
}

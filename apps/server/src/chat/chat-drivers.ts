import type { AgentKind } from "@corral/protocol/config";

/**
 * The agents this build can show as chat. It is a build fact, not a session's state, and it is
 * the one definition behind `chat.capabilities` (goal D7): the config file reads it to fall a
 * `chat` view back to the terminal, and Settings reads it through `ConfigState.agents`.
 */
export const CHAT_DRIVERS: readonly AgentKind[] = ["pi"];

/** Whether this build has a driver for the agent. */
export function hasChatDriver(kind: AgentKind): boolean {
  return CHAT_DRIVERS.includes(kind);
}

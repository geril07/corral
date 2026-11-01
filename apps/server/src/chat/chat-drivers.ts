import { AgentKind } from "@corral/protocol/config";
import type { ChatDriverRegistration, ChatDriverRegistry } from "./chat-driver.ts";
import { openCodeChatDriver } from "./opencode-driver.ts";
import { piChatDriver } from "./pi-driver.ts";

/**
 * The chat drivers this build ships, by agent kind: one file per driver, one line here. It is a
 * build fact, not a session's state, and it is the one definition behind `chat.capabilities`
 * (goal D7), the config file's fallback from an unsupported `chat` view to the terminal, and
 * Settings' `ConfigState.agents`. Adding a driver adds its module and this entry — `ChatService`
 * and `SessionService` need no branch for it.
 */
export const CHAT_DRIVER_REGISTRY: ChatDriverRegistry = {
  pi: piChatDriver,
  opencode: openCodeChatDriver,
};

/** The agents this build can show as chat, in the protocol's agent order. */
export const CHAT_DRIVERS: readonly AgentKind[] = AgentKind.options.filter(hasChatDriver);

/** Whether this build has a driver for the agent. */
export function hasChatDriver(kind: AgentKind): boolean {
  return chatDriverFor(kind) !== undefined;
}

/** The registration of one agent's driver, or `undefined` when this build ships none. */
export function chatDriverFor(kind: AgentKind): ChatDriverRegistration | undefined {
  return CHAT_DRIVER_REGISTRY[kind];
}

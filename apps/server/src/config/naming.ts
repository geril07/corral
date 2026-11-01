import { agentCommand, type AgentKind } from "@corral/protocol/config";
import type { NamingSettingsSource } from "../naming/naming.ts";
import type { ConfigWatcher } from "./config-watcher.ts";

/**
 * A4's naming source backed by the config: `[naming]` and the valid profiles, read on every call,
 * so a config edit applies to the next task without a restart. `[agents.<kind>].command` applies
 * to a naming run as it does to a session launch.
 */
export function configNaming(config: Pick<ConfigWatcher, "state">): NamingSettingsSource {
  return {
    settings: () => config.state().config.naming,
    profiles: () => config.state().profiles,
    command: (kind: AgentKind) => agentCommand(config.state().config, kind),
  };
}

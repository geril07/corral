import {
  defaultClientConfig,
  type AgentAvailability,
  type ClientConfig,
  type ConfigProblem,
  type ConfigState,
  type LaunchProfile,
} from "@corral/protocol/config";
import type { RpcConnection } from "./rpc-connection.ts";
import { createWatchStore, type WatchStore } from "./watch-store.ts";

export interface ConfigSnapshot {
  /** False until the server has sent the config once; the defaults apply until then. */
  loaded: boolean;
  /** Absolute path of the file the server reads. */
  path: string;
  config: ClientConfig;
  /** Valid profiles only; an invalid profile is dropped whole and reported in `problems`. */
  profiles: readonly LaunchProfile[];
  /** What the server host has for each agent: found on the machine, and a chat driver or not. */
  agents: readonly AgentAvailability[];
  problems: readonly ConfigProblem[];
}

export type ConfigStore = WatchStore<ConfigSnapshot>;

/** Follows `config.watch`: the state now and after every change of the file on disk. */
export function createConfigStore(connection: RpcConnection): ConfigStore {
  const initial: ConfigSnapshot = {
    loaded: false,
    path: "",
    // The data dir is only known to the server; nothing renders these values before `loaded`.
    config: defaultClientConfig(""),
    profiles: [],
    agents: [],
    problems: [],
  };
  return createWatchStore<ConfigState, ConfigSnapshot>(connection, {
    name: "config.watch",
    initial,
    watch: async (rpc) => {
      const states = await rpc.api.config.watch();
      // The watch yields states, not lists; the store follows one item at a time.
      return (async function* () {
        for await (const state of states) yield [state];
      })();
    },
    toSnapshot: ([state]) =>
      state
        ? {
            loaded: true,
            path: state.path,
            config: state.config,
            profiles: state.profiles ?? [],
            agents: state.agents ?? [],
            problems: state.problems,
          }
        : initial,
  });
}

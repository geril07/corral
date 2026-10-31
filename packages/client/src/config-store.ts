import {
  defaultClientConfig,
  type ClientConfig,
  type ConfigProblem,
  type ConfigState,
  type LaunchProfile,
} from "@corral/protocol/config";
import type { RpcConnection } from "./rpc-connection.ts";
import { createWatchStore, type WatchStore } from "./watch-store.ts";

/**
 * The config the client uses before the server has sent one. The data directory, and with it
 * the default worktree root, is only known to the server, so that root starts empty here.
 */
export function defaultConfig(): ClientConfig {
  return defaultClientConfig("");
}

export interface ConfigSnapshot {
  /** False until the server has sent the config once; the defaults apply until then. */
  loaded: boolean;
  /** Absolute path of the file the server reads. */
  path: string;
  config: ClientConfig;
  /** Valid profiles only; an invalid profile is dropped whole and reported in `problems`. */
  profiles: readonly LaunchProfile[];
  problems: readonly ConfigProblem[];
}

export type ConfigStore = WatchStore<ConfigSnapshot>;

/** Follows `config.watch`: the state now and after every change of the file on disk. */
export function createConfigStore(connection: RpcConnection): ConfigStore {
  const initial: ConfigSnapshot = {
    loaded: false,
    path: "",
    config: defaultConfig(),
    profiles: [],
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
            problems: state.problems,
          }
        : initial,
  });
}

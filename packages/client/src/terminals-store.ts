import type { TerminalInfo } from "@corral/protocol/rpc";
import type { RpcConnection } from "./rpc-connection.ts";
import { createWatchStore, type WatchStore } from "./watch-store.ts";

export interface TerminalsSnapshot {
  /** False until the server has sent the list once. */
  loaded: boolean;
  /** The last list received; kept while disconnected, replaced when the connection returns. */
  terminals: readonly TerminalInfo[];
}

export type TerminalsStore = WatchStore<TerminalsSnapshot>;

export function createTerminalsStore(connection: RpcConnection): TerminalsStore {
  return createWatchStore<TerminalInfo, TerminalsSnapshot>(connection, {
    name: "terminals.watch",
    initial: { loaded: false, terminals: [] },
    watch: (rpc) => rpc.api.terminals.watch(),
    toSnapshot: (terminals) => ({ loaded: true, terminals }),
  });
}

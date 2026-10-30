import type { TerminalInfo } from "@corral/protocol/rpc";
import type { RpcConnection } from "./rpc-connection.ts";
import { Store, type ReadableStore } from "./store.ts";

export interface TerminalsSnapshot {
  /** False until the server has sent the list once. */
  loaded: boolean;
  /** The last list received; kept while disconnected, replaced when the connection returns. */
  terminals: readonly TerminalInfo[];
}

export interface TerminalsStore extends ReadableStore<TerminalsSnapshot> {
  close(): void;
}

/**
 * Follows `terminals.watch`, restarting it on every new connection. The call is never aborted:
 * aborting sends a cancel message that fails on a closed socket as an unhandled error, and the
 * call ends with its connection anyway. Closing the store therefore leaves the connection to end it.
 */
export function createTerminalsStore(connection: RpcConnection): TerminalsStore {
  const store = new Store<TerminalsSnapshot>({ loaded: false, terminals: [] });
  let watching: object | undefined;

  async function watch(token: object) {
    try {
      for await (const terminals of await connection.api.terminals.watch()) {
        if (watching !== token) return;
        store.set({ loaded: true, terminals });
      }
    } catch (error) {
      // A dropped socket or a stopped watch ends the stream; a reconnect starts a new one.
      if (watching === token) console.error("terminals.watch failed", error);
    }
  }

  const sync = () => {
    const connected = connection.state.getSnapshot().status === "connected";
    if (connected && !watching) {
      watching = {};
      void watch(watching);
    } else if (!connected) {
      watching = undefined;
    }
  };
  const unsubscribe = connection.state.subscribe(sync);
  sync();

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    close: () => {
      unsubscribe();
      watching = undefined;
    },
  };
}

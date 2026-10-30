import type { RpcConnection } from "./rpc-connection.ts";
import { Store, type ReadableStore } from "./store.ts";

export interface WatchStore<Snapshot> extends ReadableStore<Snapshot> {
  close(): void;
}

export interface WatchStoreOptions<Item, Snapshot> {
  /** For the log line when the watch fails. */
  name: string;
  initial: Snapshot;
  /** Starts the `*.watch` call; it yields the full list now and after every change. */
  watch: (connection: RpcConnection) => Promise<AsyncIterable<readonly Item[]>>;
  toSnapshot: (items: readonly Item[]) => Snapshot;
}

/**
 * Follows a watch call, restarting it on every new connection. The call is never aborted:
 * aborting sends a cancel message that fails on a closed socket as an unhandled error, and the
 * call ends with its connection anyway. Closing the store therefore leaves the connection to end it.
 */
export function createWatchStore<Item, Snapshot>(
  connection: RpcConnection,
  options: WatchStoreOptions<Item, Snapshot>,
): WatchStore<Snapshot> {
  const store = new Store<Snapshot>(options.initial);
  let watching: object | undefined;

  async function follow(token: object) {
    try {
      for await (const items of await options.watch(connection)) {
        if (watching !== token) return;
        store.set(options.toSnapshot(items));
      }
    } catch (error) {
      // A dropped socket or a stopped watch ends the stream; a reconnect starts a new one.
      if (watching === token) console.error(`${options.name} failed`, error);
    }
  }

  const sync = () => {
    const connected = connection.state.getSnapshot().status === "connected";
    if (connected && !watching) {
      watching = {};
      void follow(watching);
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

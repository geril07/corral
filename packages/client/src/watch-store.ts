import type { RpcConnection } from "./rpc-connection.ts";
import { Store, type ReadableStore } from "./store.ts";

/** Why a watched list will not arrive: the server refused its `*.watch` call while connected. */
export interface WatchFailure {
  /** The procedure's name, for the console and for tests. */
  name: string;
  /** What that list is called to a person: "project list", "task list", and so on. */
  label: string;
  error: unknown;
}

export interface WatchStore<Snapshot> extends ReadableStore<Snapshot> {
  /**
   * The latest refusal while the connection is up; a reconnect or the next delivered list clears
   * it. A dropped socket is not a refusal: the store keeps its last snapshot until the reconnect.
   */
  readonly failure: ReadableStore<WatchFailure | undefined>;
  /** Starts the watch again after a failure; no effect while a watch is already running. */
  retry(): void;
  close(): void;
}

export interface WatchStoreOptions<Item, Snapshot> {
  /** For the log line when the watch fails. */
  name: string;
  /** What the list is called in the main area's refusal line. */
  label: string;
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
  const failure = new Store<WatchFailure | undefined>(undefined);
  let watching: object | undefined;

  async function follow(token: object) {
    try {
      for await (const items of await options.watch(connection)) {
        if (watching !== token) return;
        failure.set(undefined);
        store.set(options.toSnapshot(items));
      }
    } catch (error) {
      if (watching !== token) return;
      watching = undefined;
      // A dropped socket ends the stream too, but that is not a refusal: the reconnect starts a
      // new watch, and until it arrives the store keeps its last list and the status says
      // disconnected. Only a refusal from a server that is still there is reported.
      if (connection.state.getSnapshot().status !== "connected") return;
      console.error(`${options.name} failed`, error);
      failure.set({ name: options.name, label: options.label, error });
    }
  }

  const sync = () => {
    const connected = connection.state.getSnapshot().status === "connected";
    if (connected && !watching) {
      // A connection or a Retry starts from waiting: a refusal from the old socket is not a
      // verdict on this one.
      failure.set(undefined);
      watching = {};
      void follow(watching);
    } else if (!connected) {
      watching = undefined;
      // The socket, not the server, may have ended the watch. What it said while connected is
      // not a verdict to keep across the reconnect.
      failure.set(undefined);
    }
  };
  const unsubscribe = connection.state.subscribe(sync);
  sync();

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    failure: { subscribe: failure.subscribe, getSnapshot: failure.getSnapshot },
    retry: sync,
    close: () => {
      unsubscribe();
      watching = undefined;
    },
  };
}

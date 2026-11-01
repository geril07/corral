import type { AgentKind } from "@corral/protocol/rpc";
import type { ConnectionState } from "./connection-state.ts";
import { Store, type ReadableStore } from "./store.ts";

/** What this server build can show as chat; a build fact, not a session's state (B0's contract). */
export interface ChatCapabilitiesSnapshot {
  /** False until this server has answered; until then nothing may claim a driver exists. */
  loaded: boolean;
  drivers: readonly AgentKind[];
}

export interface ChatCapabilitiesStore extends ReadableStore<ChatCapabilitiesSnapshot> {
  close(): void;
}

/**
 * What the store needs from the client's connection: the socket state it follows and the one call.
 * `CorralClient` builds it from the RPC connection; a test can answer without a server.
 */
export interface ChatCapabilitiesSource {
  readonly state: ReadableStore<ConnectionState>;
  capabilities(): Promise<{ drivers: AgentKind[] }>;
}

/**
 * Asks `chat.capabilities` once per connection: the list is a build fact that changes within one
 * protocol version (B4's view handoff, B5's pickers), so a client asks again whenever the socket
 * comes back instead of caching it across servers. The answer is kept while disconnected, so a
 * reconnecting client does not lose an offer it already showed.
 */
export function createChatCapabilitiesStore(source: ChatCapabilitiesSource): ChatCapabilitiesStore {
  const store = new Store<ChatCapabilitiesSnapshot>({ loaded: false, drivers: [] });
  /** The request allowed to write; a dropped connection replaces it so a late answer cannot win. */
  let asking: object | undefined;

  const sync = () => {
    if (source.state.getSnapshot().status !== "connected") {
      asking = undefined;
      return;
    }
    if (asking !== undefined) return;
    const token = {};
    asking = token;
    source.capabilities().then(
      ({ drivers }) => {
        if (asking !== token) return;
        asking = undefined;
        store.set({ loaded: true, drivers });
      },
      (error: unknown) => {
        if (asking !== token) return;
        asking = undefined;
        // Asked again at the next connection change, like the watched stores.
        console.error("chat.capabilities failed", error);
      },
    );
  };

  const unsubscribe = source.state.subscribe(sync);
  sync();
  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    close: () => {
      unsubscribe();
      asking = undefined;
    },
  };
}

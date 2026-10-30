import type { Session } from "@corral/protocol/rpc";
import type { RpcConnection } from "./rpc-connection.ts";
import { createWatchStore, type WatchStore } from "./watch-store.ts";

export interface SessionsSnapshot {
  /** False until the server has sent the list once. */
  loaded: boolean;
  /** Sessions of every task; the last list received, kept while disconnected. */
  sessions: readonly Session[];
}

export type SessionsStore = WatchStore<SessionsSnapshot>;

export function createSessionsStore(connection: RpcConnection): SessionsStore {
  return createWatchStore<Session, SessionsSnapshot>(connection, {
    name: "sessions.watch",
    initial: { loaded: false, sessions: [] },
    watch: (rpc) => rpc.api.sessions.watch(),
    toSnapshot: (sessions) => ({ loaded: true, sessions }),
  });
}

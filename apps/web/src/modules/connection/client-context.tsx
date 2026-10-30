import type { CorralClient } from "@corral/client/corral-client";
import type { ConnectionState } from "@corral/client/connection-state";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

const ClientContext = createContext<CorralClient | undefined>(undefined);

export function CorralClientProvider({
  client,
  children,
}: {
  client: CorralClient;
  children: ReactNode;
}) {
  return <ClientContext value={client}>{children}</ClientContext>;
}

export function useCorralClient(): CorralClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("no CorralClient in this tree");
  return client;
}

export function useConnection(): ConnectionState {
  const client = useCorralClient();
  return useSyncExternalStore(
    client.connection.state.subscribe,
    client.connection.state.getSnapshot,
  );
}

import type { AgentKind } from "@corral/protocol/rpc";
import { useEffect, useState } from "react";
import { useConnection, useCorralClient } from "../connection/index.ts";

/**
 * `chat.capabilities`: the agent kinds this server build can show as chat. Asked once per
 * connection, because the list is a build fact that changes when a driver lands, and never
 * derived from a client-side kind list (goal D7).
 */
export function useChatCapabilities(): readonly AgentKind[] {
  const client = useCorralClient();
  const status = useConnection().status;
  const [drivers, setDrivers] = useState<readonly AgentKind[]>([]);

  useEffect(() => {
    if (status !== "connected") return undefined;
    let live = true;
    client.connection.api.chat.capabilities().then(
      (result) => {
        if (live) setDrivers(result.drivers);
      },
      () => {
        // Without an answer the view control offers the terminal only; it never claims a driver.
        if (live) setDrivers([]);
      },
    );
    return () => {
      live = false;
    };
  }, [client, status]);

  return drivers;
}

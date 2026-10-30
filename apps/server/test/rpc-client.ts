import { capabilityProtocols, protocolUrl } from "@corral/protocol/handshake";
import { RPC_PATH } from "@corral/protocol/rpc";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { RouterClient } from "@orpc/server";
import type { createRpcRouter } from "../src/transport/rpc-router.ts";

export interface RpcClient {
  readonly api: RouterClient<ReturnType<typeof createRpcRouter>>;
  close(): void;
}

export async function connectRpc(serverUrl: string, capability: string): Promise<RpcClient> {
  const websocket = new WebSocket(
    protocolUrl(serverUrl, RPC_PATH),
    capabilityProtocols(capability),
  );
  await new Promise<void>((resolve, reject) => {
    websocket.addEventListener("open", () => resolve(), { once: true });
    websocket.addEventListener("error", () => reject(new Error("rpc socket failed to open")), {
      once: true,
    });
  });
  const link = new RPCLink({ websocket });
  return {
    api: createORPCClient<RouterClient<ReturnType<typeof createRpcRouter>>>(link),
    close: () => websocket.close(),
  };
}

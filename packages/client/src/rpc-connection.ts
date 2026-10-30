import { protocolUrl } from "@corral/protocol/handshake";
import { RPC_PATH, type Contract } from "@corral/protocol/rpc";
import { createORPCClient, type ClientContext } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import type { ConnectionState } from "./connection-state.ts";
import { ReconnectingSocket, type Backoff, type CreateSocket } from "./reconnecting-socket.ts";
import { Store, type ReadableStore } from "./store.ts";

export interface RpcConnectionOptions {
  serverUrl: string;
  backoff?: Backoff;
  createSocket?: CreateSocket;
}

export interface RpcConnection {
  readonly state: ReadableStore<ConnectionState>;
  /** Stays valid across reconnects; a call made while disconnected rejects. */
  readonly api: ContractRouterClient<Contract>;
  close(): void;
}

export function connectRpc(options: RpcConnectionOptions): RpcConnection {
  const state = new Store<ConnectionState>({ status: "connecting" });
  // oRPC's link is bound to one socket, so each socket gets its own link.
  let link: RPCLink<ClientContext> | undefined;

  const socket = new ReconnectingSocket({
    url: protocolUrl(options.serverUrl, RPC_PATH),
    backoff: options.backoff,
    createSocket: options.createSocket,
    onState: (next) => state.set(next),
    onOpen: (opened) => {
      link = new RPCLink({ websocket: opened });
    },
    onClose: () => {
      link = undefined;
      return "retry";
    },
  });

  const api = createORPCClient<ContractRouterClient<Contract>>({
    call: (path, input, callOptions) => {
      if (!link) return Promise.reject(new Error("not connected to the server"));
      return link.call(path, input, callOptions);
    },
  });

  return { state, api, close: () => socket.close() };
}

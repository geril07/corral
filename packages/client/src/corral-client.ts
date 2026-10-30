import type { Backoff, CreateSocket } from "./reconnecting-socket.ts";
import { connectRpc, type RpcConnection } from "./rpc-connection.ts";
import { createTerminalsStore, type TerminalsStore } from "./terminals-store.ts";
import { TerminalStream, type TerminalSurface } from "./terminal-stream.ts";

export interface CorralClientOptions {
  serverUrl: string;
  backoff?: Backoff;
  createSocket?: CreateSocket;
}

export interface CorralClient {
  readonly connection: RpcConnection;
  readonly terminals: TerminalsStore;
  /** Shows the terminal on `surface` until the caller closes the returned stream. */
  attach(terminalId: string, surface: TerminalSurface): TerminalStream;
  close(): void;
}

export function createCorralClient(options: CorralClientOptions): CorralClient {
  const connection = connectRpc(options);
  const terminals = createTerminalsStore(connection);
  return {
    connection,
    terminals,
    attach: (terminalId, surface) => new TerminalStream({ ...options, terminalId, surface }),
    close: () => {
      terminals.close();
      connection.close();
    },
  };
}

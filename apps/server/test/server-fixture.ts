import type { CreateTerminalInput, TerminalInfo } from "@corral/protocol/rpc";
import { afterEach, beforeEach } from "vite-plus/test";
import { startServer, type RunningServer } from "../src/transport/server.ts";
import type { Program } from "./programs.ts";
import { connectRpc, type RpcClient } from "./rpc-client.ts";
import { StreamClient } from "./stream-client.ts";

const DEFAULT_SIZE = { cols: 80, rows: 24 };
const DEADLINE_MS = 15_000;

/** A real server on port 0 per test; the fixture closes every client and kills every PTY afterwards. */
export function useServer() {
  let server: RunningServer;
  let streams: StreamClient[] = [];
  let rpcClients: RpcClient[] = [];

  beforeEach(async () => {
    server = await startServer({ host: "127.0.0.1", port: 0 });
  });
  afterEach(async () => {
    for (const stream of streams) stream.close();
    for (const client of rpcClients) client.close();
    streams = [];
    rpcClients = [];
    await server.close();
  });

  async function rpc() {
    const client = await connectRpc(server.url);
    rpcClients.push(client);
    return client.api;
  }

  return {
    get url() {
      return server.url;
    },
    rpc,
    async createTerminal(
      program?: Program,
      input: Partial<CreateTerminalInput> = {},
    ): Promise<TerminalInfo> {
      const api = await rpc();
      return api.terminals.create({ size: DEFAULT_SIZE, ...program, ...input });
    },
    async attach(id: string, options: { ack?: boolean; url?: string } = {}): Promise<StreamClient> {
      const client = await StreamClient.connect(server.url, id, options);
      streams.push(client);
      return client;
    },
  };
}

/** Rejects instead of hanging when `promise` does not settle in time. */
export function within<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      DEADLINE_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

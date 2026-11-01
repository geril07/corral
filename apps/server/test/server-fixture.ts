import type { CreateTerminalInput, TerminalInfo } from "@corral/protocol/rpc";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import type { TaskSettings } from "../src/tasks/task-settings.ts";
import { startServer, type RunningServer } from "../src/transport/server.ts";
import type { Program } from "./programs.ts";
import { connectRpc, type RpcClient } from "./rpc-client.ts";
import { StreamClient } from "./stream-client.ts";

const DEFAULT_SIZE = { cols: 80, rows: 24 };
const DEADLINE_MS = 15_000;

/**
 * A real server on port 0 per test, with its own data directory; the fixture closes every
 * client, kills every PTY and deletes the directories afterwards. `taskSettings` replaces the
 * task settings source, as A0's config will.
 */
export function useServer(
  fixture: {
    taskSettings?: (dirs: { dataDir: string; scratchDir: string }) => TaskSettings;
    /** Shortened chat driver deadlines for tests that watch one; production runs the defaults. */
    chat?: Parameters<typeof startServer>[0]["chat"];
  } = {},
) {
  let server: RunningServer;
  let root: string;
  let streams: StreamClient[] = [];
  let rpcClients: RpcClient[] = [];

  const dataDir = () => join(root, "data");
  const scratchDir = () => join(root, "scratch");
  const start = () =>
    startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir: dataDir(),
      ...(fixture.taskSettings === undefined
        ? {}
        : { settings: fixture.taskSettings({ dataDir: dataDir(), scratchDir: scratchDir() }) }),
      ...(fixture.chat === undefined ? {} : { chat: fixture.chat }),
    });
  const disconnectClients = () => {
    for (const stream of streams) stream.close();
    for (const client of rpcClients) client.close();
    streams = [];
    rpcClients = [];
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "corral-test-")));
    await mkdir(join(root, "scratch"));
    // The server reads $CORRAL_CONFIG_DIR; never the developer's own ~/.config/corral.
    vi.stubEnv("CORRAL_CONFIG_DIR", join(root, "config"));
    server = await start();
  });
  afterEach(async () => {
    disconnectClients();
    await server.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function rpc() {
    const client = await connectRpc(server.url, server.capability);
    rpcClients.push(client);
    return client.api;
  }

  return {
    get url() {
      return server.url;
    },
    get capability() {
      return server.capability;
    },
    /** The server's data directory, which holds its database and worktrees. */
    get dataDir() {
      return dataDir();
    },
    /** An empty directory for the test's repositories, outside the data directory. */
    get scratchDir() {
      return scratchDir();
    },
    /** The config directory the server reads; it does not exist until a test creates it. */
    get configDir() {
      return join(root, "config");
    },
    /** Stops the server (dropping all clients and terminals) and starts a new one on the same data directory. */
    async restart(): Promise<void> {
      disconnectClients();
      await server.close();
      server = await start();
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
      const client = await StreamClient.connect(server.url, id, {
        ...options,
        capability: server.capability,
      });
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

import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import type { TerminalInfo } from "@corral/protocol/rpc";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vite-plus/test";
// The one place client code reaches into the server: these tests run the real thing.
import { startServer, type RunningServer } from "../../../apps/server/src/transport/server.ts";
import { createCorralClient, type CorralClient } from "../src/corral-client.ts";
import type { ReadableStore } from "../src/store.ts";
import type { TerminalStream } from "../src/terminal-stream.ts";
import { initRepo } from "./git-repo.ts";
import { TcpProxy } from "./tcp-proxy.ts";
import { TestTerminal } from "./test-terminal.ts";

const DEADLINE_MS = 10_000;
const FAST_BACKOFF = { initialMs: 10, maxMs: 50 };

export interface Program {
  command: string;
  args: string[];
}

export function sh(script: string): Program {
  return { command: "/bin/sh", args: ["-c", script] };
}

/** Retries `assertion` until it stops throwing or the deadline passes. */
export function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: DEADLINE_MS, interval: 10 });
}

/** The states a store went through, in order, consecutive duplicates collapsed. */
export function recordStatuses(store: ReadableStore<{ status: string }>): string[] {
  const statuses = [store.getSnapshot().status];
  store.subscribe(() => {
    const status = store.getSnapshot().status;
    if (status !== statuses.at(-1)) statuses.push(status);
  });
  return statuses;
}

/** A real server on port 0 per test; every client, stream and proxy made here is closed afterwards. */
export function useServer() {
  // Tests wait on deadlines of their own and report what they waited for.
  vi.setConfig({ testTimeout: 30_000 });
  let server: RunningServer;
  let scratchDir: string;
  let cleanups: (() => void | Promise<void>)[] = [];

  beforeEach(async () => {
    scratchDir = await realpath(await mkdtemp(join(tmpdir(), "corral-client-test-")));
    server = await startServer({ host: "127.0.0.1", port: 0 });
  });
  afterEach(async () => {
    // oxlint-disable-next-line eslint/no-await-in-loop -- newest first: streams before clients before proxies
    for (const cleanup of cleanups.toReversed()) await cleanup();
    cleanups = [];
    await server.close();
    await rm(scratchDir, { recursive: true, force: true });
  });

  function connect(serverUrl = server.url): CorralClient {
    const client = createCorralClient({ serverUrl, backoff: FAST_BACKOFF });
    cleanups.push(() => client.close());
    return client;
  }

  return {
    get url() {
      return server.url;
    },
    connect,
    /** A git repository on `main` with one commit, in a directory that is deleted after the test. */
    repo(name = "repo"): string {
      return initRepo(join(scratchDir, name));
    },
    /** Opens a client and waits until it is connected. */
    async connected(serverUrl?: string): Promise<CorralClient> {
      const client = connect(serverUrl);
      await eventually(() => {
        if (client.connection.state.getSnapshot().status !== "connected")
          throw new Error("not yet");
      });
      return client;
    },
    async proxy(rewriteRequest?: (head: string) => string): Promise<TcpProxy> {
      const target = new URL(server.url);
      const proxy = await TcpProxy.start({
        target: { host: target.hostname, port: Number(target.port) },
        ...(rewriteRequest ? { rewriteRequest } : {}),
      });
      cleanups.push(() => proxy.close());
      return proxy;
    },
    /** A proxy whose clients claim a protocol version the server does not speak. */
    mismatchedProxy(): Promise<TcpProxy> {
      return this.proxy((head) =>
        head.replace(`protocol=${PROTOCOL_VERSION}`, `protocol=${PROTOCOL_VERSION + 1}`),
      );
    },
    createTerminal(client: CorralClient, program?: Program): Promise<TerminalInfo> {
      return client.connection.api.terminals.create({ size: { cols: 80, rows: 24 }, ...program });
    },
    /** Like `attach`, then waits until the stream is connected, so input is not dropped. */
    async attachConnected(client: CorralClient, id: string) {
      const attached = this.attach(client, id);
      await eventually(() => {
        if (attached.stream.state.getSnapshot().status !== "connected") throw new Error("not yet");
      });
      return attached;
    },
    attach(
      client: CorralClient,
      id: string,
      terminal = new TestTerminal(),
    ): { terminal: TestTerminal; stream: TerminalStream } {
      const stream = client.attach(id, terminal);
      cleanups.push(() => stream.close());
      return { terminal, stream };
    },
  };
}

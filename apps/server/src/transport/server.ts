import { checkProtocolVersion, PROTOCOL_MISMATCH_CLOSE_CODE } from "@corral/protocol/handshake";
import { RPC_PATH } from "@corral/protocol/rpc";
import { RPCHandler } from "@orpc/server/ws";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ProjectService } from "../projects/project-service.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { openDatabase } from "../storage/database.ts";
import { TaskService } from "../tasks/task-service.ts";
import { TaskStore } from "../tasks/task-store.ts";
import { TerminalRegistry } from "../terminals/terminal-registry.ts";
import { createRpcRouter } from "./rpc-router.ts";
import { serveTerminalStream } from "./terminal-stream-socket.ts";

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Port 0 picks a free port; the chosen one is in `url`. Projects, tasks and worktrees live in
 * `dataDir`; without one the server uses a temporary directory that `close` deletes.
 */
export function startServer(options: {
  host: string;
  port: number;
  dataDir?: string;
}): Promise<RunningServer> {
  const temporaryDataDir =
    options.dataDir === undefined ? mkdtempSync(join(tmpdir(), "corral-data-")) : undefined;
  const dataDir = options.dataDir ?? temporaryDataDir!;
  const database = openDatabase(dataDir);
  const terminals = new TerminalRegistry();
  const projectStore = new ProjectStore(database);
  const tasks = new TaskService({
    store: new TaskStore(database),
    projects: projectStore,
    terminals,
    dataDir,
  });
  const projects = new ProjectService(projectStore, tasks);
  const rpc = new RPCHandler(createRpcRouter({ projects, tasks, terminals }));
  const http = createServer((_request, response) => response.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "ws://localhost");
    const route = routeOf(url.pathname);
    if (!route) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const mismatch = checkProtocolVersion(url);
      if (mismatch) {
        ws.close(PROTOCOL_MISMATCH_CLOSE_CODE, JSON.stringify(mismatch));
      } else if (route.kind === "rpc") {
        void rpc.upgrade(ws, { context: {} });
      } else {
        serveTerminalStream(ws, terminals.get(route.terminalId));
      }
    });
  });

  let closing: Promise<void> | undefined;
  async function shutDown() {
    terminateAll(wss.clients);
    http.closeAllConnections();
    await Promise.all([terminals.closeAll(), new Promise((done) => http.close(done))]);
    database.close();
    if (temporaryDataDir) rmSync(temporaryDataDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    http.once("error", (error) => {
      database.close();
      reject(error);
    });
    http.listen(options.port, options.host, () => {
      const address = http.address();
      if (address === null || typeof address === "string")
        throw new Error(`unexpected address ${address}`);
      resolve({
        url: `ws://${options.host}:${address.port}`,
        close: () => (closing ??= shutDown()),
      });
    });
  });
}

type Route = { kind: "rpc" } | { kind: "terminal-stream"; terminalId: string };

const TERMINAL_STREAM_PATH = /^\/terminals\/([^/]+)$/;

function routeOf(pathname: string): Route | undefined {
  if (pathname === RPC_PATH) return { kind: "rpc" };
  const match = TERMINAL_STREAM_PATH.exec(pathname);
  if (!match) return undefined;
  try {
    return { kind: "terminal-stream", terminalId: decodeURIComponent(match[1]!) };
  } catch {
    return undefined;
  }
}

function terminateAll(sockets: Iterable<WebSocket>): void {
  for (const socket of sockets) socket.terminate();
}

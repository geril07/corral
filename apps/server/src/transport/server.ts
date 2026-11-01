import {
  CAPABILITY_SUBPROTOCOL,
  capabilityFromProtocols,
  checkProtocolVersion,
  PROTOCOL_MISMATCH_CLOSE_CODE,
} from "@corral/protocol/handshake";
import { RPC_PATH } from "@corral/protocol/rpc";
import { configFilePath, resolveConfigDir } from "@corral/protocol/server-endpoint";
import { statusReportPath } from "@corral/protocol/status-report";
import { RPCHandler } from "@orpc/server/ws";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ChatService } from "../chat/chat-service.ts";
import type { ChatTimeouts } from "../chat/chat-driver.ts";
import { ChangesService } from "../changes/changes-service.ts";
import { watchConfigFile } from "../config/config-watcher.ts";
import { configNaming } from "../config/naming.ts";
import { configTaskSettings } from "../config/task-settings.ts";
import { IssueImportService, issueImportTimeoutMs } from "../issues/issue-import.ts";
import { ProjectService } from "../projects/project-service.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { SessionService } from "../sessions/session-service.ts";
import { SessionStore } from "../sessions/session-store.ts";
import { OpenCodeIntegration } from "../status/opencode-integration.ts";
import { handleStatusReport, statusReportSessionId } from "../status/status-report-http.ts";
import { openDatabase } from "../storage/database.ts";
import { TaskService } from "../tasks/task-service.ts";
import type { TaskSettings } from "../tasks/task-settings.ts";
import { TaskStore } from "../tasks/task-store.ts";
import { TerminalRegistry } from "../terminals/terminal-registry.ts";
import { capabilityMatches, newCapability } from "./capability.ts";
import { createRpcRouter } from "./rpc-router.ts";
import { serveTerminalStream } from "./terminal-stream-socket.ts";

export interface RunningServer {
  readonly url: string;
  /** Per-run secret every client must present; clients get it from the endpoint file. */
  readonly capability: string;
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
  /** Task settings; A0 supplies the config-backed ones, tests may pass their own. */
  settings?: TaskSettings;
  /** Chat driver deadlines; tests shorten them, production runs the defaults. */
  chat?: Partial<ChatTimeouts> & { writerWaitMs?: number };
}): Promise<RunningServer> {
  const temporaryDataDir =
    options.dataDir === undefined ? mkdtempSync(join(tmpdir(), "corral-data-")) : undefined;
  const dataDir = options.dataDir ?? temporaryDataDir!;
  const capability = newCapability();
  const database = openDatabase(dataDir);
  const terminals = new TerminalRegistry();
  const projectStore = new ProjectStore(database);
  const taskStore = new TaskStore(database);
  const sessionStore = new SessionStore(database);
  // Built before the chat service, which tells it when an agent's tool call may have changed a
  // workspace; neither waits for the other, because the changes read model only knows the stores.
  const changes = new ChangesService({
    tasks: taskStore,
    projects: projectStore,
    sessions: sessionStore,
  });
  const chat = new ChatService({
    dataDir,
    ...(options.chat === undefined ? {} : { timeouts: options.chat }),
    onWorkspaceChange: (sessionId) => changes.workspaceChanged(sessionId),
  });
  const config = watchConfigFile(configFilePath(resolveConfigDir(process.env, homedir())), {
    dataDir,
  });
  // Known once the server listens, which is before any session starts.
  let httpOrigin = "";
  const sessions = new SessionService({
    store: sessionStore,
    tasks: taskStore,
    terminals,
    chat,
    statusUrl: (sessionId) => `${httpOrigin}${statusReportPath(sessionId)}`,
    openCode: OpenCodeIntegration.install(dataDir),
    config,
    // Defined below, once there is a TaskService to notify; called only after startup.
    taskEvents: { primarySessionRemoved: () => tasks.primarySessionRemoved() },
  });
  const tasks = new TaskService({
    store: taskStore,
    projects: projectStore,
    sessions,
    // A0's config supplies the worktree root, branch prefix and slug mode; tests may pass their own.
    settings: options.settings ?? configTaskSettings(config, { home: homedir() }),
    // `[naming]` and its profiles, read on every create so an edit applies without a restart.
    naming: configNaming(config),
  });
  const issues = new IssueImportService({ timeoutMs: issueImportTimeoutMs(process.env) });
  const projects = new ProjectService(projectStore, tasks, issues);
  const rpc = new RPCHandler(
    createRpcRouter({ config, projects, tasks, sessions, chat, changes, terminals }),
  );
  const http = createServer((request, response) => {
    const sessionId = statusReportSessionId(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    if (sessionId === undefined) {
      response.writeHead(404).end();
      return;
    }
    handleStatusReport(request, response, sessionId, sessions).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const wss = new WebSocketServer({
    noServer: true,
    // Negotiate only the marker, so the token is not echoed in the handshake response.
    handleProtocols: (protocols) =>
      protocols.has(CAPABILITY_SUBPROTOCOL) ? CAPABILITY_SUBPROTOCOL : false,
  });

  http.on("upgrade", (request, socket, head) => {
    const offered = subprotocolsOf(request.headers["sec-websocket-protocol"]);
    if (!capabilityMatches(capability, capabilityFromProtocols(offered))) {
      // Before routing, so a socket without the capability learns nothing about paths either.
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
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
    config.close();
    terminateAll(wss.clients);
    http.closeAllConnections();
    await sessions.shutDown();
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
      httpOrigin = `http://${loopbackHost(options.host)}:${address.port}`;
      sessions.restore();
      resolve({
        url: `ws://${options.host}:${address.port}`,
        capability,
        close: () => (closing ??= shutDown()),
      });
    });
  });
}

/** Where a process on this machine reaches a server bound to `host`. */
function loopbackHost(host: string): string {
  if (host === "" || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
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

/** `Sec-WebSocket-Protocol` is a comma-separated list; Node may hand it over as one or many. */
function subprotocolsOf(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  const text = Array.isArray(header) ? header.join(",") : header;
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

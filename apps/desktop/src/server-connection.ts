import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import type { ServerTarget } from "@corral/protocol/server-target";
import {
  endpointFilePath,
  ServerEndpoint,
  SERVER_LOCK_REFUSED_EXIT_CODE,
} from "@corral/protocol/server-endpoint";

const POLL_INTERVAL_MS = 50;

/**
 * Chromium leaves many of its file descriptors inheritable, so a plain spawn from Electron
 * hands the server Playwright's pipes (the launcher then never sees the app exit) and
 * Chromium's profile locks (held for as long as the server lives). Close everything above
 * stderr before exec.
 */
const EXEC_WITHOUT_INHERITED_FDS = `for entry in /dev/fd/*; do fd=\${entry##*/}; [ "$fd" -gt 2 ] 2>/dev/null && eval "exec $fd>&-"; done; exec "$@"`;

export type ServerConnection =
  | { status: "ready"; server: ServerTarget; pid: number }
  /** A live server on another protocol version. Never stopped here: who stops old servers is open. */
  | { status: "protocol-mismatch"; pid: number; serverProtocolVersion: number }
  | { status: "failed"; message: string };

export interface EnsureServerOptions {
  stateDir: string;
  /** TODO(packaging): dev only. The shipped app runs a bundled Node from a relocated copy; see docs/engineering.md, Open: Shipping the server. */
  serverEntry: string;
  /** How long to wait for a freshly started server to publish its endpoint. */
  startTimeoutMs: number;
}

/** Reuses the live server named by the endpoint file, else starts a detached one. */
export async function ensureServer(options: EnsureServerOptions): Promise<ServerConnection> {
  const running = await findLiveServer(options.stateDir);
  if (running) return describe(running);

  const starter = startDetachedServer(options);
  const deadline = Date.now() + options.startTimeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling until the deadline
    const live = await findLiveServer(options.stateDir);
    if (live) return describe(live);
    const failure = starter.failure();
    if (failure) return { status: "failed", message: failure };
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling until the deadline
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return {
    status: "failed",
    message: `The server did not publish ${endpointFilePath(options.stateDir)} within ${options.startTimeoutMs} ms. See ${starter.logPath}.`,
  };
}

function describe(endpoint: ServerEndpoint): ServerConnection {
  if (endpoint.protocolVersion !== PROTOCOL_VERSION) {
    return {
      status: "protocol-mismatch",
      pid: endpoint.pid,
      serverProtocolVersion: endpoint.protocolVersion,
    };
  }
  if (endpoint.capability === undefined) {
    return {
      status: "failed",
      message: `The running Corral server (pid ${endpoint.pid}) published an endpoint without a capability. Stop that server and start the app again. It was left running, so its sessions are untouched.`,
    };
  }
  return {
    status: "ready",
    server: { url: endpoint.url, capability: endpoint.capability },
    pid: endpoint.pid,
  };
}

/**
 * The endpoint file alone proves nothing (a crashed server leaves it behind), so the pid must
 * exist and the port must accept a connection. Wrongly deciding "dead" only starts a server
 * that the single-instance lock then refuses.
 */
async function findLiveServer(stateDir: string): Promise<ServerEndpoint | undefined> {
  let endpoint: ServerEndpoint;
  try {
    endpoint = ServerEndpoint.parse(JSON.parse(readFileSync(endpointFilePath(stateDir), "utf8")));
  } catch {
    return undefined;
  }
  if (!pidExists(endpoint.pid)) return undefined;
  const { hostname, port } = new URL(endpoint.url);
  return (await accepts(hostname, Number(port))) ? endpoint : undefined;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface Starter {
  readonly logPath: string;
  /** A message once the server process cannot be the one that will publish an endpoint. */
  failure(): string | undefined;
}

function startDetachedServer(options: EnsureServerOptions): Starter {
  const logPath = path.join(options.stateDir, "server.log");
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const log = openSync(logPath, "a");
  let failure: string | undefined;
  try {
    // Own process group and no stdio shared with us, so the server outlives this app.
    const child = spawn(
      "bash",
      ["-c", EXEC_WITHOUT_INHERITED_FDS, "corral-server", "node", options.serverEntry],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, CORRAL_STATE_DIR: options.stateDir },
      },
    );
    child.once("error", (error) => (failure = `Cannot start the server (bash): ${error.message}`));
    child.once("exit", (code, signal) => {
      // Refusal means another server holds the lock; its endpoint is what we wait for.
      if (code === SERVER_LOCK_REFUSED_EXIT_CODE) return;
      failure = `The server exited (${signal ?? `code ${code}`}) before it was ready. See ${logPath}.`;
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  return { logPath, failure: () => failure };
}

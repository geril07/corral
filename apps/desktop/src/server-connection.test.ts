import { PROTOCOL_VERSION, protocolUrl } from "@corral/protocol/handshake";
import { endpointFilePath, ServerEndpoint } from "@corral/protocol/server-endpoint";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ensureServer, type EnsureServerOptions } from "./server-connection.ts";

const SERVER_ENTRY = path.join(import.meta.dirname, "../../server/src/main.ts");

let stateDir: string;
let options: EnsureServerOptions;
let listeners: net.Server[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "corral-desktop-"));
  options = { stateDir, serverEntry: SERVER_ENTRY, startTimeoutMs: 15_000 };
  // The spawned server inherits our environment; keep its database out of the user's data dir.
  vi.stubEnv("CORRAL_DATA_DIR", path.join(stateDir, "data"));
});

afterEach(() => {
  for (const listener of listeners) listener.close();
  listeners = [];
  // The server is detached on purpose, so the test has to stop it.
  try {
    const { pid } = readEndpoint();
    // The mismatch test points the endpoint at this very process.
    if (pid !== process.pid) process.kill(pid, "SIGKILL");
  } catch {
    // No endpoint, or the server is already gone.
  }
  rmSync(stateDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function readEndpoint(): ServerEndpoint {
  return ServerEndpoint.parse(JSON.parse(readFileSync(endpointFilePath(stateDir), "utf8")));
}

function processGroup(pid: number): string {
  return execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

test("starts a detached server when none runs, and the next call reuses it", async () => {
  const first = await ensureServer(options);

  const { pid, url } = readEndpoint();
  expect(first).toEqual({ status: "ready", pid, url });
  expect(processGroup(pid)).not.toBe(processGroup(process.pid));
  const socket = new WebSocket(protocolUrl(url, "/rpc"));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.close();

  expect(await ensureServer(options)).toEqual(first);
});

test("an endpoint file left by a crashed server is replaced by a new server", async () => {
  const crashed = {
    pid: 2 ** 22 + 1,
    url: "ws://127.0.0.1:1",
    protocolVersion: PROTOCOL_VERSION,
    startedAt: 0,
  };
  writeFileSync(endpointFilePath(stateDir), JSON.stringify(crashed));

  const connection = await ensureServer(options);

  expect(connection.status).toBe("ready");
  expect(readEndpoint().pid).not.toBe(crashed.pid);
});

test("a live server on another protocol version is reported and left alone", async () => {
  const listener = net.createServer().listen(0, "127.0.0.1");
  listeners.push(listener);
  await new Promise((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  const { port } = address;
  const other = {
    pid: process.pid,
    url: `ws://127.0.0.1:${port}`,
    protocolVersion: PROTOCOL_VERSION + 1,
    startedAt: 0,
  };
  writeFileSync(endpointFilePath(stateDir), JSON.stringify(other));

  const connection = await ensureServer(options);

  expect(connection).toEqual({
    status: "protocol-mismatch",
    pid: process.pid,
    serverProtocolVersion: PROTOCOL_VERSION + 1,
  });
  expect(readEndpoint()).toEqual(other);
  expect(existsSync(path.join(stateDir, "server.log"))).toBe(false);
});

test("a server that dies on start is reported with the log to read", async () => {
  const connection = await ensureServer({
    ...options,
    serverEntry: path.join(stateDir, "missing.ts"),
  });

  expect(connection).toMatchObject({
    status: "failed",
    message: expect.stringContaining("server.log"),
  });
});

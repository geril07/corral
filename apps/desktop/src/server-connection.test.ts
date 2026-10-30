import { capabilityProtocols, PROTOCOL_VERSION, protocolUrl } from "@corral/protocol/handshake";
import { endpointFilePath, ServerEndpoint } from "@corral/protocol/server-endpoint";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  currentServerTarget,
  ensureServer,
  type EnsureServerOptions,
} from "./server-connection.ts";

const SERVER_ENTRY = path.join(import.meta.dirname, "../../server/src/main.ts");

let stateDir: string;
let options: EnsureServerOptions;
let listeners: net.Server[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "corral-desktop-"));
  options = { stateDir, serverEntry: SERVER_ENTRY, startTimeoutMs: 15_000 };
  // The spawned server inherits our environment; keep its database and config out of the user's dirs.
  vi.stubEnv("CORRAL_DATA_DIR", path.join(stateDir, "data"));
  vi.stubEnv("CORRAL_CONFIG_DIR", path.join(stateDir, "config"));
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

  const { pid, url, capability } = readEndpoint();
  if (capability === undefined) throw new Error("published endpoint has no capability");
  expect(first).toEqual({ status: "ready", pid, server: { url, capability } });
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(processGroup(pid)).not.toBe(processGroup(process.pid));
  const socket = new WebSocket(protocolUrl(url, "/rpc"), capabilityProtocols(capability));
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.close();

  expect(await ensureServer(options)).toEqual(first);
});

test("an endpoint file left by a crashed server is replaced by a new server", async () => {
  const crashed = {
    pid: 2 ** 22 + 1,
    url: "ws://127.0.0.1:1",
    capability: "stale-capability",
    protocolVersion: PROTOCOL_VERSION,
    startedAt: 0,
  };
  writeFileSync(endpointFilePath(stateDir), JSON.stringify(crashed));

  const connection = await ensureServer(options);

  expect(connection.status).toBe("ready");
  expect(readEndpoint().pid).not.toBe(crashed.pid);
});

test("an endpoint from protocol 1 is reported as a version mismatch, not as a live server", async () => {
  const listener = net.createServer().listen(0, "127.0.0.1");
  listeners.push(listener);
  await new Promise((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  const old = {
    pid: process.pid,
    url: `ws://127.0.0.1:${address.port}`,
    protocolVersion: 1,
    startedAt: 0,
  };
  writeFileSync(endpointFilePath(stateDir), JSON.stringify(old));

  const connection = await ensureServer(options);

  expect(connection).toEqual({
    status: "protocol-mismatch",
    pid: process.pid,
    serverProtocolVersion: 1,
  });
  expect(readEndpoint()).toEqual(old);
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
    capability: "another-server-capability",
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

test("a never-settling liveness probe is bounded and a later probe recovers", async () => {
  const endpoint = {
    pid: process.pid,
    url: "ws://127.0.0.1:1",
    capability: "stalled-probe",
    protocolVersion: PROTOCOL_VERSION,
    startedAt: 0,
  };
  writeFileSync(endpointFilePath(stateDir), JSON.stringify(endpoint));
  const stalled = new net.Socket();
  const connect = vi.spyOn(net, "connect").mockImplementation(() => stalled);
  try {
    const started = Date.now();
    await expect(currentServerTarget(stateDir)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(stalled.destroyed).toBe(true);
  } finally {
    connect.mockRestore();
  }

  const listener = net.createServer().listen(0, "127.0.0.1");
  listeners.push(listener);
  await new Promise((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  const recovered = {
    ...endpoint,
    url: `ws://127.0.0.1:${address.port}`,
    capability: "recovered-probe",
  };
  writeFileSync(endpointFilePath(stateDir), JSON.stringify(recovered));

  await expect(currentServerTarget(stateDir)).resolves.toEqual({
    url: recovered.url,
    capability: recovered.capability,
  });
});

test("the current target is read fresh and keeps a newer protocol reachable for the 4001 close", async () => {
  const listener = net.createServer().listen(0, "127.0.0.1");
  listeners.push(listener);
  await new Promise((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("listener has no port");
  const next = {
    pid: process.pid,
    url: `ws://127.0.0.1:${address.port}`,
    capability: "next-server-capability",
    protocolVersion: PROTOCOL_VERSION + 1,
    startedAt: 0,
  };
  writeFileSync(endpointFilePath(stateDir), JSON.stringify(next));

  expect(await currentServerTarget(stateDir)).toEqual({
    url: next.url,
    capability: next.capability,
  });
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

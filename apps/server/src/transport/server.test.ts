import {
  capabilityProtocols,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  ProtocolMismatchReason,
} from "@corral/protocol/handshake";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { WebSocket as WsWebSocket } from "ws";
import { sh } from "../../test/programs.ts";
import { connectRpc } from "../../test/rpc-client.ts";
import { StreamClient } from "../../test/stream-client.ts";
import { startServer, type RunningServer } from "./server.ts";

const DEADLINE_MS = 10_000;
const SENTINEL = "CORRAL_NONSECRET_SENTINEL_7f3a9c";

let server: RunningServer;
let configDir: string;
beforeEach(async () => {
  // The server reads $CORRAL_CONFIG_DIR; never the developer's own ~/.config/corral.
  configDir = await mkdtemp(join(tmpdir(), "corral-config-"));
  vi.stubEnv("CORRAL_CONFIG_DIR", configDir);
  server = await startServer({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

/** Opens a socket and reports whether the upgrade completed, or the handshake error. */
function handshake(
  url: string,
  protocols: string[] = [],
  origin?: string,
): Promise<{ opened: boolean; error?: string }> {
  const socket = new WsWebSocket(url, protocols, origin === undefined ? {} : { origin });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`timed out waiting for the handshake of ${url}`));
    }, DEADLINE_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve({ opened: true });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ opened: false, error: error.message });
    });
  });
}

test("a socket without the capability is refused before any route is chosen", async () => {
  for (const path of ["/rpc", "/terminals/anything", "/not-a-route"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- paths are checked one at a time
    const missing = await handshake(`${server.url}${path}?protocol=${PROTOCOL_VERSION}`);
    expect(missing.opened).toBe(false);
    expect(missing.error).toContain("401");

    // oxlint-disable-next-line eslint/no-await-in-loop -- paths are checked one at a time
    const wrong = await handshake(
      `${server.url}${path}?protocol=${PROTOCOL_VERSION}`,
      capabilityProtocols("not-the-capability"),
    );
    expect(wrong.opened).toBe(false);
    expect(wrong.error).toContain("401");
  }

  // With the capability, routing still distinguishes a real path from an unknown one.
  const unknown = await handshake(
    `${server.url}/not-a-route?protocol=${PROTOCOL_VERSION}`,
    capabilityProtocols(server.capability),
  );
  expect(unknown.opened).toBe(false);
  expect(unknown.error).toContain("404");
});

test("a hostile page origin is not the gate: no capability is refused, a capability is accepted", async () => {
  const rpcUrl = `${server.url}/rpc?protocol=${PROTOCOL_VERSION}`;

  const without = await handshake(rpcUrl, [], "http://hostile.example");
  expect(without.opened).toBe(false);
  expect(without.error).toContain("401");

  // Origin is not proof of trust; the capability is. A holder may connect from anywhere.
  const withCapability = await handshake(
    rpcUrl,
    capabilityProtocols(server.capability),
    "http://hostile.example",
  );
  expect(withCapability).toEqual({ opened: true });
});

test("a trusted client keeps command, args and env, and both channels deliver output", async () => {
  const sentinel = `${SENTINEL}_trusted`;
  const rpc = await connectRpc(server.url, server.capability);
  try {
    const info = await rpc.api.terminals.create({
      command: "/bin/sh",
      args: ["-c", `printf '%s\\n' "$CORRAL_NONSECRET_SENTINEL"; read x`],
      env: { CORRAL_NONSECRET_SENTINEL: sentinel },
      size: { cols: 80, rows: 24 },
    });
    expect(info.command).toBe("/bin/sh");

    const stream = await StreamClient.connect(server.url, info.id, {
      capability: server.capability,
    });
    try {
      await stream.waitForScreen(sentinel);
    } finally {
      stream.close();
    }
  } finally {
    rpc.close();
  }
});

test("a missing or wrong capability cannot attach a terminal stream either", async () => {
  const rpc = await connectRpc(server.url, server.capability);
  try {
    const info = await rpc.api.terminals.create({
      ...sh(`printf '${SENTINEL}\\n'; read x`),
      size: { cols: 80, rows: 24 },
    });
    const path = `/terminals/${encodeURIComponent(info.id)}?protocol=${PROTOCOL_VERSION}`;

    const missing = await handshake(`${server.url}${path}`);
    expect(missing.opened).toBe(false);
    expect(missing.error).toContain("401");

    const wrong = await handshake(
      `${server.url}${path}`,
      capabilityProtocols("not-the-capability"),
    );
    expect(wrong.opened).toBe(false);
    expect(wrong.error).toContain("401");
  } finally {
    rpc.close();
  }
});

test("the pre-fix attack cannot run a command or read its environment output", async () => {
  // This is the exact shape of the hostile-page attack: no capability, arbitrary command/env.
  // It must fail at the upgrade, before terminals.create can run anything.
  const rpc = await handshake(
    `${server.url}/rpc?protocol=${PROTOCOL_VERSION}`,
    capabilityProtocols("not-the-capability"),
  );
  expect(rpc.opened).toBe(false);
  expect(rpc.error).toContain("401");
});

test("a client on another protocol version is told the server's version and disconnected", async () => {
  const socket = new WsWebSocket(
    `${server.url}/rpc?protocol=${PROTOCOL_VERSION + 1}`,
    capabilityProtocols(server.capability),
  );
  const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") })),
  );

  expect(closed.code).toBe(PROTOCOL_MISMATCH_CLOSE_CODE);
  expect(ProtocolMismatchReason.parse(JSON.parse(closed.reason))).toEqual({
    serverProtocolVersion: PROTOCOL_VERSION,
  });
});

test("a version mismatch without the capability is an upgrade rejection, not a close code", async () => {
  const socket = new WsWebSocket(`${server.url}/rpc?protocol=${PROTOCOL_VERSION + 1}`);
  const error = await new Promise<string>((resolve) =>
    socket.once("error", (event) => resolve(event.message)),
  );
  expect(error).toContain("401");
});

test.for([
  ["a running shell", "read x"],
  ["a process that ignores SIGHUP", "trap '' HUP; read x"],
])("closing the server kills the PTY of %s", async ([, script]) => {
  const dir = await mkdtemp(join(tmpdir(), "corral-close-"));
  try {
    const pidFile = join(dir, "pid");
    const rpc = await connectRpc(server.url, server.capability);
    const info = await rpc.api.terminals.create({
      ...sh(`echo $$ > ${pidFile}; echo started; ${script}`),
      size: { cols: 80, rows: 24 },
    });
    const client = await StreamClient.connect(server.url, info.id, {
      capability: server.capability,
    });
    await client.waitForScreen("started");
    const pid = Number(await readFile(pidFile, "utf8"));
    rpc.close();
    client.close();

    await server.close();

    expect(processExists(pid)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

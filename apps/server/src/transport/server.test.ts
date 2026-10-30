import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  ProtocolMismatchReason,
} from "@corral/protocol/handshake";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { sh } from "../../test/programs.ts";
import { connectRpc } from "../../test/rpc-client.ts";
import { StreamClient } from "../../test/stream-client.ts";
import { startServer, type RunningServer } from "./server.ts";

let server: RunningServer;
beforeEach(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
});
afterEach(() => server.close());

test("a client on another protocol version is told the server's version and disconnected", async () => {
  const socket = new WebSocket(`${server.url}/rpc?protocol=${PROTOCOL_VERSION + 1}`);
  const closed = await new Promise<CloseEvent>((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );

  expect(closed.code).toBe(PROTOCOL_MISMATCH_CLOSE_CODE);
  expect(ProtocolMismatchReason.parse(JSON.parse(closed.reason))).toEqual({
    serverProtocolVersion: PROTOCOL_VERSION,
  });
});

test.for([
  ["a running shell", "read x"],
  ["a process that ignores SIGHUP", "trap '' HUP; read x"],
])("closing the server kills the PTY of %s", async ([, script]) => {
  const dir = await mkdtemp(join(tmpdir(), "corral-close-"));
  try {
    const pidFile = join(dir, "pid");
    const rpc = await connectRpc(server.url);
    const info = await rpc.api.terminals.create({
      ...sh(`echo $$ > ${pidFile}; echo started; ${script}`),
      size: { cols: 80, rows: 24 },
    });
    const client = await StreamClient.connect(server.url, info.id);
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

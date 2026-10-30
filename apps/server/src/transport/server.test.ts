import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  ProtocolMismatchReason,
} from "@corral/protocol/handshake";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
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

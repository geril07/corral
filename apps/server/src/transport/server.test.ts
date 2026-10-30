import { connect } from "@corral/client/connection";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { startServer, type RunningServer } from "./server.ts";

let server: RunningServer;
beforeEach(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
});
afterEach(() => server.close());

test("a client on the same protocol version gets a usable connection", async () => {
  const result = await connect(server.url);
  expect(result.ok).toBe(true);
  if (result.ok) result.socket.close();
});

test("a client on another protocol version is told the server's version and disconnected", async () => {
  const socket = new WebSocket(server.url);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const closed = new Promise<CloseEvent>((resolve) =>
    socket.addEventListener("close", resolve, { once: true }),
  );
  const reply = new Promise<unknown>((resolve) =>
    socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    }),
  );
  socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1 }));

  expect(await reply).toEqual({
    type: "rejected",
    reason: "protocol-mismatch",
    serverProtocolVersion: PROTOCOL_VERSION,
  });
  expect((await closed).code).toBe(1008);
});

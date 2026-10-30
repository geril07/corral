import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { expect, test } from "vite-plus/test";
import { eventually, recordStatuses, sh, useServer } from "../test/server-fixture.ts";

const server = useServer();

test("the list starts unloaded, then follows create, exit and close", async () => {
  const client = server.connect();
  expect(client.terminals.getSnapshot()).toEqual({ loaded: false, terminals: [] });

  await eventually(() => expect(client.terminals.getSnapshot().loaded).toBe(true));
  expect(client.terminals.getSnapshot().terminals).toEqual([]);

  const running = await server.createTerminal(client, sh("read x"));
  const exiting = await server.createTerminal(client, sh("read x; exit 3"));
  await eventually(() =>
    expect(client.terminals.getSnapshot().terminals.map((t) => t.id)).toEqual([
      running.id,
      exiting.id,
    ]),
  );

  const { stream } = await server.attachConnected(client, exiting.id);
  stream.input("\n");
  await eventually(() =>
    expect(client.terminals.getSnapshot().terminals.find((t) => t.id === exiting.id)?.exit).toEqual(
      { exitCode: 3 },
    ),
  );

  await client.connection.api.terminals.close({ id: running.id });
  await eventually(() =>
    expect(client.terminals.getSnapshot().terminals.map((t) => t.id)).toEqual([exiting.id]),
  );
});

test("a new connection to a server with terminals lists them", async () => {
  const first = await server.connected();
  const info = await server.createTerminal(first, sh("read x"));

  const second = server.connect();
  await eventually(() =>
    expect(second.terminals.getSnapshot().terminals.map((t) => t.id)).toEqual([info.id]),
  );
});

test("after the connection drops, the list catches up with what changed meanwhile", async () => {
  const proxy = await server.proxy();
  const client = await server.connected(proxy.url);
  const statuses = recordStatuses(client.connection.state);
  const before = await server.createTerminal(client, sh("read x"));
  await eventually(() => expect(client.terminals.getSnapshot().terminals).toHaveLength(1));

  proxy.refuse(true);
  proxy.drop();
  await eventually(() => expect(statuses).toContain("disconnected"));
  await expect(server.createTerminal(client)).rejects.toThrow("not connected");
  expect(client.terminals.getSnapshot().terminals).toHaveLength(1);

  const other = await server.connected();
  const during = await server.createTerminal(other, sh("read x"));
  await other.connection.api.terminals.close({ id: before.id });
  proxy.refuse(false);

  await eventually(() =>
    expect(client.terminals.getSnapshot().terminals.map((t) => t.id)).toEqual([during.id]),
  );
  expect(client.connection.state.getSnapshot().status).toBe("connected");
});

test("a server on another protocol version shows as a protocol mismatch", async () => {
  const proxy = await server.mismatchedProxy();
  const client = server.connect(proxy.url);

  await eventually(() =>
    expect(client.connection.state.getSnapshot()).toEqual({
      status: "protocol-mismatch",
      serverProtocolVersion: PROTOCOL_VERSION,
    }),
  );
  expect(client.terminals.getSnapshot().loaded).toBe(false);
});

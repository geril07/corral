import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { ACK_WINDOW_BYTES } from "@corral/protocol/terminal-stream";
import { expect, test } from "vite-plus/test";
import { eventually, recordStatuses, sh, useServer } from "../test/server-fixture.ts";

const server = useServer();

test("attaching shows what the terminal printed before, and typing round-trips", async () => {
  const client = await server.connected();
  const info = await server.createTerminal(
    client,
    sh(`echo already-there; while read line; do echo "got:$line"; done`),
  );

  const { terminal, stream } = await server.attachConnected(client, info.id);
  await eventually(() => expect(terminal.screen).toContain("already-there"));

  stream.input("héllo\n");
  await eventually(() => expect(terminal.screen).toContain("got:héllo"));
});

test("input typed before the socket has opened is not lost", async () => {
  const client = await server.connected();
  const info = await server.createTerminal(
    client,
    sh(`while read line; do echo "got:$line"; done`),
  );

  const { terminal, stream } = server.attach(client, info.id);
  stream.input("early\n");

  await eventually(() => expect(terminal.screen).toContain("got:early"));
});

test("resize reaches the process and comes back as the terminal's size, without a loop", async () => {
  const client = await server.connected();
  const info = await server.createTerminal(client, sh(`read x; stty size; read y`));
  const { terminal, stream } = await server.attachConnected(client, info.id);

  stream.resize({ cols: 100, rows: 30 });
  await eventually(() => expect(terminal.size).toEqual({ cols: 100, rows: 30 }));
  stream.input("\n");

  await eventually(() => expect(terminal.screen).toContain("30 100"));
  expect(terminal.resets).toBe(1);
});

test("a size asked for before the terminal is attached is applied once it is", async () => {
  const client = await server.connected();
  const info = await server.createTerminal(client, sh(`read x; stty size; read y`));
  const { terminal, stream } = server.attach(client, info.id);

  stream.resize({ cols: 90, rows: 20 });

  await eventually(() => expect(terminal.size).toEqual({ cols: 90, rows: 20 }));
  stream.input("\n");
  await eventually(() => expect(terminal.screen).toContain("20 90"));
});

test("a second client attaching to a resized terminal gets the screen at the new size", async () => {
  const client = await server.connected();
  const info = await server.createTerminal(client, sh(`echo wide; read x`));
  const first = server.attach(client, info.id);
  await eventually(() => expect(first.terminal.screen).toContain("wide"));
  first.stream.resize({ cols: 120, rows: 40 });
  await eventually(() => expect(first.terminal.size).toEqual({ cols: 120, rows: 40 }));

  const second = server.attach(client, info.id);

  await eventually(() => expect(second.terminal.size).toEqual({ cols: 120, rows: 40 }));
  await eventually(() => expect(second.terminal.screen).toContain("wide"));
});

test("after the socket drops the stream re-attaches, replaces the screen with a fresh snapshot and keeps working", async () => {
  const proxy = await server.proxy();
  const client = await server.connected(proxy.url);
  const info = await server.createTerminal(
    client,
    sh(`echo first-screen; while read line; do echo "got:$line"; done`),
  );
  const { terminal, stream } = await server.attachConnected(client, info.id);
  const statuses = recordStatuses(stream.state);
  await eventually(() => expect(terminal.screen).toContain("first-screen"));
  stream.input("one\n");
  await eventually(() => expect(terminal.screen).toContain("got:one"));

  proxy.refuse(true);
  proxy.drop();
  await eventually(() => expect(statuses).toContain("disconnected"));
  // The process keeps running while no client is attached.
  const direct = await server.connected();
  const other = await server.attachConnected(direct, info.id);
  other.stream.input("while-away\n");
  await eventually(() => expect(other.terminal.screen).toContain("got:while-away"));
  proxy.refuse(false);

  await eventually(() => expect(terminal.screen).toContain("got:while-away"));
  expect(terminal.resets).toBe(2);
  expect(stream.state.getSnapshot().status).toBe("connected");
  stream.input("two\n");
  await eventually(() => expect(terminal.screen).toContain("got:two"));
  expect(terminal.screen.filter((line) => line === "first-screen")).toHaveLength(1);
});

test("a client that falls behind gets a snapshot instead of the output it missed", async () => {
  const client = await server.connected();
  const info = await server.createTerminal(
    client,
    sh(`read go; seq 1 120000; echo flood-done; read stop`),
  );
  const { terminal, stream } = await server.attachConnected(client, info.id);
  terminal.stall();

  stream.input("\n");
  // Past the window the server stops sending; nothing more arrives however long the PTY runs.
  await eventually(() => expect(terminal.parsedOutputBytes).toBeGreaterThan(ACK_WINDOW_BYTES));
  terminal.release();

  await eventually(() => expect(terminal.screen).toContain("flood-done"));
  expect(terminal.resets).toBe(2);
  expect(terminal.screen).toContain("120000");
});

test("when the process exits the stream reports it, keeps the screen and does not reconnect", async () => {
  const proxy = await server.proxy();
  const client = await server.connected(proxy.url);
  const info = await server.createTerminal(client, sh(`echo last-words; exit 7`));

  const { terminal, stream } = server.attach(client, info.id);

  await eventually(() =>
    expect(stream.state.getSnapshot()).toEqual({ status: "exited", exit: { exitCode: 7 } }),
  );
  // The exit message can arrive before the terminal has parsed the snapshot written ahead of it.
  await eventually(() => expect(terminal.screen).toContain("last-words"));
  const connectionsOnExit = proxy.accepted;
  expect(connectionsOnExit).toBe(2); // the RPC socket and this stream

  const later = server.attach(client, info.id);
  await eventually(() =>
    expect(later.stream.state.getSnapshot()).toEqual({ status: "exited", exit: { exitCode: 7 } }),
  );
  await eventually(() => expect(later.terminal.screen).toContain("last-words"));
});

test("a terminal that does not exist, or was closed while attached, shows as not found", async () => {
  const client = await server.connected();
  const missing = server.attach(client, "no-such-terminal");
  await eventually(() =>
    expect(missing.stream.state.getSnapshot()).toEqual({ status: "not-found" }),
  );

  const info = await server.createTerminal(client, sh(`read x`));
  const attached = server.attach(client, info.id);
  await eventually(() => expect(attached.stream.state.getSnapshot().status).toBe("connected"));
  await client.connection.api.terminals.close({ id: info.id });
  await eventually(() =>
    expect(attached.stream.state.getSnapshot()).toEqual({ status: "not-found" }),
  );
});

test("a server on another protocol version shows as a protocol mismatch", async () => {
  const proxy = await server.mismatchedProxy();
  const client = server.connect(proxy.url);
  const { stream } = server.attach(client, "any");

  await eventually(() =>
    expect(stream.state.getSnapshot()).toEqual({
      status: "protocol-mismatch",
      serverProtocolVersion: PROTOCOL_VERSION,
    }),
  );
});

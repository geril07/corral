import { PROTOCOL_MISMATCH_CLOSE_CODE, PROTOCOL_VERSION } from "@corral/protocol/handshake";
import {
  ACK_WINDOW_BYTES,
  TERMINAL_NOT_FOUND_CLOSE_CODE,
  terminalStreamPath,
} from "@corral/protocol/terminal-stream";
import { expect, test } from "vite-plus/test";
import { describeTerminal } from "../../test/client-terminal.ts";
import { counter, counterValues, isContiguous, sh } from "../../test/programs.ts";
import { useServer } from "../../test/server-fixture.ts";

const server = useServer();

test("attaching restores the screen, scrollback and cursor written before the attach", async () => {
  const info = await server.createTerminal(
    sh(`i=0; while [ $i -lt 40 ]; do echo "line $i"; i=$((i+1)); done; printf 'prompt> '; read x`),
  );
  const first = await server.attach(info.id);
  await first.waitForScreen("prompt> ");

  const late = await server.attach(info.id);
  await late.waitForScreen("prompt> ");

  expect(late.messages[0]?.type).toBe("snapshot");
  expect(late.screen).toContain("line 0");
  expect(describeTerminal(late.terminal)).toEqual(describeTerminal(first.terminal));
});

test("attaching to a full-screen app restores the alternate screen, its modes and the normal screen behind it", async () => {
  const info = await server.createTerminal(
    sh(
      `echo before-the-app;
       printf '\\033[?1049h\\033[2J\\033[H\\033[?25l\\033[?1000h\\033[?1006h\\033[?2004h';
       printf 'FULL SCREEN TUI\\033[5;10Hcursor here';
       read x;
       printf '\\033[?1049l'; echo back-in-the-shell; read y`,
    ),
  );
  const first = await server.attach(info.id);
  await first.waitForScreen("cursor here");

  const late = await server.attach(info.id);
  await late.waitForScreen("cursor here");

  expect(describeTerminal(late.terminal)).toEqual(describeTerminal(first.terminal));
  expect(describeTerminal(late.terminal)).toMatchObject({
    activeBuffer: "alternate",
    cursor: { x: 20, y: 4, hidden: true },
    modes: { mouseTrackingMode: "vt200", bracketedPasteMode: true },
  });
  expect(late.screen[0]).toBe("FULL SCREEN TUI");

  late.type("\n");
  await late.waitForScreen("back-in-the-shell");
  expect(late.terminal.buffer.active.type).toBe("normal");
  expect(late.screen).toContain("before-the-app");
});

test("output flowing during an attach arrives without a gap or a duplicate across the snapshot", async () => {
  const info = await server.createTerminal(counter);
  const clients = [await server.attach(info.id)];
  for (let i = 0; i < 6; i++) {
    const previous = clients.at(-1)!;
    const target = previous.outputBytes + 20_000;
    // oxlint-disable-next-line no-await-in-loop -- each attach happens at a later point of the stream
    await previous.waitFor(() => previous.outputBytes > target, "more output to flow");
    // oxlint-disable-next-line no-await-in-loop
    clients.push(await server.attach(info.id));
  }

  clients[0]!.type("stop\n");
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop -- each client closes after the exit message
    await client.waitForClose();
  }

  const finalLine = clients[0]!.screen.find((line) => line.startsWith("final n="))!;
  const finalCount = Number(finalLine.slice("final n=".length));
  for (const client of clients) {
    const values = counterValues(client.screen);
    expect(client.messages[0]?.type).toBe("snapshot");
    expect(isContiguous(values)).toBe(true);
    expect(values.at(-1)).toBe(finalCount - 1);
    expect(client.screen).toContain(finalLine);
  }
  for (const late of clients.slice(1)) {
    expect(late.outputBytes, "output after the snapshot").toBeGreaterThan(0);
    expect(late.snapshots[0]!.data).toContain("n=");
  }
});

test("input from any attached client reaches the PTY", async () => {
  const info = await server.createTerminal(sh("read x; echo GOT:$x; read y; echo AGAIN:$y"));
  const first = await server.attach(info.id);
  const second = await server.attach(info.id);

  first.type("from-first\n");
  await second.waitForScreen("GOT:from-first");
  second.type("from-second\n");
  await first.waitForScreen("AGAIN:from-second");
  expect(first.screen).toContain("GOT:from-first");
});

test("a resize from one client resizes the PTY and tells every attached client", async () => {
  const info = await server.createTerminal(sh(`while read x; do stty size; done`));
  const resizing = await server.attach(info.id);
  const other = await server.attach(info.id);

  resizing.resize({ cols: 100, rows: 30 });
  await other.waitFor(() => other.terminal.cols === 100 && other.terminal.rows === 30, "resized");
  expect(other.messages.at(-1)).toEqual({ type: "resized", size: { cols: 100, rows: 30 } });
  await resizing.waitFor(() => resizing.terminal.cols === 100, "the resize echoed back");

  other.type("\n");
  await resizing.waitForScreen("30 100");

  const late = await server.attach(info.id);
  await late.waitFor(() => late.snapshots.length === 1, "the snapshot");
  expect(late.snapshots[0]!.size).toEqual({ cols: 100, rows: 30 });
});

test("the exit message ends the stream with a normal close, and later attaches get the final screen then the exit", async () => {
  const info = await server.createTerminal(sh("echo last words; read x; exit 3"));
  const client = await server.attach(info.id);
  await client.waitForScreen("last words");

  client.type("\n");
  expect(await client.waitForClose()).toMatchObject({ code: 1000 });
  expect(client.messages.at(-1)).toEqual({ type: "exit", exit: { exitCode: 3 } });

  const late = await server.attach(info.id);
  expect(await late.waitForClose()).toMatchObject({ code: 1000 });
  expect(late.messages.map((message) => message.type)).toEqual(["snapshot", "exit"]);
  await late.waitForScreen("last words");
});

test("a process killed by a signal reports the signal", async () => {
  const info = await server.createTerminal(sh("kill -9 $$"));
  const client = await server.attach(info.id);

  await client.waitForClose();
  expect(client.messages.at(-1)).toEqual({ type: "exit", exit: { exitCode: 0, signal: 9 } });
});

test("a client that never acks stalls alone, then gets a snapshot once it acks", async () => {
  const info = await server.createTerminal(counter);
  const fast = await server.attach(info.id);
  const stalled = await server.attach(info.id, { ack: false });

  await fast.waitFor(
    () => fast.outputBytes > 4 * ACK_WINDOW_BYTES,
    "the PTY to keep producing output past the stalled client's window",
  );
  expect(stalled.outputBytes).toBeGreaterThan(ACK_WINDOW_BYTES);
  expect(stalled.outputBytes).toBeLessThan(ACK_WINDOW_BYTES + 256 * 1024);
  expect(stalled.snapshots).toHaveLength(1);

  stalled.ackAll();
  await stalled.waitFor(() => stalled.snapshots.length === 2, "a fresh snapshot after the acks");

  fast.type("stop\n");
  await fast.waitForClose();
  await stalled.waitForClose();
  const fastValues = counterValues(fast.screen);
  const stalledValues = counterValues(stalled.screen);
  expect(isContiguous(stalledValues)).toBe(true);
  expect(stalledValues.at(-1)).toBe(fastValues.at(-1));
});

test("attaching to an unknown terminal closes with the not-found code", async () => {
  const client = await server.attach("missing");

  expect(await client.waitForClose()).toMatchObject({ code: TERMINAL_NOT_FOUND_CLOSE_CODE });
});

test("closing a terminal closes its attached streams with the not-found code", async () => {
  const info = await server.createTerminal(sh("read x"));
  const client = await server.attach(info.id);
  const other = await server.attach(info.id);

  await (await server.rpc()).terminals.close({ id: info.id });

  expect(await client.waitForClose()).toMatchObject({ code: TERMINAL_NOT_FOUND_CLOSE_CODE });
  expect(await other.waitForClose()).toMatchObject({ code: TERMINAL_NOT_FOUND_CLOSE_CODE });
  const afterwards = await server.attach(info.id);
  expect(await afterwards.waitForClose()).toMatchObject({ code: TERMINAL_NOT_FOUND_CLOSE_CODE });
});

test("a stream socket on another protocol version is told the server's version and closed", async () => {
  const info = await server.createTerminal(sh("read x"));
  const url = new URL(terminalStreamPath(info.id), server.url);
  url.searchParams.set("protocol", String(PROTOCOL_VERSION + 1));

  const client = await server.attach(info.id, { url: url.toString() });

  const closed = await client.waitForClose();
  expect(closed.code).toBe(PROTOCOL_MISMATCH_CLOSE_CODE);
  expect(JSON.parse(closed.reason)).toEqual({ serverProtocolVersion: PROTOCOL_VERSION });
  expect(client.messages).toEqual([]);
});

test("a client that sends a malformed message is disconnected", async () => {
  const info = await server.createTerminal(sh("read x"));
  const client = await server.attach(info.id);

  client.send({ type: "ack", bytes: -1 });

  expect(await client.waitForClose()).toMatchObject({ code: 1008 });
});

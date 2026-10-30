import { expect, test } from "vite-plus/test";
import {
  createClientTerminal,
  describeTerminal,
  writeAndWait,
} from "../../test/client-terminal.ts";
import { HeadlessTerminal } from "./headless-terminal.ts";
import { PendingInputTail } from "./pending-input-tail.ts";

const SIZE = { cols: 24, rows: 8 };
const ESC = "\x1b";
// Every byte split replays a whole stream through xterm; CPU-heavy, with no readiness wait.
const REPLAY_TIMEOUT_MS = 20_000;

const history = Array.from({ length: 12 }, (_, i) => `history ${i} héllo ✓\r\n`).join("");

const streams = {
  "scrollback and styled text": `${history}${ESC}[1;31mred bold${ESC}[0m plain\r\n${ESC}]0;a title${ESC}\\prompt$ `,
  "full-screen app on the alternate screen": [
    history,
    `${ESC}[?1049h${ESC}[2J${ESC}[H`,
    `${ESC}[1;1H${ESC}[7m status bar ${ESC}[0m`,
    `${ESC}[2;7r`,
    `${ESC}[7;1Hlast row${ESC}[3;5Hbody text`,
    `${ESC}[4;9H${ESC}7${ESC}[6;3Hmoved on`,
    `${ESC}[?25l${ESC}[?1002h${ESC}[?1006h${ESC}[?2004h${ESC}[?1h`,
    `${ESC}[5;4H`,
  ].join(""),
  "full-screen app that returned to the normal screen": `${history}${ESC}[?1049h${ESC}[HALT${ESC}[?1049l${ESC}[2;1Hback`,
  "cursor waiting at the right margin": `${history}${"x".repeat(SIZE.cols)}`,
};

/** Snapshot after the first `split` bytes, then the rest as live bytes, as a client would see them. */
async function replayAcross(stream: Uint8Array, split: number) {
  const server = new HeadlessTerminal(SIZE);
  const tail = new PendingInputTail();
  const before = stream.subarray(0, split);
  await new Promise<void>((resolve) => server.write(before, resolve));
  tail.push(before);

  const client = createClientTerminal(server.size);
  await writeAndWait(client, server.snapshot());
  await writeAndWait(client, tail.bytes);
  await writeAndWait(client, stream.subarray(split));
  server.dispose();
  return describeTerminal(client);
}

for (const [name, text] of Object.entries(streams)) {
  test(
    `a snapshot taken at any byte of a stream continues like the original: ${name}`,
    async () => {
      const stream = new TextEncoder().encode(text);
      const reference = createClientTerminal(SIZE);
      await writeAndWait(reference, stream);
      const expected = describeTerminal(reference);

      for (let split = 0; split <= stream.length; split++) {
        // oxlint-disable-next-line no-await-in-loop -- each split builds its own terminals
        expect(await replayAcross(stream, split), `split at byte ${split}`).toEqual(expected);
      }
    },
    REPLAY_TIMEOUT_MS,
  );
}

test("a snapshot of the alternate screen keeps the normal screen's scrollback behind it", async () => {
  const server = new HeadlessTerminal(SIZE);
  await new Promise<void>((resolve) =>
    server.write(`${history}${ESC}[?1049h${ESC}[2J${ESC}[Hfull screen`, resolve),
  );
  const client = createClientTerminal(SIZE);
  await writeAndWait(client, server.snapshot());
  server.dispose();

  const described = describeTerminal(client);
  expect(described.activeBuffer).toBe("alternate");
  expect(described.alternate[0]).toBe("full screen");
  expect(described.normal).toContain("history 0 héllo ✓");
  await writeAndWait(client, `${ESC}[?1049l`);
  expect(describeTerminal(client).activeBuffer).toBe("normal");
});

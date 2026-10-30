import { AgentStatus } from "@corral/protocol/rpc";
import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { PROBE, report } from "../../test/osc7501.ts";
import { HeadlessTerminal } from "../terminals/headless-terminal.ts";
import { QUERY_REPLY } from "./osc7501-protocol.ts";
import { Osc7501Records } from "./osc7501-records.ts";

/** A headless terminal as a session's PTY feeds it, and what its OSC 7501 hooks observed. */
function observe() {
  const records = new Osc7501Records();
  const replies: string[] = [];
  let changes = 0;
  const terminal = new HeadlessTerminal(
    { cols: 80, rows: 24 },
    { records, reply: (data) => replies.push(data), changed: () => (changes += 1), now: () => 7 },
  );
  return {
    terminal,
    replies,
    get changes() {
      return changes;
    },
    status: () => records.status(),
    /** Writes the chunks in order and resolves once the terminal has parsed all of them. */
    async feed(...chunks: (string | Uint8Array)[]) {
      for (const chunk of chunks) terminal.write(chunk, () => {});
      await new Promise<void>((resolve) => terminal.write("", resolve));
    },
  };
}

test("a report in the stream becomes the status", async () => {
  const seen = observe();
  await seen.feed(
    `output\r\n${report({ state: "blocked", kind: "permission", msg: "Write?" })}more`,
  );
  expect(seen.status()).toEqual({
    state: "blocked",
    kind: "permission",
    message: "Write?",
    updatedAt: 7,
  });
  expect(seen.replies).toEqual([]);
  expect(seen.changes).toBe(1);
});

test("BEL- and ST-terminated reports both count", async () => {
  const seen = observe();
  await seen.feed(report({ state: "working" }, "bel"));
  expect(seen.status()).toMatchObject({ state: "working" });
  await seen.feed(report({ state: "done" }, "st"));
  expect(seen.status()).toMatchObject({ state: "done" });
});

test("each probe is answered once, ahead of a DA1 sentinel that follows it, and a report is not answered", async () => {
  const seen = observe();
  await seen.feed(`${PROBE}\x1b[c`, report({ state: "working" }), PROBE);
  expect(seen.replies).toEqual([QUERY_REPLY, QUERY_REPLY]);
});

test("the probe leaves no trace in a snapshot, so restoring one answers nothing", async () => {
  const seen = observe();
  await seen.feed(`${PROBE}${report({ state: "working" })}visible`);
  const snapshot = seen.terminal.snapshot();
  expect(snapshot).not.toContain("7501");
  const restored = observe();
  await restored.feed(snapshot);
  expect(restored.replies).toEqual([]);
  expect(restored.status()).toBeNull();
});

test("a new shell prompt ends the program but keeps its done; a full reset clears everything", async () => {
  const seen = observe();
  await seen.feed(report({ state: "working" }), "\x1b]133;A\x07");
  expect(seen.status()).toBeNull();
  await seen.feed(report({ state: "done", msg: "ok" }), "\x1b]133;A;cl=m\x1b\\");
  expect(seen.status()).toMatchObject({ state: "done" });
  await seen.feed("\x1bc");
  expect(seen.status()).toBeNull();
});

test("another OSC 133 mark does not end the program", async () => {
  const seen = observe();
  await seen.feed(report({ state: "working" }), "\x1b]133;B\x07\x1b]133;AB\x07");
  expect(seen.status()).toMatchObject({ state: "working" });
});

test("reports over the sequence cap and cancelled sequences are ignored; later ones still apply", async () => {
  const seen = observe();
  await seen.feed(`\x1b]7501;state=working:junk=${"x".repeat(5000)}\x07`);
  expect(seen.status()).toBeNull();
  await seen.feed("\x1b]7501;state=working\x18\x1b]7501;state=blocked\x1a");
  expect(seen.status()).toBeNull();
  await seen.feed(report({ state: "idle" }));
  expect(seen.status()).toMatchObject({ state: "idle" });
});

test("an unterminated sequence is dropped once something else follows it", async () => {
  const seen = observe();
  await seen.feed("\x1b]7501;state=working:junk=", "x".repeat(20_000));
  await seen.feed("\x07", report({ state: "done" }));
  expect(seen.status()).toMatchObject({ state: "done" });
});

// Each property replays up to 300 generated cases through xterm; no readiness wait.
const PROPERTY_TIMEOUT_MS = 20_000;

const STREAM_PIECES = [
  report({ state: "working", msg: "Thinking ✓" }),
  report({ state: "blocked", kind: "question", id: "sub/1", msg: "Which?" }),
  report({ state: "clear", id: "sub/1" }),
  report({ state: "done" }, "bel"),
  PROBE,
  "plain text\r\n",
  "\x1b[31mred\x1b[0m",
  "\x1b]133;A\x07",
  "\x1b]7501;state=working:junk=",
  "\x07",
  "\x1b",
  "\x1b\\",
  "é✓",
];

test(
  "what the terminal makes of a stream does not depend on where its chunks end",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...STREAM_PIECES), { maxLength: 12 }),
        fc.array(fc.nat({ max: 400 }), { maxLength: 8 }),
        async (pieces, cuts) => {
          const bytes = Buffer.from(pieces.join(""), "utf8");
          const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].toSorted(
            (a, b) => a - b,
          );
          const chunks = [];
          let from = 0;
          for (const point of [...points, bytes.length]) {
            chunks.push(bytes.subarray(from, point));
            from = point;
          }
          const whole = observe();
          await whole.feed(bytes);
          const split = observe();
          await split.feed(...chunks);
          expect(split.status()).toEqual(whole.status());
          expect(split.replies).toEqual(whole.replies);
          expect(split.terminal.snapshot()).toEqual(whole.terminal.snapshot());
          whole.terminal.dispose();
          split.terminal.dispose();
        },
      ),
      { numRuns: 300 },
    );
  },
  PROPERTY_TIMEOUT_MS,
);

test(
  "arbitrary bytes never throw or hang the terminal",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constantFrom(...STREAM_PIECES),
            fc.string({ unit: "binary", maxLength: 200 }),
            fc.uint8Array({ maxLength: 200 }),
          ),
          { maxLength: 20 },
        ),
        async (pieces) => {
          const seen = observe();
          await seen.feed(
            ...pieces.map((piece) =>
              typeof piece === "string" ? Buffer.from(piece, "utf8") : piece,
            ),
          );
          expect(AgentStatus.nullable().safeParse(seen.status()).success).toBe(true);
          seen.terminal.dispose();
        },
      ),
      { numRuns: 300 },
    );
  },
  PROPERTY_TIMEOUT_MS,
);

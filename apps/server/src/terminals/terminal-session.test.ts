import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vite-plus/test";
import { TerminalSession } from "./terminal-session.ts";

const LINE = "some words to scroll the screen";
const LINES = 400_000;
// The PTY turns each newline into CR LF.
const FLOOD_BYTES = LINES * (LINE.length + 2);
const DEADLINE_MS = 30_000;
const LIMITS = { pauseBytes: 8 * 1024, resumeBytes: 2 * 1024 };

let session: TerminalSession | undefined;
afterEach(async () => {
  await session?.close();
  session = undefined;
});

test("a PTY whose headless backlog passes the limit is paused until it drains, and no output is lost", async () => {
  session = new TerminalSession(
    "flood",
    {
      taskId: null,
      sessionId: null,
      command: "/bin/sh",
      args: ["-c", `yes '${LINE}' | head -n ${LINES}`],
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      size: { cols: 80, rows: 24 },
    },
    () => {},
    LIMITS,
  );
  let received = 0;
  const exited = new Promise<void>((resolve) => {
    const attachment = session!.attach({
      snapshot: () => {},
      output: (bytes) => {
        received += bytes.length;
        attachment?.ack(bytes.length);
      },
      resized: () => {},
      exit: () => resolve(),
      terminalClosed: () => {},
    });
  });
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("the flood did not finish")), DEADLINE_MS).unref(),
  );

  await Promise.race([exited, deadline]);

  expect(received).toBe(FLOOD_BYTES);
  // The read in flight when the pause lands (64 KiB at most) still arrives.
  expect(session.peakBacklogBytes).toBeLessThan(LIMITS.pauseBytes + 64 * 1024 + 1);
});

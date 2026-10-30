import { ACK_RESUME_BYTES, ACK_WINDOW_BYTES } from "@corral/protocol/terminal-stream";
import { expect, test } from "vite-plus/test";
import { OutputCredit } from "./output-credit.ts";

test("output is admitted until the window is exceeded, then skipped", () => {
  const credit = new OutputCredit();
  credit.sent(ACK_WINDOW_BYTES);
  expect(credit.admit()).toBe(true);
  credit.sent(1);
  expect(credit.admit()).toBe(false);
});

test("a snapshot is due when acks reach the resume level after output was skipped", () => {
  const credit = new OutputCredit();
  credit.sent(ACK_WINDOW_BYTES + 1);
  credit.admit();

  expect(credit.acked(ACK_WINDOW_BYTES - ACK_RESUME_BYTES)).toBe(false);
  expect(credit.acked(1)).toBe(true);
  expect(credit.admit()).toBe(true);
  expect(credit.acked(1)).toBe(false);
});

test("resuming without skipped output needs no snapshot", () => {
  const credit = new OutputCredit();
  credit.sent(ACK_WINDOW_BYTES + 1);

  expect(credit.acked(ACK_WINDOW_BYTES + 1)).toBe(false);
  expect(credit.admit()).toBe(true);
});

test("acking more than was sent does not go negative", () => {
  const credit = new OutputCredit();
  credit.sent(10);
  credit.acked(100);
  expect(credit.unackedBytes).toBe(0);
});

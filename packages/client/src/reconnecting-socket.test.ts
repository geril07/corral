import { expect, test } from "vite-plus/test";
import { reconnectDelayMs } from "./reconnecting-socket.ts";

test("retry delays double from the initial one and stop growing at the cap", () => {
  const backoff = { initialMs: 250, maxMs: 2000 };
  expect([1, 2, 3, 4, 5, 6].map((failures) => reconnectDelayMs(failures, backoff))).toEqual([
    250, 500, 1000, 2000, 2000, 2000,
  ]);
});

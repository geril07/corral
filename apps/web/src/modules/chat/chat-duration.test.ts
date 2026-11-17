import { expect, test } from "vite-plus/test";
import { formatTurnDuration } from "./chat-duration.ts";

test("a turn's duration reads in T3's units", () => {
  expect(formatTurnDuration(0)).toBe("0s");
  expect(formatTurnDuration(12_400)).toBe("12s");
  // 59.9 s is still 59 whole seconds: the live label never claims a second that has not passed.
  expect(formatTurnDuration(59_900)).toBe("59s");
  expect(formatTurnDuration(60_000)).toBe("1m");
  expect(formatTurnDuration(65_000)).toBe("1m 5s");
  expect(formatTurnDuration(3_600_000)).toBe("1h");
  expect(formatTurnDuration(3_720_000)).toBe("1h 2m");
  expect(formatTurnDuration(-5)).toBe("0s");
});

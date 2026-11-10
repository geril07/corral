import { describe, expect, test } from "vite-plus/test";
import { companionRange, companionWidthFor, COMPANION_MIN_WIDTH } from "./use-task-tabs.ts";

describe("the companion group's width", () => {
  test("keeps both reference minimums when the working area has room", () => {
    const range = companionRange(1008);
    expect(range.min).toBe(COMPANION_MIN_WIDTH);
    expect(range.max).toBe(448);
    expect(companionWidthFor(600, 1008)).toBe(448);
  });

  test("gives the companion its minimum and lets the main pane shrink below 560", () => {
    expect(companionWidthFor(600, 696)).toBe(COMPANION_MIN_WIDTH);
  });

  test("never grows past the working area on a narrow window", () => {
    expect(companionRange(280)).toEqual({ min: 280, max: 280 });
    expect(companionWidthFor(600, 280)).toBe(280);
  });
});

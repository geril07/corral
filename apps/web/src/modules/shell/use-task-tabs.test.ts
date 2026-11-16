import { describe, expect, test } from "vite-plus/test";
import { COMPANION_MAX_WIDTH, COMPANION_MIN_WIDTH } from "./task-tabs.ts";
import { MAIN_MIN_WIDTH, companionRange, companionWidthFor } from "./use-task-tabs.ts";

describe("the companion group's width", () => {
  test("caps the companion at its maximum when the working area has room", () => {
    expect(companionRange(1600)).toEqual({
      min: COMPANION_MIN_WIDTH,
      max: COMPANION_MAX_WIDTH,
    });
    expect(companionWidthFor(1000, 1600)).toBe(COMPANION_MAX_WIDTH);
  });

  test("leaves the main pane its minimum while the companion takes the rest", () => {
    expect(companionWidthFor(600, 696)).toBe(696 - MAIN_MIN_WIDTH);
  });

  test("never grows past the working area on a narrow window", () => {
    expect(companionRange(280)).toEqual({
      min: COMPANION_MIN_WIDTH,
      max: COMPANION_MIN_WIDTH,
    });
    expect(companionWidthFor(600, 280)).toBe(COMPANION_MIN_WIDTH);
  });
});

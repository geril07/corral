import { expect, test } from "vite-plus/test";
import {
  clampSidebarPreference,
  clampSidebarWidth,
  defaultSidebarWidth,
  MAIN_AREA_MIN_WIDTH,
  maxSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./sidebar-pane.ts";

test("the 640 px main-area reserve holds at and above the supported 1024 px floor", () => {
  for (const windowWidth of [1024, 1180, 1600, 1920]) {
    const sidebar = maxSidebarWidth(windowWidth);
    expect(windowWidth - sidebar).toBeGreaterThanOrEqual(MAIN_AREA_MIN_WIDTH);
  }
  expect(maxSidebarWidth(1024)).toBe(384);
  expect(maxSidebarWidth(848)).toBe(SIDEBAR_MIN_WIDTH);
  expect(848 - maxSidebarWidth(848)).toBe(MAIN_AREA_MIN_WIDTH);
});

test("below 848 px the sidebar floor wins, because smaller layouts are unsupported", () => {
  // `ux.md` Known limits: desktop support begins at 1024×640; the reserve is a supported-floor
  // promise, not a claim that a 700 px window can show a 640 px main area beside a 208 px sidebar.
  expect(maxSidebarWidth(700)).toBe(SIDEBAR_MIN_WIDTH);
  expect(700 - maxSidebarWidth(700)).toBeLessThan(MAIN_AREA_MIN_WIDTH);
});

test("the pure clamps keep the 208–420 preference and cap only the displayed width", () => {
  // These cover the pure helpers only; the hook's real preference-vs-display state (a shrink
  // leaving storage alone, ArrowRight at the display maximum) is in
  // workspace-screen.browser.test.tsx.
  expect(clampSidebarPreference(100)).toBe(SIDEBAR_MIN_WIDTH);
  expect(clampSidebarPreference(400)).toBe(400);
  expect(clampSidebarPreference(999)).toBe(SIDEBAR_MAX_WIDTH);
  const preference = 420;
  expect(clampSidebarWidth(preference, 900)).toBe(260);
  expect(clampSidebarWidth(preference, 1600)).toBe(420);
  expect(clampSidebarWidth(100, 1600)).toBe(SIDEBAR_MIN_WIDTH);
  expect(clampSidebarWidth(999, 1600)).toBe(420);
});

test("the device default is narrow below 1180 and full at 1180 and above", () => {
  expect(defaultSidebarWidth(1024)).toBe(232);
  expect(defaultSidebarWidth(1179)).toBe(232);
  expect(defaultSidebarWidth(1180)).toBe(264);
});

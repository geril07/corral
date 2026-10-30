import { expect, test } from "vite-plus/test";
import { activeAfterClose, effectiveActive, stepActive } from "./terminal-selection.ts";

const ids = ["a", "b", "c"];

test("the chosen terminal stays active while it exists, else the first one", () => {
  expect(effectiveActive(ids, "b")).toBe("b");
  expect(effectiveActive(ids, "gone")).toBe("a");
  expect(effectiveActive(ids, undefined)).toBe("a");
  expect(effectiveActive([], "a")).toBeUndefined();
});

test("stepping wraps around in both directions", () => {
  expect(stepActive(ids, "a", 1)).toBe("b");
  expect(stepActive(ids, "c", 1)).toBe("a");
  expect(stepActive(ids, "a", -1)).toBe("c");
  expect(stepActive(ids, undefined, 1)).toBe("a");
  expect(stepActive([], "a", 1)).toBeUndefined();
});

test("closing moves to the next terminal, or the previous one at the end", () => {
  expect(activeAfterClose(ids, "a")).toBe("b");
  expect(activeAfterClose(ids, "b")).toBe("c");
  expect(activeAfterClose(ids, "c")).toBe("b");
  expect(activeAfterClose(["a"], "a")).toBeUndefined();
  expect(activeAfterClose(ids, "unknown")).toBeUndefined();
});

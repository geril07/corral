import { expandWorktreeRoot, worktreeRootProblem } from "./worktree-root.ts";
import { expect, test } from "vite-plus/test";

test("a worktree root expands ~ to the home directory and collapses separators", () => {
  expect(expandWorktreeRoot("/data/worktrees", "/home/me")).toBe("/data/worktrees");
  expect(expandWorktreeRoot("/data//worktrees/", "/home/me")).toBe("/data/worktrees");
  expect(expandWorktreeRoot("~", "/home/me")).toBe("/home/me");
  expect(expandWorktreeRoot("~/wt", "/home/me")).toBe("/home/me/wt");
  expect(expandWorktreeRoot("~//wt", "/home/me")).toBe("/home/me/wt");
  expect(expandWorktreeRoot("~/./wt", "/home/me")).toBe("/home/me/wt");
});

test("a root must be absolute or below ~, and a ~-relative root may not climb out of home", () => {
  expect(worktreeRootProblem("/")).toBeUndefined();
  expect(worktreeRootProblem("~")).toBeUndefined();
  expect(worktreeRootProblem("~/wt")).toBeUndefined();
  expect(worktreeRootProblem("worktrees")).toBe(
    "the worktree root must be an absolute path or start with ~/",
  );
  expect(worktreeRootProblem("~/../etc")).toBe('a ~-relative worktree root may not hold ".."');
  // Windows treats `\` as a separator too, so this climbs even though it has no `/` after `~`.
  expect(worktreeRootProblem("~/..\\etc")).toBe('a ~-relative worktree root may not hold ".."');
  expect(() => expandWorktreeRoot("worktrees", "/home/me")).toThrow(/absolute path/);
  expect(() => expandWorktreeRoot("~/../etc", "/home/me")).toThrow('may not hold ".."');
});

/** `C:\wt` is absolute only on Windows; the server reads the config on its own platform. */
test.runIf(process.platform === "win32")("a Windows drive path is an absolute root", () => {
  expect(worktreeRootProblem("C:\\wt")).toBeUndefined();
  expect(expandWorktreeRoot("C:\\wt", "C:\\Users\\me")).toBe("C:\\wt");
  expect(expandWorktreeRoot("~/wt", "C:\\Users\\me")).toBe("C:\\Users\\me\\wt");
  // The climb check must not be fooled by a backslash separator.
  expect(worktreeRootProblem("~/..\\etc")).toBe('a ~-relative worktree root may not hold ".."');
  expect(() => expandWorktreeRoot("~/..\\etc", "C:\\Users\\me")).toThrow('may not hold ".."');
});

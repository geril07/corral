import {
  defaultClientConfig,
  defaultWorktreeRoot,
  expandWorktreeRoot,
  namingConfigured,
  worktreeRootProblem,
} from "./config.ts";
import { expect, test } from "vite-plus/test";

test("naming counts as configured only when it names a profile or an agent", () => {
  const naming = defaultClientConfig("").naming;
  expect(namingConfigured(naming)).toBe(false);
  expect(namingConfigured({ ...naming, profile: { value: "gateway", source: "global" } })).toBe(
    true,
  );
  expect(namingConfigured({ ...naming, agent: { value: "pi", source: "global" } })).toBe(true);
  expect(
    namingConfigured({
      ...naming,
      model: { value: "claude-haiku-4-5", source: "global" },
    }),
  ).toBe(false);
});

test("the built-in worktree root sits below the data directory", () => {
  expect(defaultWorktreeRoot("/data/corral")).toBe("/data/corral/worktrees");
  expect(defaultWorktreeRoot("/data/corral/")).toBe("/data/corral/worktrees");
  expect(defaultClientConfig("/data/corral").tasks.worktreeRoot).toEqual({
    value: "/data/corral/worktrees",
    source: "default",
  });
});

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
  expect(() => expandWorktreeRoot("worktrees", "/home/me")).toThrow(/absolute path/);
  expect(() => expandWorktreeRoot("~/../etc", "/home/me")).toThrow('may not hold ".."');
});

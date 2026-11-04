import { defaultClientConfig } from "@corral/protocol/config";
import { expect, test } from "vite-plus/test";
import { defaultWorkspace, isBranchKey, workspaceChoices } from "./new-task-defaults.ts";

test("the workspace picker offers the main tree, a new worktree and every existing branch", () => {
  expect(workspaceChoices(["main", "feature/x"]).map((choice) => choice.label)).toEqual([
    "main tree",
    "new worktree",
    "main",
    "feature/x",
  ]);
  expect(workspaceChoices(["main"]).at(-1)?.input).toEqual({
    type: "existing-branch",
    branch: "main",
  });
  expect(isBranchKey(workspaceChoices(["main"]).at(-1)!.key)).toBe(true);
  expect(isBranchKey("new-worktree")).toBe(false);
});

test("the workspace default is the project's configured mode", () => {
  const settings = defaultClientConfig("/data").tasks;
  expect(
    defaultWorkspace({ ...settings, workspace: { value: "new-worktree", source: "global" } }).input,
  ).toEqual({ type: "new-branch" });
  expect(defaultWorkspace(settings).input).toEqual({ type: "main-worktree" });
});

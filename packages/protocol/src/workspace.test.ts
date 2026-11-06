import { expect, test } from "vite-plus/test";
import { workspaceMissingMessage, workspaceMissingPath } from "./workspace.ts";

test("a missing workspace is one sentence with its absolute path", () => {
  const path = "/data/worktrees/app/fix-login";

  expect(workspaceMissingMessage(path)).toBe(
    "This task's workspace no longer exists at /data/worktrees/app/fix-login. Restore it or remove the task.",
  );
  expect(workspaceMissingPath(workspaceMissingMessage(path))).toBe(path);
});

test("another failure's message is not read as a missing workspace", () => {
  expect(workspaceMissingPath("no such directory: /data/worktrees/app/fix-login")).toBeUndefined();
  expect(workspaceMissingPath("This task's workspace no longer exists at ")).toBeUndefined();
  expect(workspaceMissingPath("")).toBeUndefined();
});

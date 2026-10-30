import { expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRepo, git, openedWindow, screenText, workspace } from "./app-helpers.ts";
import { test } from "./fixtures.ts";

const branchesOf = (repo: string) =>
  git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

// MVP step 2: a task is a branch in a worktree of its own, which the app creates and removes.
test("a task gets a worktree and a terminal in it, and removing it leaves the branch", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("No projects yet")).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Shift+KeyP");
  const addProject = window.getByRole("dialog", { name: "Add project" });
  await expect(addProject.getByRole("textbox")).toBeFocused();
  await window.keyboard.type(repo);
  await window.keyboard.press("Enter");
  await expect(addProject).toBeHidden();
  await expect(workspace(window).getByRole("button", { name: "repo", exact: true })).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  const newTask = window.getByRole("dialog", { name: "New task" });
  await expect(newTask.getByRole("textbox", { name: "Title" })).toBeFocused();
  await window.keyboard.type("Fix login");
  await window.keyboard.press("Enter");
  await expect(newTask).toBeHidden();
  const task = workspace(window).getByRole("button", { name: /^Fix login/ });
  await expect(task).toHaveAttribute("aria-current", "true");
  await expect(workspace(window).getByRole("button", { name: "shell", exact: true })).toHaveCount(
    1,
  );

  // The terminal started inside the task's worktree, which lives in the data dir.
  const worktreesRoot = path.join(stateDir, "data", "worktrees");
  const [projectDir] = readdirSync(worktreesRoot);
  const [taskDir] = readdirSync(path.join(worktreesRoot, projectDir ?? ""));
  const worktree = path.join(worktreesRoot, projectDir ?? "", taskDir ?? "");
  await window.keyboard.type("pwd");
  await window.keyboard.press("Enter");
  // The path can be longer than the terminal is wide, so the screen wraps it.
  await expect
    .poll(async () => (await screenText(window)).replaceAll("\n", ""))
    .toContain(worktree);
  const taskBranch = branchesOf(repo).find((branch) => branch !== "main");
  expect(taskBranch).toBeDefined();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Shift+KeyT");
  const confirm = window.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await window.keyboard.press("Tab");
  await window.keyboard.press("Enter");

  await expect(confirm).toBeHidden();
  await expect(task).toBeHidden();
  await expect.poll(() => existsSync(worktree)).toBe(false);
  expect(branchesOf(repo)).toContain(taskBranch);
});

test("projects and tasks are still there when the app is opened again", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const first = await launchApp();
  const firstWindow = await openedWindow(first);
  await expect(firstWindow.getByText("No projects yet")).toBeVisible();
  await firstWindow.keyboard.press("Alt+KeyA");
  await firstWindow.keyboard.press("Shift+KeyP");
  await expect(
    firstWindow.getByRole("dialog", { name: "Add project" }).getByRole("textbox"),
  ).toBeFocused();
  await firstWindow.keyboard.type(repo);
  await firstWindow.keyboard.press("Enter");
  await expect(
    workspace(firstWindow).getByRole("button", { name: "repo", exact: true }),
  ).toBeVisible();
  await firstWindow.keyboard.press("Alt+KeyA");
  await firstWindow.keyboard.press("KeyT");
  await expect(
    firstWindow.getByRole("dialog", { name: "New task" }).getByRole("textbox", { name: "Title" }),
  ).toBeFocused();
  await firstWindow.keyboard.type("Keep me");
  await firstWindow.keyboard.press("Enter");
  await expect(workspace(firstWindow).getByRole("button", { name: /^Keep me/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await first.close();

  const secondWindow = await openedWindow(await launchApp());
  await expect(workspace(secondWindow).getByRole("button", { name: /^Keep me/ })).toBeVisible();
  await expect(
    workspace(secondWindow).getByRole("button", { name: "repo", exact: true }),
  ).toBeVisible();
  // The task's shell kept running on the server, so it is listed too.
  await expect(
    workspace(secondWindow).getByRole("button", { name: "shell", exact: true }),
  ).toHaveCount(1);
});

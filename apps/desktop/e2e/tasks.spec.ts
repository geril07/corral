import { expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  createRepo,
  createTask,
  git,
  newTaskView,
  openedWindow,
  promptField,
  screenText,
  sessionTab,
  startShell,
  workspace,
} from "./app-helpers.ts";
import { readLaunches, test } from "./fixtures.ts";

const branchesOf = (repo: string) =>
  git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

// MVP step 2: a task is a branch in a worktree of its own, which the app creates and removes.
test("a task gets a worktree and a terminal in it, and removing it leaves the branch", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Shift+KeyP");
  const addProjectDialog = window.getByRole("dialog", { name: "Add project" });
  await expect(addProjectDialog.getByRole("textbox")).toBeFocused();
  await window.keyboard.type(repo);
  await window.keyboard.press("Enter");
  await expect(addProjectDialog).toBeHidden();
  // The global New task action is enabled once the project is current.
  await expect(
    workspace(window).getByRole("button", { name: "New task", exact: true }),
  ).toBeEnabled();

  // The composer is a view in the main area: its prompt takes the keyboard, and the optional
  // title carries a task that should start without an agent.
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  await expect(promptField(window)).toBeFocused();
  await newTaskView(window)
    .getByRole("combobox", { name: /^Workspace / })
    .click();
  await window.keyboard.type("new worktree");
  await window.keyboard.press("Enter");
  await newTaskView(window).getByRole("button", { name: "Title (optional)" }).click();
  await window.keyboard.type("Fix login");
  await window.keyboard.press("Enter");
  await expect(newTaskView(window)).toBeHidden();
  const task = workspace(window).getByRole("button", { name: /^Fix login/ });
  await expect(task).toHaveAttribute("aria-current", "true");
  // Creating a task starts no shell: the task is listed and its pane says what is missing.
  await expect(sessionTab(window, "shell")).toHaveCount(0);
  await expect(window.getByText("No sessions", { exact: true })).toBeVisible();

  // The task got a worktree of its own in the data dir; a shell started there works in it.
  const worktreesRoot = path.join(stateDir, "data", "worktrees");
  const [projectDir] = readdirSync(worktreesRoot);
  const [taskDir] = readdirSync(path.join(worktreesRoot, projectDir ?? ""));
  const worktree = path.join(worktreesRoot, projectDir ?? "", taskDir ?? "");
  await startShell(window);
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
  await expect(firstWindow.getByText("Add a repository to start")).toBeVisible();
  await firstWindow.keyboard.press("Alt+KeyA");
  await firstWindow.keyboard.press("Shift+KeyP");
  await expect(
    firstWindow.getByRole("dialog", { name: "Add project" }).getByRole("textbox"),
  ).toBeFocused();
  await firstWindow.keyboard.type(repo);
  await firstWindow.keyboard.press("Enter");
  await expect(
    workspace(firstWindow).getByRole("button", { name: "New task", exact: true }),
  ).toBeEnabled();
  await createTask(firstWindow, "Keep me");
  await startShell(firstWindow);
  await first.close();

  const secondWindow = await openedWindow(await launchApp());
  await expect(workspace(secondWindow).getByRole("button", { name: /^Keep me/ })).toBeVisible();
  await expect(
    workspace(secondWindow).getByRole("button", { name: "New task", exact: true }),
  ).toBeEnabled();
  // The task's shell kept running on the server, so it is listed too.
  await expect(sessionTab(secondWindow, "shell")).toHaveCount(1);
});

// The composer starts the task's primary agent with the prompt as its launch argument
// (design.md, decision 3 and **Domain model → Task → Creation**).
test("a prompt creates the task and the fake agent receives it", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  await expect(promptField(window)).toBeFocused();
  await newTaskView(window).getByRole("button", { name: "Open in terminal" }).click();
  await promptField(window).click();
  await window.keyboard.type("Explain the build");
  await window.keyboard.press("Enter");

  // The task is listed at once under its seed title, with the agent's session selected.
  await expect(
    workspace(window).getByRole("button", { name: /^Explain the build/ }),
  ).toHaveAttribute("aria-current", "true");
  await expect(sessionTab(window, "claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  // No shell opened on its own.
  await expect(sessionTab(window, "shell")).toHaveCount(0);

  // The fake received the prompt on its command line, as one argument, never through a shell.
  const launch = readLaunches(stateDir).find((each) => each.agent === "claude");
  expect(launch?.argv.some((argument) => argument.trim() === "Explain the build")).toBe(true);
});

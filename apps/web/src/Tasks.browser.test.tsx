import type { CorralClient } from "@corral/client/corral-client";
import type { Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { createGitRepo } from "../test/git-repo.ts";
import { prefixShifted, prefixThen, screenText, realServerClients } from "../test/real-client.ts";
import { App } from "./App.tsx";

const { newClient } = realServerClients();

const workspace = () => page.getByRole("navigation", { name: "workspace" });
const taskButton = (title: string) =>
  workspace().getByRole("button", { name: new RegExp(`^${title}`) });
const shellButtons = () => workspace().getByRole("button", { name: /^shell/ });
const looseButtons = () => workspace().getByRole("button", { name: /^sh · / });
const focusedIsTerminal = () => document.activeElement?.classList.contains("xterm-helper-textarea");

const addProjectDialog = () => page.getByRole("dialog", { name: "Add project" });
const newTaskDialog = () => page.getByRole("dialog", { name: "New task" });
const removeTaskDialog = () => page.getByRole("alertdialog");

/** An app on the real server with one project added through the dialog. */
async function appWithProject(branches: string[] = []) {
  const client = newClient();
  const repo = await createGitRepo("repo", branches);
  await render(<App client={client} prefix="alt+a" />);
  await prefixShifted("p");
  await expect.element(addProjectDialog().getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard(`${repo}{Enter}`);
  await expect.element(addProjectDialog()).not.toBeInTheDocument();
  await expect.element(workspace().getByRole("button", { name: /^repo-/ })).toBeVisible();
  return { client, repo };
}

/** Creates a task from the keyboard with a new branch and waits for its shell. */
/** `shellCount` is how many shell sessions the sidebar lists afterwards, all tasks together. */
async function createTask(title: string, shellCount = 1) {
  await prefixThen("t");
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
  await userEvent.keyboard(`${title}{Enter}`);
  await expect.element(newTaskDialog()).not.toBeInTheDocument();
  await expect.element(taskButton(title)).toHaveAttribute("aria-current", "true");
  await expect.element(shellButtons()).toHaveLength(shellCount);
}

/** The screen with wrapped lines joined, so a long path is found whatever the width. */
const wrappedScreen = () => screenText().replaceAll("\n", "");

function taskNamed(client: CorralClient, title: string): Task {
  const task = client.tasks.getSnapshot().tasks.find((candidate) => candidate.title === title);
  if (!task) throw new Error(`no task "${title}"`);
  return task;
}

test("shift+p adds a project and the dialog returns the keyboard", async () => {
  await appWithProject();

  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(page.getByText(/No terminals/)).toBeVisible();
});

test("a path outside any repository, or a repository added twice, is explained in the dialog", async () => {
  const { repo } = await appWithProject();

  await prefixShifted("p");
  await expect.element(addProjectDialog().getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard("/{Enter}");
  await expect
    .element(addProjectDialog().getByRole("alert"))
    .toMatchTextContent("/ is not inside a git repository.");

  await userEvent.fill(addProjectDialog().getByRole("textbox"), repo);
  await userEvent.keyboard("{Enter}");
  await expect
    .element(addProjectDialog().getByRole("alert"))
    .toMatchTextContent("This repository is already added.");
  await expect.element(addProjectDialog()).toBeVisible();
});

test("a new task gets its own worktree and a terminal opens in it", async () => {
  const { client } = await appWithProject();

  await createTask("Fix login");

  const task = taskNamed(client, "Fix login");
  expect(task).toMatchObject({ ownsWorktree: true, state: "active" });
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("pwd{Enter}");
  await expect.poll(wrappedScreen).toContain(task.workspacePath);
});

test("prefix c adds a shell session to the current task, j and k move between tasks, n and p between its sessions", async () => {
  const { client } = await appWithProject();
  await createTask("First");
  await createTask("Second", 2);
  const first = taskNamed(client, "First");
  const second = taskNamed(client, "Second");

  await prefixThen("c");
  await expect.element(shellButtons()).toHaveLength(3);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("pwd{Enter}");
  await expect.poll(wrappedScreen).toContain(second.workspacePath);

  await prefixThen("k");
  await expect.element(taskButton("First")).toHaveAttribute("aria-current", "true");
  await userEvent.keyboard("pwd{Enter}");
  await expect.poll(wrappedScreen).toContain(first.workspacePath);

  await prefixThen("j");
  await expect.element(taskButton("Second")).toHaveAttribute("aria-current", "true");
  await prefixThen("n");
  await prefixThen("p");
  await expect.element(taskButton("Second")).toHaveAttribute("aria-current", "true");
  await userEvent.keyboard("pwd{Enter}");
  await expect.poll(wrappedScreen).toContain(second.workspacePath);
});

test("prefix a archives the current task and again unarchives it", async () => {
  await appWithProject();
  await createTask("Old news");

  await prefixThen("a");
  const toggle = workspace().getByRole("button", { name: "Archived (1)" });
  await expect.element(toggle).toBeVisible();
  await expect.element(taskButton("Old news")).toHaveAttribute("aria-current", "true");
  await expect
    .element(workspace().getByRole("button", { name: "unarchive Old news" }))
    .toBeVisible();

  await prefixThen("a");
  await expect.element(toggle).not.toBeInTheDocument();
  await expect.element(workspace().getByRole("button", { name: "archive Old news" })).toBeVisible();
});

test("an existing branch is picked in the dialog with the keyboard", async () => {
  const { client } = await appWithProject(["feature/x", "other"]);

  await prefixThen("t");
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
  await userEvent.keyboard("Continue{Tab}{ArrowDown}{Tab}");
  await expect.element(newTaskDialog().getByRole("combobox", { name: "Branch" })).toHaveFocus();
  await userEvent.keyboard("feat");
  await userEvent.keyboard("{ArrowDown}{Enter}{Enter}");

  await expect.element(taskButton("Continue")).toBeVisible();
  expect(taskNamed(client, "Continue").branch).toBe("feature/x");
});

test("git's own message is shown in the dialog when it refuses, and the form stays as it was", async () => {
  await appWithProject();

  await prefixThen("t");
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
  await userEvent.keyboard("Doomed");
  await userEvent.fill(
    newTaskDialog().getByRole("textbox", { name: "Base branch (optional)" }),
    "no-such-base",
  );
  await userEvent.keyboard("{Enter}");

  await expect.element(newTaskDialog().getByRole("alert")).toMatchTextContent(/no-such-base/);
  await expect
    .element(newTaskDialog().getByRole("textbox", { name: "Title" }))
    .toHaveValue("Doomed");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(workspace().getByRole("button", { name: /^Doomed/ }))
    .not.toBeInTheDocument();
});

test("shift+t removes a clean task after a confirmation, and Escape keeps it", async () => {
  const { client } = await appWithProject();
  await createTask("Short lived");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixShifted("t");
  await expect.element(removeTaskDialog().getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(removeTaskDialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  expect(client.tasks.getSnapshot().tasks).toHaveLength(1);

  await prefixShifted("t");
  await expect.element(removeTaskDialog().getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Tab}{Enter}");

  await expect.element(removeTaskDialog()).not.toBeInTheDocument();
  await expect.element(taskButton("Short lived")).not.toBeInTheDocument();
  await expect.element(shellButtons()).toHaveLength(0);
  expect(client.tasks.getSnapshot().tasks).toHaveLength(0);
});

test("a worktree with uncommitted files lists them and is only removed by Remove anyway", async () => {
  const { client } = await appWithProject();
  await createTask("Messy");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo scribble > notes.txt; echo done-$((3+4)){Enter}");
  await expect.poll(screenText).toContain("done-7");

  await prefixShifted("t");
  await expect.element(removeTaskDialog().getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Tab}{Enter}");
  await expect
    .element(removeTaskDialog().getByRole("list", { name: "uncommitted files" }))
    .toMatchTextContent("notes.txt");
  await expect.element(removeTaskDialog().getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(client.tasks.getSnapshot().tasks).toHaveLength(1);

  await userEvent.keyboard("{Tab}{Enter}");
  await expect.element(removeTaskDialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(client.tasks.getSnapshot().tasks).toHaveLength(0));
});

test("terminals outside any task are listed under No task, apart from the tasks", async () => {
  const { client } = await appWithProject();
  await createTask("Work");
  await client.connection.api.terminals.create({ size: { cols: 80, rows: 24 } });

  await expect.element(workspace().getByRole("button", { name: "No task" })).toBeVisible();
  await workspace().getByRole("button", { name: "No task" }).click();
  await expect.element(workspace().getByRole("button", { name: "No task" })).toBeVisible();

  await prefixThen("c");
  await expect.element(looseButtons()).toHaveLength(2);
  await expect.element(shellButtons()).toHaveLength(1);
  await prefixThen("k");
  await expect.element(taskButton("Work")).toHaveAttribute("aria-current", "true");
});

import type { CorralClient } from "@corral/client/corral-client";
import type { Task } from "@corral/protocol/rpc";
import { createGitRepo } from "../../../test/git-repo.ts";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  prefixShifted,
  prefixThen,
  screenText,
  realServerClients,
} from "../../../test/real-client.ts";
import {
  addProjectDialog,
  appWithProject as openProject,
  createTask,
  focusedIsTerminal,
  newTaskDialog,
  shellButtons,
  taskButton,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const looseButtons = () => workspace().getByRole("button", { name: /^sh · / });
const removeTaskDialog = () => page.getByRole("alertdialog");

const appWithProject = (branches: string[] = []) => openProject(newClient(), branches);

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
  await createTask("Second");
  const first = taskNamed(client, "First");
  const second = taskNamed(client, "Second");

  await prefixThen("c");
  await expect.element(shellButtons()).toHaveLength(2);
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

test("prefix d settles the current task, which stops its shell, and again unsettles it, which starts a new one", async () => {
  const { client } = await appWithProject();
  await createTask("Old news");
  const shell = client.sessions.getSnapshot().sessions[0]!;
  expect(shell.state).toBe("running");

  await prefixThen("d");
  const toggle = workspace().getByRole("button", { name: "Settled (1)" });
  await expect.element(toggle).toBeVisible();
  await expect.element(taskButton("Old news")).toHaveAttribute("aria-current", "true");
  await workspace().getByRole("button", { name: "Task actions for Old news" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Unsettle task" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(client.sessions.getSnapshot().sessions).toEqual([
      { ...shell, state: "stopped", terminalId: null },
    ]),
  );

  await prefixThen("d");
  await expect.element(toggle).not.toBeInTheDocument();
  await workspace().getByRole("button", { name: "Task actions for Old news" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Settle task" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(client.sessions.getSnapshot().sessions).toEqual([
      { ...shell, state: "running", terminalId: expect.any(String) },
    ]),
  );
});

test("New task starts on the selected project and can create the task in another project", async () => {
  const { client } = await appWithProject();
  await createTask("Here");
  const first = client.projects.getSnapshot().projects[0]!;
  const otherRepo = await createGitRepo("second");
  await prefixShifted("p");
  await userEvent.fill(addProjectDialog().getByRole("textbox"), otherRepo);
  await userEvent.keyboard("{Enter}");
  await expect.element(addProjectDialog()).not.toBeInTheDocument();
  const other = client.projects
    .getSnapshot()
    .projects.find((project) => project.path === otherRepo)!;
  expect(other.id).not.toBe(first.id);

  await taskButton("Here").click();
  await expect.element(taskButton("Here")).toHaveAttribute("aria-current", "true");
  await prefixThen("t");
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
  await userEvent.keyboard("There");
  const project = newTaskDialog().getByRole("combobox", { name: /Project/ });
  await expect.element(project).toHaveValue(first.name);
  await userEvent.click(project);
  await userEvent.fill(project, other.name);
  await page.getByRole("option", { name: new RegExp(other.name) }).click();
  await expect.element(project).toHaveValue(other.name);
  await newTaskDialog().getByRole("button", { name: "Create task" }).click();

  await expect.element(taskButton("There")).toBeVisible();
  expect(taskNamed(client, "There").projectId).toBe(other.id);
});

test("an existing branch is picked in the dialog with the keyboard", async () => {
  const { client } = await appWithProject(["feature/x", "other"]);

  await prefixThen("t");
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
  await userEvent.keyboard("Continue");
  await newTaskDialog().getByRole("radio", { name: "Existing branch" }).click();
  const branch = newTaskDialog().getByRole("combobox", { name: "Branch" });
  await userEvent.click(branch);
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
  await taskButton("Work").click();
  await expect.element(taskButton("Work")).toHaveAttribute("aria-current", "true");
  await expect.element(shellButtons()).toHaveLength(1);
});

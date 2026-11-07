import type { CorralClient } from "@corral/client/corral-client";
import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixShifted, prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App, renderApp } from "../../../test/render-app.tsx";
import { FindTaskDialog } from "./find-task-dialog.tsx";
import {
  appWithProject,
  createTask,
  createTaskWithShell,
  focusedIsTerminal,
  taskButton,
  taskHeader,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const findDialog = () => page.getByRole("dialog", { name: "Find task" });
const searchInput = () => findDialog().getByRole("combobox", { name: "Tasks" });
const findOption = (name: RegExp) => findDialog().getByRole("option", { name });

function taskNamed(client: CorralClient, title: string): Task {
  const task = client.tasks.getSnapshot().tasks.find((candidate) => candidate.title === title);
  if (!task) throw new Error(`no task "${title}"`);
  return task;
}

function taskState(client: CorralClient, id: string): Task["state"] | undefined {
  return client.tasks.getSnapshot().tasks.find((task) => task.id === id)?.state;
}

const repoProject: Project = {
  id: "p1",
  name: "repo",
  path: "/repos/repo",
  defaultBaseBranch: "main",
};

const settledTask = (id: string, title: string, createdAt: number): Task => ({
  id,
  projectId: repoProject.id,
  title,
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: `branch-${id}`,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state: "settled",
  seenAt: null,
  createdAt,
});

test("a failed continue keeps the dialog and its error, and a retry can still continue", async () => {
  const onContinue = vi
    .fn<(task: Task) => Promise<void>>()
    .mockRejectedValueOnce(new Error("This task no longer exists."))
    .mockResolvedValueOnce(undefined);
  const onClose = vi.fn<() => void>();
  await render(
    <FindTaskDialog
      projects={[repoProject]}
      tasks={[settledTask("t1", "Archived work", 1)]}
      onOpen={vi.fn<(task: Task) => void>()}
      onContinue={onContinue}
      onClose={onClose}
    />,
  );

  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await expect.element(page.getByRole("alert")).toMatchTextContent("This task no longer exists.");
  expect(onClose).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Continue settled task" }).click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onContinue).toHaveBeenCalledTimes(2);
});

test("removing the selected task while the search is open falls back to the first remaining one", async () => {
  const beta = settledTask("t2", "Archived beta", 2);
  const alpha = settledTask("t1", "Archived alpha", 1);
  const onContinue = vi.fn<(task: Task) => Promise<void>>().mockResolvedValue(undefined);
  const props = {
    projects: [repoProject],
    onOpen: vi.fn<(task: Task) => void>(),
    onContinue,
    onClose: vi.fn<() => void>(),
  };
  const screen = await render(<FindTaskDialog {...props} tasks={[beta, alpha]} />);

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(findOption(/Archived alpha/)).toHaveAttribute("aria-selected", "true");

  await screen.rerender(<FindTaskDialog {...props} tasks={[beta]} />);
  await expect.element(findOption(/Archived alpha/)).not.toBeInTheDocument();
  await expect.element(findOption(/Archived beta/)).toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect(onContinue).toHaveBeenCalledExactlyOnceWith(beta));
});

test("prefix f opens the search, filters, Enter opens the task and Escape returns to the terminal", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Fix login");
  await createTaskWithShell("Write docs");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("f");
  await expect.element(findDialog()).toBeVisible();
  await expect.element(searchInput()).toHaveFocus();

  await userEvent.keyboard("login");
  await expect.element(findOption(/Fix login/)).toBeVisible();
  await expect.element(findOption(/Write docs/)).not.toBeInTheDocument();

  await userEvent.keyboard("{Enter}");
  await expect.element(findDialog()).not.toBeInTheDocument();
  await expect.element(taskButton("Fix login")).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("f");
  await userEvent.keyboard("{Escape}");
  await expect.element(findDialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("a settled result shows its project and state; Enter inspects it, Continue resumes the same task and session", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Old work");
  const task = taskNamed(client, "Old work");
  const project = client.projects.getSnapshot().projects.find((each) => each.id === task.projectId);
  const [session] = client.sessions.getSnapshot().sessions;

  await prefixThen("d");
  await vi.waitFor(() => expect(taskState(client, task.id)).toBe("settled"));
  await vi.waitFor(() =>
    expect(
      client.sessions.getSnapshot().sessions.find((each) => each.id === session!.id),
    ).toMatchObject({ state: "stopped", terminalId: null }),
  );
  await expect.element(taskHeader().getByText("Settled")).toBeVisible();

  await prefixThen("f");
  await userEvent.keyboard("old work");
  const option = findOption(/Old work/);
  await expect.element(option).toBeVisible();
  await expect.element(option).toMatchTextContent("settled");
  await expect.element(option).toMatchTextContent(project!.name);

  await userEvent.keyboard("{Enter}");
  await expect.element(findDialog()).not.toBeInTheDocument();
  await expect.element(taskButton("Old work")).toHaveAttribute("aria-current", "true");
  expect(taskState(client, task.id)).toBe("settled");
  expect(client.sessions.getSnapshot().sessions).toEqual([
    expect.objectContaining({ id: session!.id, state: "stopped", terminalId: null }),
  ]);

  await prefixThen("f");
  await userEvent.keyboard("old work");
  await expect
    .element(findDialog().getByRole("button", { name: "Continue settled task" }))
    .toBeVisible();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");

  await expect.element(findDialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(taskState(client, task.id)).toBe("active"));
  await vi.waitFor(() =>
    expect(client.sessions.getSnapshot().sessions).toEqual([
      expect.objectContaining({
        id: session!.id,
        state: "running",
        terminalId: expect.any(String),
      }),
    ]),
  );
  await expect.element(taskHeader().getByText("Settled")).not.toBeInTheDocument();
  await expect.element(taskButton("Old work")).toHaveAttribute("aria-current", "true");
  await expect
    .element(workspace().getByRole("button", { name: "Settled (1)" }))
    .not.toBeInTheDocument();
});

test("the find-task binding is configurable and in the palette, and unbinding it keeps the visible entry", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await writeConfig('[keys.bindings]\nfind-task = "q"\n');
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.keys.bindings["find-task"]).toBe("q"),
  );

  await prefixThen("q");
  await expect.element(findDialog()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(findDialog()).not.toBeInTheDocument();

  await prefixThen(" ");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect
    .element(palette.getByRole("option", { name: /Find task/ }))
    .toMatchTextContent("alt+a q");
  await userEvent.keyboard("{Escape}");
  await expect.element(palette).not.toBeInTheDocument();

  await writeConfig('[keys.bindings]\nfind-task = ""\n');
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.keys.bindings["find-task"]).toBeNull(),
  );

  await prefixThen("q");
  await expect.element(findDialog()).not.toBeInTheDocument();

  await workspace().getByRole("button", { name: "Search tasks" }).click();
  await expect.element(findDialog()).toBeVisible();
  await expect.element(searchInput()).toHaveFocus();
  await userEvent.keyboard("no-such-task");
  await expect.element(findDialog().getByText("No task matches.")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(findDialog()).not.toBeInTheDocument();
});

test("a task opened from the search survives a reload through the route's search params", async () => {
  const client = newClient();
  const repo = await createGitRepo("repo");
  const screen = await renderApp(client);

  await prefixShifted("p");
  await expect
    .element(page.getByRole("dialog", { name: "Add project" }).getByRole("textbox"))
    .toHaveFocus();
  await userEvent.keyboard(`${repo}{Enter}`);
  await expect.element(workspace().getByRole("button", { name: "New task" })).toBeEnabled();
  await createTask("Reload me");
  await createTask("Other");

  await prefixThen("f");
  await userEvent.keyboard("reload");
  await userEvent.keyboard("{Enter}");
  await expect.element(taskButton("Reload me")).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(screen.history.location.search).toContain("task="));
  const href = `${screen.history.location.pathname}${screen.history.location.search}`;
  await screen.unmount();

  await renderApp(client, [href]);
  await expect.element(taskButton("Reload me")).toHaveAttribute("aria-current", "true");
  await expect.element(findDialog()).not.toBeInTheDocument();
});

test("the find-task footer stays inside the dialog instead of being clipped", async () => {
  await render(
    <FindTaskDialog
      projects={[repoProject]}
      tasks={[settledTask("t1", "Archived work", 1)]}
      onOpen={vi.fn<(task: Task) => void>()}
      onContinue={vi.fn<(task: Task) => Promise<void>>().mockResolvedValue(undefined)}
      onClose={vi.fn<() => void>()}
    />,
  );
  await expect.element(findDialog()).toBeVisible();

  const dialog = findDialog().element();
  const content = dialog.getBoundingClientRect();
  const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
  if (!footer) throw new Error("the find-task footer is missing");
  const box = footer.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(content.left);
  expect(box.right).toBeLessThanOrEqual(content.right);
  expect(box.bottom).toBeLessThanOrEqual(content.bottom);
});

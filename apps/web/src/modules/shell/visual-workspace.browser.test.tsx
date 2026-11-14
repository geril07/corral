import type { CorralClient } from "@corral/client/corral-client";
import type { Task, TaskSource } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { removeDirectoryIn } from "../../../test/files-client.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { realServerClients, prefixThen } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();

async function connectedClient(): Promise<CorralClient> {
  const client = newClient();
  await vi.waitFor(() => expect(client.connection.state.getSnapshot().status).toBe("connected"));
  return client;
}

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-task-id]")];
const rowIds = () => rows().map((element) => element.getAttribute("data-task-id") ?? "");
const rowFor = (title: string) => page.getByRole("button", { name: new RegExp(title) });
const shelfToggleButton = () => page.getByRole("button", { name: /^Settled \(/ });
/** Each active row's id and its top edge, for the one check that settling moves nothing above it. */
const activeTops = () =>
  activeIds().map((id) => {
    const element = document.querySelector(`[data-task-id="${CSS.escape(id)}"]`);
    return { id, top: element?.getBoundingClientRect().top ?? 0 };
  });

/** The cards inside the Settled shelf; the active list is the same query outside it. */
const shelfIds = () =>
  rows()
    .filter((element) => element.closest(".visual-shelf") !== null)
    .map((element) => element.getAttribute("data-task-id") ?? "");

const activeIds = () =>
  rows()
    .filter((element) => element.closest(".visual-shelf") === null)
    .map((element) => element.getAttribute("data-task-id") ?? "");

async function waitForRows(count: number) {
  await vi.waitFor(() => expect(rows()).toHaveLength(count));
}

async function waitForActiveRows(count: number) {
  await vi.waitFor(() => expect(activeIds()).toHaveLength(count));
}

function titleOf(client: CorralClient, id: string): string {
  const task = client.tasks.getSnapshot().tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task.title;
}

/** A real project with worktree tasks, created through the same RPC the shell watches. */
async function projectWithTasks(
  client: CorralClient,
  titles: readonly string[],
): Promise<{ tasks: Task[] }> {
  const repo = await createGitRepo(`menu-${titles.length}-${Date.now()}`);
  const project = await client.connection.api.projects.add({ path: repo });
  const tasks = await Promise.all(
    titles.map((title) =>
      client.connection.api.tasks.create({
        projectId: project.id,
        title,
        workspace: { type: "new-branch" },
      }),
    ),
  );
  await vi.waitFor(() => {
    const listed = client.tasks
      .getSnapshot()
      .tasks.filter((task) => task.projectId === project.id).length;
    expect(listed).toBe(titles.length);
  });
  return { tasks };
}

test("confirming a removal selects and focuses the next row, never the list's top", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["Alpha task", "Bravo task", "Charlie task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForRows(3);

  const order = rowIds();
  const removed = order[1]!;
  const next = order[2] ?? order[0]!;
  await userEvent.click(rowFor(titleOf(client, removed)));

  await rowFor(titleOf(client, removed)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove task" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  await expect.poll(() => document.activeElement?.getAttribute("data-task-id")).toBe(next);
  expect(
    document.querySelector(`[data-task-id="${CSS.escape(next)}"]`)?.getAttribute("aria-current"),
  ).toBe("true");
  await unmount();
});

test("removing a row that is not current leaves selection and focus where they were", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["Delta task", "Echo task", "Foxtrot task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForRows(3);

  const order = rowIds();
  const current = order[0]!;
  const removed = order[1]!;
  await userEvent.click(rowFor(titleOf(client, current)));

  await rowFor(titleOf(client, removed)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove task" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  await expect.poll(() => document.activeElement?.getAttribute("data-task-id")).toBe(current);
  expect(
    document.querySelector(`[data-task-id="${CSS.escape(current)}"]`)?.getAttribute("aria-current"),
  ).toBe("true");
  await unmount();
});

test("the remove dialog names the branch checked out in the worktree now", async () => {
  const client = await connectedClient();
  const repo = await createGitRepo(`menu-branch-${Date.now()}`);
  const project = await client.connection.api.projects.add({ path: repo });
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Branch task",
    workspace: { type: "new-branch", branch: "feat/live-branch" },
  });
  const { unmount } = await render(<App client={client} />);
  await waitForRows(1);

  await rowFor("Branch task").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toMatchTextContent("The branch feat/live-branch stays.");
  await expect
    .element(dialog)
    .not.toMatchTextContent("The branch checked out in the worktree stays.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await unmount();
});

test("a worktree deleted outside is named, removed, and reported in the shell's notice", async () => {
  const client = await connectedClient();
  const repo = await createGitRepo(`menu-gone-${Date.now()}`);
  const project = await client.connection.api.projects.add({ path: repo });
  const task = await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Gone task",
    workspace: { type: "new-branch" },
  });
  const { unmount } = await render(<App client={client} />);
  await waitForRows(1);

  await removeDirectoryIn(task.workspacePath);
  await rowFor("Gone task").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toMatchTextContent("already gone");
  await expect.element(dialog).toMatchTextContent(task.workspacePath);
  await expect.element(dialog).toMatchTextContent("prunes the stale git worktree entry");
  await expect.element(dialog).toMatchTextContent("keeps the branch");
  await expect.element(dialog).not.toMatchTextContent(`keeps the branch ${task.branch}`);
  await dialog.getByRole("button", { name: "Remove task" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  await expect
    .element(
      page
        .getByRole("status")
        .filter({ hasText: "The directory was already gone. The stale git entry was pruned;" }),
    )
    .toBeVisible();
  await unmount();
});

test("View issue source… opens the real dialog only for a task with a source", async () => {
  const source: TaskSource = {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/issues/7",
    title: "Imported issue title",
    body: "Imported issue body",
    fetchedAt: 0,
  };
  const client = await connectedClient();
  await client.connection.api.tasks.create({
    projectId: null,
    source,
    workspace: { type: "scratch" },
  });
  await client.connection.api.tasks.create({
    projectId: null,
    title: "Plain scratch task",
    workspace: { type: "scratch" },
  });
  const { unmount } = await render(<App client={client} />);
  await waitForRows(2);

  await rowFor("Imported issue title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "View issue source…" }).click();
  const dialog = page.getByRole("dialog", { name: "Issue source" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toMatchTextContent("Imported issue title");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  await rowFor("Plain scratch task").click({ button: "right" });
  await expect
    .element(page.getByRole("menuitem", { name: "View issue source…" }))
    .not.toBeInTheDocument();
  await unmount();
});

test("a task's settled state moves it between the active list and the shelf, both ways", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["Alpha task", "Bravo task", "Charlie task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForActiveRows(3);

  const settled = rowIds()[1]!;

  await rowFor(titleOf(client, settled)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle task" }).click();

  // The row leaves the active list; the shelf names the one settled task and stays closed.
  await waitForActiveRows(2);
  expect(activeIds()).not.toContain(settled);
  await expect.element(shelfToggleButton()).toMatchTextContent("Settled (1)");
  await expect.element(shelfToggleButton()).toHaveAttribute("aria-expanded", "false");
  expect(shelfIds()).toEqual([]);
  // The menu is a portal, so the command still hands the keyboard to the row's new home: the
  // disclosure that names it, never `<body>` or a pane control.
  await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("Settled (1)"));

  await shelfToggleButton().click();
  await expect.element(shelfToggleButton()).toHaveAttribute("aria-expanded", "true");
  await expect.element(rowFor(titleOf(client, settled))).toBeVisible();
  expect(shelfIds()).toEqual([settled]);
  // The same card recipe, marked with the server-owned state.
  expect(
    document
      .querySelector(`[data-task-id="${CSS.escape(settled)}"]`)
      ?.closest(".visual-task-card")
      ?.getAttribute("data-settled"),
  ).toBe("true");

  await rowFor(titleOf(client, settled)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unsettle task" }).click();
  await waitForActiveRows(3);
  expect(activeIds()).toContain(settled);
  await expect.element(shelfToggleButton()).not.toBeInTheDocument();
  await unmount();
});

test("settling the selected task keeps its working area, its tabs and the truth about its sessions", async () => {
  const client = await connectedClient();
  const repo = await createGitRepo(`settle-open-${Date.now()}`);
  const project = await client.connection.api.projects.add({ path: repo });
  const task = await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Settle me",
    prompt: "Explain the build",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  await client.connection.api.sessions.start({
    taskId: task.id,
    kind: "shell",
    size: { cols: 80, rows: 24 },
  });
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Stay active",
    workspace: { type: "main-worktree" },
  });
  const { unmount } = await render(
    <App client={client} initialEntries={[`/?project=${project.id}&task=${task.id}`]} />,
  );
  const sessionTabs = page.getByRole("tablist", { name: "Sessions" });
  await expect.element(sessionTabs.getByRole("tab").first()).toBeVisible();
  const tabsBefore = sessionTabs
    .getByRole("tab")
    .elements()
    .map((element) => element.textContent ?? "");
  expect(tabsBefore).toHaveLength(2);

  await prefixThen("d");
  const shelfToggle = page.getByRole("button", { name: "Settled (1)" });
  await expect.element(shelfToggle).toBeVisible();
  await expect.element(page.getByText("Settled", { exact: true })).toBeVisible();
  // The current settled task keeps its row, its tabs and its selection.
  expect(
    document.querySelector(`[data-task-id="${CSS.escape(task.id)}"]`)?.getAttribute("aria-current"),
  ).toBe("true");
  expect(
    sessionTabs
      .getByRole("tab")
      .elements()
      .map((element) => element.textContent ?? ""),
  ).toEqual(tabsBefore);
  // Settle is metadata: both sessions keep running, so no pane switches to the stopped shape and
  // nothing on screen speaks about the shelf.
  await expect
    .element(page.getByRole("region", { name: /stopped session/ }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("This task is settled.")).not.toBeInTheDocument();

  // Selecting another task, then the settled one, opens the working area again with its sessions.
  await userEvent.click(rowFor("Stay active"));
  await expect.element(page.getByRole("heading", { name: "Stay active" })).toBeVisible();
  await shelfToggle.click();
  await userEvent.click(rowFor("Settle me"));
  await expect.element(page.getByRole("heading", { name: "Settle me" })).toBeVisible();
  await expect.element(sessionTabs.getByRole("tab").first()).toBeVisible();
  expect(
    sessionTabs
      .getByRole("tab")
      .elements()
      .map((element) => element.textContent ?? ""),
  ).toEqual(tabsBefore);
  await expect.element(page.getByText("Settled", { exact: true })).toBeVisible();
  await unmount();
});

test("the shelf's collapsed state is device-local and survives a reload", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["First task", "Second task"]);
  const screen = await render(<App client={client} />);
  await waitForActiveRows(2);
  const settled = rowIds()[0]!;
  await rowFor(titleOf(client, settled)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  await expect.element(shelfToggleButton()).toBeVisible();
  // Collapsed by default, as `design.md` asks.
  await expect.element(shelfToggleButton()).toHaveAttribute("aria-expanded", "false");

  await shelfToggleButton().click();
  await expect.element(shelfToggleButton()).toHaveAttribute("aria-expanded", "true");
  await screen.unmount();

  // A fresh page reads the same device preference; the server still owns the settled state.
  const { unmount } = await render(<App client={client} />);
  await expect.element(shelfToggleButton()).toHaveAttribute("aria-expanded", "true");
  await expect.element(rowFor(titleOf(client, settled))).toBeVisible();
  await unmount();
});

test("settling a middle task leaves the active rows above it where they were", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["One task", "Two task", "Three task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForActiveRows(3);

  const before = activeTops();
  const middle = rowIds()[1]!;
  await rowFor(titleOf(client, middle)).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  await waitForActiveRows(2);

  const after = activeTops();
  // The row above keeps its place; only the row below closes the gap.
  expect(after[0]).toEqual(before[0]);
  expect(after.map((row) => row.id)).toEqual([before[0]!.id, before[2]!.id]);
  // The shelf rests below the active rows.
  const toggle = page.getByRole("button", { name: "Settled (1)" }).element();
  const lastActive = document.querySelector(`[data-task-id="${CSS.escape(after[1]!.id)}"]`);
  expect(toggle.getBoundingClientRect().top).toBeGreaterThan(
    lastActive?.getBoundingClientRect().bottom ?? 0,
  );
  await unmount();
});

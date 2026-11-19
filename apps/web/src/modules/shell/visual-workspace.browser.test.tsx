import type { CorralClient } from "@corral/client/corral-client";
import type { Task, TaskSource } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { removeDirectoryIn } from "../../../test/files-client.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { writeConfig } from "../../../test/config-command.ts";
import { realServerClients, prefixThen } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import { appWithProject, focusedIsTerminal, taskWithShell } from "../../../test/task-flows.tsx";

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

  const importedRow = rowFor("Imported issue title");
  const importedId = importedRow.element().getAttribute("data-task-id");
  await importedRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "View issue source…" }).click();
  const dialog = page.getByRole("dialog", { name: "Issue source" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toMatchTextContent("Imported issue title");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.poll(() => document.activeElement?.getAttribute("data-task-id")).toBe(importedId);

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

test("a wake time that passes returns the row on its own, without a reload", async () => {
  const client = await connectedClient();
  const { tasks } = await projectWithTasks(client, ["Short nap"]);
  const { unmount } = await render(<App client={client} />);
  await waitForRows(1);

  await client.connection.api.tasks.snooze({
    id: tasks[0]!.id,
    snoozedUntil: Date.now() + 1_000,
  });

  await waitForActiveRows(0);
  await expect.element(page.getByRole("button", { name: "Snoozed (1)" })).toBeVisible();
  // No reload, no click: the wake itself puts the row back within its second.
  await expect.poll(() => activeIds(), { timeout: 5_000 }).toEqual([tasks[0]!.id]);
  await expect.element(page.getByRole("button", { name: /^Snoozed \(/ })).not.toBeInTheDocument();
  await unmount();
});

test("snoozing a task moves it to the Snoozed shelf, and Wake task brings it back", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["Napping task", "Working task"]);
  const task = client.tasks.getSnapshot().tasks.find((each) => each.title === "Napping task")!;
  const { unmount } = await render(<App client={client} />);
  await waitForRows(2);
  // The other task stays current, so this is a row that is not on screen being snoozed.
  await userEvent.click(rowFor("Working task"));
  await expect.element(page.getByRole("heading", { name: "Working task" })).toBeVisible();

  await rowFor("Napping task").click({ button: "right" });
  const snoozeMenu = page.getByRole("menuitem", { name: "Snooze" });
  await expect.element(snoozeMenu).toBeVisible();
  await userEvent.hover(snoozeMenu);
  await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();

  // The task stays active in the store; only the list it is drawn in changes. The keyboard goes
  // to the shelf that now holds the row, because a collapsed shelf mounts no rows.
  await expect
    .poll(() => document.activeElement?.getAttribute("aria-controls"))
    .toBe("visual-snoozed-list");
  await waitForActiveRows(1);
  await vi.waitFor(() =>
    expect(
      client.tasks.getSnapshot().tasks.find((each) => each.id === task.id)?.snoozedUntil,
    ).toBeGreaterThan(Date.now()),
  );
  const snoozedToggle = page.getByRole("button", { name: "Snoozed (1)" });
  await expect.element(snoozedToggle).toBeVisible();
  await snoozedToggle.click();
  const snoozedList = page.getByRole("list", { name: "Snoozed tasks" });
  await expect.element(snoozedList.getByRole("button", { name: /Napping task/ })).toBeVisible();
  // In place of a status the row says how long it waits, in the snoozed tone.
  const wakeLabel = snoozedList.getByText("1h", { exact: true });
  await expect.element(wakeLabel).toBeVisible();
  expect(wakeLabel.element().closest(".visual-task-status")?.getAttribute("data-tone")).toBe(
    "snoozed",
  );
  // The exact wake time is in the row's own hover card; a native `title` never stands in for it.
  expect(wakeLabel.element().closest(".visual-task-status")?.hasAttribute("title")).toBe(false);
  await userEvent.hover(rowFor("Napping task"));
  await expect
    .poll(() => document.querySelector(".visual-metadata-tooltip")?.textContent)
    .toContain("Wakes at");
  await userEvent.unhover(rowFor("Napping task"));

  await rowFor("Napping task").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Wake task" }).click();

  await waitForActiveRows(2);
  // The row is back in the mounted active list, so it takes the keyboard itself.
  await expect.poll(() => document.activeElement?.getAttribute("data-task-id")).toBe(task.id);
  await expect.element(page.getByRole("button", { name: /^Snoozed \(/ })).not.toBeInTheDocument();
  expect(
    client.tasks.getSnapshot().tasks.find((each) => each.id === task.id)?.snoozedUntil,
  ).toBeNull();
  await unmount();
});

test("the custom snooze dialog opens on a real time, refuses a bad duration, and parks the row", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["First task", "Second task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForRows(2);
  // The shell selects the first row; snoozing it must hand the selection to the row that remains.
  const [current, other] = activeIds();
  await expect
    .element(page.getByRole("heading", { name: titleOf(client, current!) }))
    .toBeVisible();

  await rowFor(titleOf(client, current!)).click({ button: "right" });
  await userEvent.hover(page.getByRole("menuitem", { name: "Snooze" }));
  await page.getByRole("menuitem", { name: /^Custom/ }).click();

  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  // The reference opens on Date and time with a real instant, not an empty form.
  await expect
    .element(page.getByRole("radio", { name: "Date and time" }))
    .toHaveAttribute("aria-checked", "true");
  const dateInput = page.getByLabelText("Date").element();
  const timeInput = page.getByLabelText("Time").element();
  if (!(dateInput instanceof HTMLInputElement) || !(timeInput instanceof HTMLInputElement)) {
    throw new Error("the date and time fields are not inputs");
  }
  expect(dateInput.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(timeInput.value).toMatch(/^\d{2}:\d{2}$/);

  // Duration mode resolves through the same future/30-day rule, and the sentence stays in the dialog.
  await page.getByRole("radio", { name: "Duration" }).click();
  const amount = page.getByLabelText("Snooze for");
  await userEvent.clear(amount);
  await page.getByRole("button", { name: "Snooze" }).click();
  await expect
    .element(dialog.getByText("Enter a duration between 1 minute and 30 days."))
    .toBeVisible();

  await userEvent.type(amount, "2");
  await page.getByRole("button", { name: "Snooze" }).click();

  await expect.element(dialog).not.toBeInTheDocument();
  await expect.poll(() => activeIds()).toEqual([other]);
  await expect.poll(() => document.activeElement?.getAttribute("data-task-id")).toBe(other);
  await unmount();
});

test("both shelf disclosures stack under the list instead of splitting the free space", async () => {
  const client = await connectedClient();
  const { tasks } = await projectWithTasks(client, ["Loose task", "Snoozed task", "Settled task"]);
  const snoozed = tasks.find((each) => each.title === "Snoozed task")!;
  const settled = tasks.find((each) => each.title === "Settled task")!;
  await client.connection.api.tasks.snooze({
    id: snoozed.id,
    snoozedUntil: Date.now() + 60 * 60 * 1000,
  });
  await client.connection.api.tasks.setState({ id: settled.id, state: "settled" });
  const { unmount } = await render(<App client={client} />);
  await waitForActiveRows(1);

  const snoozedToggle = page.getByRole("button", { name: "Snoozed (1)" });
  const settledToggle = page.getByRole("button", { name: "Settled (1)" });
  await expect.element(snoozedToggle).toBeVisible();
  await expect.element(settledToggle).toBeVisible();
  const row = document.querySelector<HTMLElement>(`[data-task-id]`)!;

  await vi.waitFor(() => {
    const above = snoozedToggle.element().getBoundingClientRect();
    const below = settledToggle.element().getBoundingClientRect();
    // The two disclosures are one group: a gap between them is the group's spacing, not the
    // free space a per-shelf bottom margin would split.
    expect(below.top - above.bottom).toBeLessThan(24);
    expect(above.top).toBeGreaterThan(row.getBoundingClientRect().bottom);
  });
  await unmount();
});

test("snoozing the task on screen selects the row that took its place", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["First task", "Second task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForRows(2);
  // The shell selects the first row when the route names none; the order is the sidebar's own.
  const [current, other] = activeIds();
  await expect
    .element(page.getByRole("heading", { name: titleOf(client, current!) }))
    .toBeVisible();

  await rowFor(titleOf(client, current!)).click({ button: "right" });
  await userEvent.hover(page.getByRole("menuitem", { name: "Snooze" }));
  await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();

  // The snoozed task stays active in the store; the shell moves to the row that replaced it.
  await expect.element(page.getByRole("heading", { name: titleOf(client, other!) })).toBeVisible();
  await expect.poll(() => activeIds()).toEqual([other]);
  await expect.poll(() => document.activeElement?.getAttribute("data-task-id")).toBe(other);
  await unmount();
});

test("snoozing the last visible task shows the explicit empty state", async () => {
  const client = await connectedClient();
  const { tasks } = await projectWithTasks(client, ["Only task"]);
  const only = tasks[0]!;
  const { unmount } = await render(<App client={client} />);
  await waitForRows(1);

  await rowFor(titleOf(client, only.id)).click({ button: "right" });
  await userEvent.hover(page.getByRole("menuitem", { name: "Snooze" }));
  await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();

  await expect.element(page.getByRole("main").getByText("No active tasks.")).toBeVisible();
  expect(activeIds()).toEqual([]);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("New task");
  await unmount();
});

test("a task that wakes while it is on screen does not call itself Woke", async () => {
  const client = await connectedClient();
  const { tasks } = await projectWithTasks(client, ["Waiting task", "Other task"]);
  const waiting = tasks.find((each) => each.title === "Waiting task")!;
  const { unmount } = await render(<App client={client} />);
  await waitForRows(2);
  // Long enough to open the shelf and select the row before the wake lands.
  await client.connection.api.tasks.snooze({
    id: waiting.id,
    snoozedUntil: Date.now() + 2_500,
  });
  await waitForActiveRows(1);

  // Select the task from its shelf: the wake then lands on the row the user is looking at, so the
  // visit that opened it already covers the wake and no notice is left to dismiss.
  await page.getByRole("button", { name: "Snoozed (1)" }).click();
  await userEvent.click(rowFor("Waiting task"));
  await expect.element(page.getByRole("heading", { name: "Waiting task" })).toBeVisible();

  await expect.poll(() => activeIds(), { timeout: 5_000 }).toHaveLength(2);
  await expect
    .element(page.getByRole("button", { name: "Dismiss Woke notification" }))
    .not.toBeInTheDocument();
  await unmount();
});

test("a task that comes back from a snooze says Woke until it is dismissed or opened", async () => {
  const client = await connectedClient();
  const { tasks } = await projectWithTasks(client, ["Returning task", "Other task"]);
  const returning = tasks.find((each) => each.title === "Returning task")!;
  const { unmount } = await render(<App client={client} />);
  await waitForRows(2);
  // Keep the returning task off screen, so the notice cannot be cleared by the selection itself.
  await userEvent.click(rowFor("Other task"));
  await expect.element(page.getByRole("heading", { name: "Other task" })).toBeVisible();

  const woke = page.getByRole("button", { name: "Dismiss Woke notification" });
  await client.connection.api.tasks.snooze({
    id: returning.id,
    snoozedUntil: Date.now() + 800,
  });
  await waitForActiveRows(2);
  await expect.element(woke).toBeVisible();
  // A native `title` is not a tooltip; the pill uses the shell's own.
  expect(woke.element().hasAttribute("title")).toBe(false);

  // The settle action the row reveals on hover sits beside the pill, not on top of it.
  await userEvent.hover(rowFor("Returning task"));
  const card = rowFor("Returning task").element().closest(".visual-task-card");
  const settle = card?.querySelector('button[aria-label="Settle task"]');
  expect(settle).not.toBeNull();
  expect(woke.element().getBoundingClientRect().right).toBeLessThanOrEqual(
    settle!.getBoundingClientRect().left,
  );
  await userEvent.unhover(rowFor("Returning task"));

  await woke.click();
  await expect.element(woke).not.toBeInTheDocument();

  // A second wake clears by opening the task instead: the visit stamps the same seen time.
  await client.connection.api.tasks.snooze({
    id: returning.id,
    snoozedUntil: Date.now() + 800,
  });
  await expect
    .poll(() => activeIds().toSorted())
    .toEqual([returning.id, tasks.find((each) => each.title === "Other task")!.id].toSorted());
  await expect.element(woke).toBeVisible();
  await userEvent.click(rowFor("Returning task"));
  await expect.element(woke).not.toBeInTheDocument();
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
  // The shelf starts collapsed.
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

test("prefix space opens the palette over a terminal and Escape returns the keyboard to it", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Palette terminal");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect.element(palette).toBeVisible();
  await expect.element(palette.getByRole("combobox", { name: "Commands" })).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.element(palette).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("a row menu dialog returns the keyboard to its row", async () => {
  const client = await connectedClient();
  const { tasks } = await projectWithTasks(client, ["Alpha task", "Bravo task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForActiveRows(2);
  const [target] = tasks;
  const focusedRow = () => document.activeElement?.getAttribute("data-task-id") === target!.id;
  const row = rowFor(target!.title);

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename task…" }).click();
  await expect.element(page.getByRole("dialog", { name: /Rename/ })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.poll(focusedRow).toBe(true);

  await row.click({ button: "right" });
  await userEvent.hover(page.getByRole("menuitem", { name: "Snooze" }));
  await page.getByRole("menuitem", { name: /^Custom/ }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.poll(focusedRow).toBe(true);
  await unmount();
});

test("removing the last task keeps the keyboard in the shell", async () => {
  const client = await connectedClient();
  const { tasks } = await projectWithTasks(client, ["Only task"]);
  const { unmount } = await render(<App client={client} />);
  await waitForRows(1);

  await rowFor(tasks[0]!.title).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove task" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  await expect.poll(() => document.activeElement !== document.body).toBe(true);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toContain("New task");
  await unmount();
});

test("a config dialog leaves no return target for a later row dialog", async () => {
  await writeConfig('[keys.bindings]\ntoggle-sidebar = "w"\n');
  try {
    const { client, project } = await appWithProject(newClient());
    const task = await taskWithShell(client, project.id, "Stale target");
    const notice = page.getByRole("button", { name: /config: 1 problem/ });
    await expect.element(notice).toBeVisible();
    await notice.click();
    const config = page.getByRole("dialog", { name: "Config problems" });
    await expect.element(config).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(config).not.toBeInTheDocument();

    await rowFor(task.title).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename task…" }).click();
    await expect.element(page.getByRole("dialog", { name: /Rename/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement?.getAttribute("data-task-id")).toBe(task.id);
  } finally {
    await writeConfig(null);
  }
});

import type { CorralClient } from "@corral/client/corral-client";
import type { Task, TaskSource } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { removeDirectoryIn } from "../../../test/files-client.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { realServerClients } from "../../../test/real-client.ts";
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

async function waitForRows(count: number) {
  await vi.waitFor(() => expect(rows()).toHaveLength(count));
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

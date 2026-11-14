import type { CorralClient } from "@corral/client/corral-client";
import type { Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();

const findDialog = () => page.getByRole("dialog", { name: "Find task" });
const searchInput = () => findDialog().getByRole("combobox", { name: "Tasks" });
const rowFor = (title: string) => page.getByRole("button", { name: new RegExp(title) });
const stateOf = (client: CorralClient, id: string) =>
  client.tasks.getSnapshot().tasks.find((task) => task.id === id)?.state;

async function connectedClient(): Promise<CorralClient> {
  const client = newClient();
  await vi.waitFor(() => expect(client.connection.state.getSnapshot().status).toBe("connected"));
  return client;
}

async function projectWithTasks(client: CorralClient, titles: readonly string[]): Promise<Task[]> {
  const repo = await createGitRepo(`find-${titles.length}-${Date.now()}`);
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
  await vi.waitFor(() =>
    expect(
      client.tasks.getSnapshot().tasks.filter((task) => task.projectId === project.id),
    ).toHaveLength(titles.length),
  );
  return tasks;
}

/** The sidebar's own opener, so the test covers the row and the finder together. */
async function openFinder(): Promise<void> {
  await page.getByRole("button", { name: "Search tasks…" }).click();
  await expect.element(findDialog()).toBeVisible();
}

test("the sidebar search filters the watched tasks, Enter opens the chosen one, and Escape closes", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["Fix login", "Write docs"]);
  const { unmount } = await render(<App client={client} />);
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: /Fix login/ }).elements()).toHaveLength(1),
  );

  await openFinder();
  await expect.element(searchInput()).toHaveFocus();

  // Escape is the finder's only way out besides choosing a row.
  await userEvent.keyboard("{Escape}");
  await expect.element(findDialog()).not.toBeInTheDocument();

  await openFinder();
  await userEvent.keyboard("login");
  await expect.element(findDialog().getByRole("option", { name: /Fix login/ })).toBeVisible();
  await expect
    .element(findDialog().getByRole("option", { name: /Write docs/ }))
    .not.toBeInTheDocument();

  await userEvent.keyboard("{Enter}");
  await expect.element(findDialog()).not.toBeInTheDocument();
  await expect.element(rowFor("Fix login")).toHaveAttribute("aria-current", "true");
  await unmount();
});

test("a scratch task is listed as No project and opens from the same list", async () => {
  const client = await connectedClient();
  const scratch = await client.connection.api.tasks.create({
    projectId: null,
    title: "Scratch task",
    workspace: { type: "scratch" },
  });
  await vi.waitFor(() =>
    expect(client.tasks.getSnapshot().tasks.find((task) => task.id === scratch.id)?.title).toBe(
      "Scratch task",
    ),
  );

  const { unmount } = await render(<App client={client} />);
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: /Scratch task/ }).elements()).toHaveLength(1),
  );

  await openFinder();
  const option = findDialog().getByRole("option", { name: /Scratch task/ });
  await expect.element(option).toMatchTextContent(/No project/);

  await userEvent.keyboard("{Enter}");
  await expect.element(findDialog()).not.toBeInTheDocument();
  await expect.element(rowFor("Scratch task")).toHaveAttribute("aria-current", "true");
  await unmount();
});

test("a settled row opens as it is, and starting work in it is what activates the task", async () => {
  const client = await connectedClient();
  const [settled] = await projectWithTasks(client, ["Old work"]);
  await client.connection.api.tasks.setState({ id: settled!.id, state: "settled" });
  await vi.waitFor(() => expect(stateOf(client, settled!.id)).toBe("settled"));

  const { unmount } = await render(<App client={client} />);
  // The closed shelf lists no settled row until one is current, so wait on its toggle instead.
  await expect.element(page.getByRole("button", { name: "Settled (1)" })).toBeVisible();

  await openFinder();
  await userEvent.keyboard("old work");
  const option = findDialog().getByRole("option", { name: /Old work/ });
  await expect.element(option).toMatchTextContent(/settled/);
  // Opening a settled task is not a second primary action: the finder offers no Continue control.
  expect(findDialog().element().textContent).not.toContain("Continue");

  await userEvent.keyboard("{Enter}");
  await expect.element(findDialog()).not.toBeInTheDocument();
  await expect.element(rowFor("Old work")).toHaveAttribute("aria-current", "true");
  expect(stateOf(client, settled!.id)).toBe("settled");

  // New work is what un-shelves it (#277); a shell session is the cheapest real start.
  await prefixThen("c");
  await vi.waitFor(() => expect(stateOf(client, settled!.id)).toBe("active"));
  await unmount();
});

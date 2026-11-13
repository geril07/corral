import type { CorralClient } from "@corral/client/corral-client";
import type { Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { createGitRepo } from "../../../test/git-repo.ts";
import { realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();

const findDialog = () => page.getByRole("dialog", { name: "Find task" });
const searchInput = () => findDialog().getByRole("combobox", { name: "Tasks" });
const rowFor = (title: string) => page.getByRole("button", { name: new RegExp(title) });

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

test("the sidebar search filters the watched tasks and Enter opens the chosen one", async () => {
  const client = await connectedClient();
  await projectWithTasks(client, ["Fix login", "Write docs"]);
  const { unmount } = await render(<App client={client} />);
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: /Fix login/ }).elements()).toHaveLength(1),
  );

  await page.getByRole("button", { name: "Search tasks…" }).click();
  await expect.element(findDialog()).toBeVisible();
  await expect.element(searchInput()).toHaveFocus();

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

test("a settled result continues through the same reactivation as un-settling", async () => {
  const client = await connectedClient();
  const [active, settled] = await projectWithTasks(client, ["Active work", "Old work"]);
  await client.connection.api.tasks.setState({ id: settled!.id, state: "settled" });
  await vi.waitFor(() =>
    expect(client.tasks.getSnapshot().tasks.find((task) => task.id === settled!.id)?.state).toBe(
      "settled",
    ),
  );

  const { unmount } = await render(<App client={client} />);
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: /Active work/ }).elements()).toHaveLength(1),
  );

  await page.getByRole("button", { name: "Search tasks…" }).click();
  await userEvent.keyboard("old work");
  await findDialog().getByRole("button", { name: "Continue settled task" }).click();

  await expect.element(findDialog()).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(client.tasks.getSnapshot().tasks.find((task) => task.id === settled!.id)?.state).toBe(
      "active",
    ),
  );
  await expect.element(rowFor("Old work")).toHaveAttribute("aria-current", "true");
  expect(active!.id).not.toBe(settled!.id);
  await unmount();
});

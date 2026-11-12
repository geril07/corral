import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { prefixShifted, realServerClients } from "../../../test/real-client.ts";
import { addProjectDialog, appWithProject as openProject } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const appWithProject = (branches: string[] = []) => openProject(newClient(), branches);

test("shift+p adds a project and the dialog closes", async () => {
  const { client, repo } = await appWithProject();

  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(client.projects.getSnapshot().projects.some((project) => project.path === repo)).toBe(
    true,
  );
});

test("a path outside any repository, or a repository added twice, is explained in the dialog", async () => {
  const { repo } = await appWithProject();

  await prefixShifted("p");
  const pathField = addProjectDialog().getByRole("combobox");
  await expect.element(pathField).toHaveFocus();
  await userEvent.fill(pathField, "/");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("/ is not inside a git repository.")).toBeVisible();

  await userEvent.fill(addProjectDialog().getByRole("combobox"), repo);
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("This repository is already added.")).toBeVisible();
  await expect.element(addProjectDialog()).toBeVisible();
});

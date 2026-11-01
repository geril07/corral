import type { CorralClient } from "@corral/client/corral-client";
import { expect, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createGitRepo } from "./git-repo.ts";
import { prefixShifted, prefixThen } from "./real-client.ts";
import { renderApp } from "./render-app.tsx";

export const workspace = () => page.getByRole("navigation", { name: "workspace" });
export const taskButton = (title: string) =>
  workspace().getByRole("button", { name: new RegExp(`^${title}`) });
export const shellButtons = () => workspace().getByRole("button", { name: /^shell/ });
export const focusedIsTerminal = () =>
  document.activeElement?.classList.contains("xterm-helper-textarea");

export const addProjectDialog = () => page.getByRole("dialog", { name: "Add project" });
export const newTaskDialog = () => page.getByRole("dialog", { name: "New task" });
export const issueUrlField = () => newTaskDialog().getByRole("textbox", { name: "Issue URL" });
export const importIssueButton = () =>
  newTaskDialog().getByRole("button", { name: "Import issue" });
export const taskActionsButton = (title: string) =>
  workspace().getByRole("button", { name: `Task actions for ${title}` });
export const viewIssueSourceAction = () =>
  page.getByRole("menuitem", { name: "View issue source…" });
export const taskSourceDialog = () => page.getByRole("dialog", { name: "Issue source" });
export async function openTaskSource(title: string) {
  await taskActionsButton(title).click();
  await viewIssueSourceAction().click();
}

/** An app on the real server with one project added through the dialog. */
export async function appWithProject(client: CorralClient, branches: string[] = []) {
  const repo = await createGitRepo("repo", branches);
  const rendered = await renderApp(client);
  await prefixShifted("p");
  await expect.element(addProjectDialog().getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard(`${repo}{Enter}`);
  await expect.element(addProjectDialog()).not.toBeInTheDocument();
  // Adding a project selects it, and the route names the selection: waiting for that project id
  // keeps the helper honest when a test already has another project.
  const project = await vi.waitFor(() => {
    const found = client.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() =>
    expect(rendered.history.location.search).toContain(`project=${project.id}`),
  );
  return { client, repo, rendered };
}

/**
 * Creates a task from the keyboard with a new branch and waits for its shell. `shellCount` is
 * how many shell sessions the current task shows afterwards.
 */
export async function createTask(title: string, shellCount = 1) {
  await prefixThen("t");
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
  await userEvent.keyboard(`${title}{Enter}`);
  await expect.element(newTaskDialog()).not.toBeInTheDocument();
  await expect.element(taskButton(title)).toHaveAttribute("aria-current", "true");
  await expect.element(shellButtons()).toHaveLength(shellCount);
}

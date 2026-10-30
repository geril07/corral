import type { CorralClient } from "@corral/client/corral-client";
import { expect } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { App } from "./render-app.tsx";
import { createGitRepo } from "./git-repo.ts";
import { prefixShifted, prefixThen } from "./real-client.ts";

export const workspace = () => page.getByRole("navigation", { name: "workspace" });
export const taskButton = (title: string) =>
  workspace().getByRole("button", { name: new RegExp(`^${title}`) });
export const shellButtons = () => workspace().getByRole("button", { name: /^shell/ });
export const focusedIsTerminal = () =>
  document.activeElement?.classList.contains("xterm-helper-textarea");

export const addProjectDialog = () => page.getByRole("dialog", { name: "Add project" });
export const newTaskDialog = () => page.getByRole("dialog", { name: "New task" });

/** An app on the real server with one project added through the dialog. */
export async function appWithProject(client: CorralClient, branches: string[] = []) {
  const repo = await createGitRepo("repo", branches);
  await render(<App client={client} />);
  await prefixShifted("p");
  await expect.element(addProjectDialog().getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard(`${repo}{Enter}`);
  await expect.element(addProjectDialog()).not.toBeInTheDocument();
  await expect.element(workspace().getByRole("button", { name: /^repo-/ })).toBeVisible();
  return { client, repo };
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

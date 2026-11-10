import { ORPCError } from "@orpc/client";
import type { CorralClient } from "@corral/client/corral-client";
import { expect, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createGitRepo } from "./git-repo.ts";
import { prefixShifted, prefixThen } from "./real-client.ts";
import { renderApp } from "./render-app.tsx";

export const workspace = () => page.getByRole("navigation", { name: "workspace" });
export const taskButton = (title: string) =>
  workspace().getByRole("button", { name: new RegExp(`^${title}`) });
/** The current task's session tabs (`layout.md`, **Session tabs**). */
export const sessionTabs = () => page.getByRole("tablist", { name: "Sessions" });
export const sessionTab = (name: string | RegExp) => sessionTabs().getByRole("tab", { name });
export const selectedTab = () => sessionTabs().getByRole("tab", { selected: true });
export const shellTabs = () => sessionTabs().getByRole("tab", { name: /^shell/ });
/** The 40 px task header above the tabs. */
export const taskHeader = () => page.getByRole("group", { name: "task header" });
export const focusedIsTerminal = () =>
  document.activeElement?.classList.contains("xterm-helper-textarea");

export const addProjectDialog = () => page.getByRole("dialog", { name: "Add project" });
/** The new-task composer in the main area (`layout.md`, **New task view**): a view, not a dialog. */
export const newTaskView = () => page.getByRole("form", { name: "New task" });
export const promptField = () => newTaskView().getByRole("textbox", { name: "Prompt" });
export const expandTitleButton = () =>
  newTaskView().getByRole("button", { name: "Title (optional)", exact: true });
export const titleField = () => newTaskView().getByRole("textbox", { name: "Title (optional)" });
export async function openIssueImport() {
  await newTaskView().getByRole("button", { name: "Task setup actions" }).click();
  await page.getByRole("menuitem", { name: "From issue…" }).click();
}
export const issueUrlField = () => newTaskView().getByRole("textbox", { name: "Issue URL" });
export const importIssueButton = () => newTaskView().getByRole("button", { name: "Import issue" });
export const createTaskButton = () =>
  newTaskView().getByRole("button", { name: /^(?:Create task|Creating…)$/ });
export const taskMenuTarget = taskButton;
export const viewIssueSourceAction = () =>
  page.getByRole("menuitem", { name: "View issue source…" });
export const taskSourceDialog = () => page.getByRole("dialog", { name: "Issue source" });
export async function openTaskSource(title: string) {
  await taskMenuTarget(title).click({ button: "right" });
  await viewIssueSourceAction().click();
}

/** TUI scenarios choose terminal explicitly; the everyday default is chat. */
export async function openAgentSessionPicker(view: "chat" | "terminal") {
  await prefixThen("s");
  const picker = page.getByRole("dialog", { name: "New agent session" });
  await expect.element(picker).toBeVisible();
  await picker.getByRole("button", { name: `Open in ${view}` }).click();
  await picker.getByRole("radio", { checked: true }).click();
  return picker;
}

/** An app on the real server with one project added through the dialog. */
export async function appWithProject(client: CorralClient, branches: string[] = []) {
  const repo = await createGitRepo("repo", branches);
  const rendered = await renderApp(client);
  await prefixShifted("p");
  await expect.element(addProjectDialog().getByRole("combobox")).toHaveFocus();
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
 * A client whose task rename waits on the test's gate, with every other call left to the real
 * server. `save` performs the real write on release; `refuse` rejects with the server's error.
 */
export function clientWithHeldTaskRename(real: CorralClient, outcome: "save" | "refuse" = "save") {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = real.connection.api.tasks.rename.bind(real.connection.api.tasks);
  const rename = vi.fn<(input: { id: string; title: string }) => Promise<unknown>>(
    async (input) => {
      await gate;
      if (outcome === "refuse")
        throw new ORPCError("TASK_NOT_FOUND", { defined: true, data: { id: input.id } });
      return write(input);
    },
  );
  const api = new Proxy(real.connection.api, {
    get(target, property, receiver) {
      if (property !== "tasks") return Reflect.get(target, property, receiver);
      const tasks = Reflect.get(target, property, receiver) as object;
      return new Proxy(tasks, {
        get(taskTarget, taskProperty, taskReceiver) {
          if (taskProperty === "rename") return rename;
          return Reflect.get(taskTarget, taskProperty, taskReceiver);
        },
      });
    },
  });
  const connection = { ...real.connection, api } as CorralClient["connection"];
  return { client: { ...real, connection }, rename, release: () => release() };
}

export interface CreateTaskOptions {
  /** Where the task works; absent keeps the configured default (the project's main tree). */
  workspace?: "new-worktree" | "main-worktree";
}

/**
 * Creates a task from the composer's optional title, with no prompt, so it starts no session
 * (`design.md`, **Domain model → Task → Creation**); a prompt-created task starts its agent.
 */
export async function createTask(title: string, options: CreateTaskOptions = {}) {
  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  if (options.workspace === "new-worktree") {
    await newTaskView()
      .getByRole("combobox", { name: /^Workspace / })
      .click();
    await userEvent.keyboard("new worktree{Enter}");
  }
  await expandTitleButton().click();
  await userEvent.keyboard(title);
  await userEvent.keyboard("{Enter}");
  await expect.element(newTaskView()).not.toBeInTheDocument();
  await expect.element(taskButton(title)).toHaveAttribute("aria-current", "true");
}

/**
 * The same, then a terminal to type in. `shellCount` is how many shell tabs the current task
 * shows afterwards.
 */
export async function createTaskWithShell(
  title: string,
  shellCount = 1,
  options: CreateTaskOptions = {},
) {
  await createTask(title, options);
  await startShell(shellCount);
}

/** Adds a shell session to the current task with prefix c. */
export async function startShell(shellCount = 1) {
  await prefixThen("c");
  await expect.element(shellTabs()).toHaveLength(shellCount);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
}

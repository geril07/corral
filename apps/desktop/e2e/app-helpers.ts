import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function openedWindow(app: ElectronApplication) {
  const window = await app.firstWindow();
  await window.waitForURL(/[?&]server=/);
  return window;
}

// The test hook of apps/web/src/screen-text-hook.ts: the WebGL renderer leaves no text in the DOM.
export const screenText = (page: Page) =>
  page.evaluate<string>("window.corralScreenText?.() ?? ''");

/**
 * The visible text without the line breaks a terminal inserts when a line wraps. The first fit can
 * be narrow before the pane is laid out, so an echo of a known line may arrive wrapped; the text
 * itself is what a test asserts.
 */
export const unwrappedScreenText = (page: Page) =>
  screenText(page).then((text) => text.replaceAll("\n", ""));
export const workspace = (page: Page) => page.getByRole("navigation", { name: "workspace" });
/** The current task's session tabs (`layout.md`, **Session tabs**). */
export const sessionTabs = (page: Page) => page.getByRole("tablist", { name: "Sessions" });
export const sessionTab = (page: Page, name: string) =>
  sessionTabs(page).getByRole("tab", { name, exact: true });

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/** A repository on `main` with one commit under the test's state directory. */
export function createRepo(stateDir: string): string {
  const repo = path.join(stateDir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial commit");
  return repo;
}

/**
 * The project the workspace route has selected, read from the hash search. Hash history appends
 * the document query (`?server=…`) to it, so the value stops at the next `?`.
 */
function selectedProject(window: Page): string | undefined {
  const hash = new URL(window.url()).hash;
  const search = hash.slice(hash.indexOf("?") + 1);
  return new URLSearchParams(search).get("project")?.split("?")[0] ?? undefined;
}

/** Adds `repo` as a project from the keyboard and waits until the new project is current. */
export async function addProject(window: Page, repo: string) {
  const before = selectedProject(window);
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Shift+KeyP");
  await expect(
    window.getByRole("dialog", { name: "Add project" }).getByRole("textbox"),
  ).toBeFocused();
  await window.keyboard.type(repo);
  await window.keyboard.press("Enter");
  // Adding a project selects it: the route names a different project than it did before, which a
  // second project would not satisfy by leaving the previous one selected.
  await expect.poll(() => selectedProject(window)).not.toBe(before);
  expect(selectedProject(window)).toEqual(expect.any(String));
}

/** The new-task composer in the main area (`layout.md`, **New task view**): a view, not a dialog. */
export const newTaskView = (window: Page) => window.getByRole("form", { name: "New task" });
export const promptField = (window: Page) =>
  newTaskView(window).getByRole("textbox", { name: "Prompt" });

export interface CreateTaskOptions {
  /** Where the task works; absent keeps the configured default (the project's main tree). */
  workspace?: "new-worktree" | "main-worktree";
}

/**
 * Creates a task from the composer's optional title, with no prompt, so it starts no session
 * (design.md, **Domain model → Task → Creation**); a prompt-created task starts its agent.
 */
export async function createTask(window: Page, title: string, options: CreateTaskOptions = {}) {
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  await expect(promptField(window)).toBeFocused();
  if (options.workspace === "new-worktree") {
    await newTaskView(window)
      .getByRole("combobox", { name: /^Workspace / })
      .click();
    await window.keyboard.type("new worktree");
    await window.keyboard.press("Enter");
  }
  await newTaskView(window).getByRole("button", { name: "Title (optional)" }).click();
  await window.keyboard.type(title);
  await window.keyboard.press("Enter");
  await expect(
    workspace(window).getByRole("button", { name: new RegExp(`^${title}`) }),
  ).toHaveAttribute("aria-current", "true");
}

/** Adds a shell session to the current task with the new-terminal binding. */
export async function startShell(window: Page, shellCount = 1) {
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  await expect(sessionTab(window, "shell")).toHaveCount(shellCount);
}

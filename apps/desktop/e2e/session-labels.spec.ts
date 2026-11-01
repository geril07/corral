import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  createRepo,
  createTask,
  openedWindow,
  screenText,
  sessionTab,
  startShell,
  unwrappedScreenText,
  workspace,
} from "./app-helpers.ts";
import { isAlive, readEndpoint, readLaunches, test } from "./fixtures.ts";

/** Built evidence stays out of the commit; `.e2e/` is scratch. */
const EVIDENCE = path.join(import.meta.dirname, "../../../.e2e/session-labels");

/** A Scratch row: a loose terminal lives in the sidebar. */
const scratch = (window: Page, name: string) =>
  workspace(window).getByRole("button", { name, exact: true });
/** A session tab of the current task. */
const tab = (window: Page, name: string) => sessionTab(window, name);

async function renameCurrent(window: Page, from: string, to: string) {
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Shift+KeyR");
  const dialog = window.getByRole("dialog", { name: `Rename ${from}` });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  await window.keyboard.type(to);
  await window.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
}

test("a renamed task session keeps its name, its process and its conversation across a server restart", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const first = await launchApp();
  const window = await openedWindow(first);
  // The window takes keys only once the workspace has loaded (as every other spec waits).
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Labels");
  await startShell(window);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyS");
  await expect(window.getByRole("radio", { name: "claude" })).toBeFocused();
  await window.keyboard.press("Digit1");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("first-prompt");
  await window.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(window)).toContain("fake claude got: first-prompt");
  const started = readLaunches(stateDir).find((launch) => launch.agent === "claude");

  // Renaming changes the name only: the same process, still on the same conversation.
  await renameCurrent(window, "claude", "reviewer");
  await expect(tab(window, "reviewer")).toHaveAttribute("aria-selected", "true");
  await expect(tab(window, "shell")).toBeVisible();
  expect(readLaunches(stateDir).filter((launch) => launch.agent === "claude")).toHaveLength(1);
  await expect.poll(() => unwrappedScreenText(window)).toContain("fake claude got: first-prompt");

  mkdirSync(EVIDENCE, { recursive: true });
  await window.screenshot({ path: path.join(EVIDENCE, "task-session-rename.png") });

  // Quit the app and kill the server: the session is resumed by id under the same name.
  const serverPid = readEndpoint(stateDir)?.pid ?? 0;
  await first.close();
  process.kill(serverPid, "SIGKILL");
  await expect.poll(() => isAlive(serverPid)).toBe(false);

  const second = await launchApp();
  const again = await openedWindow(second);
  await expect(tab(again, "reviewer")).toBeVisible();
  // A fresh window has no selection in its URL; choosing the session shows what was resumed.
  await tab(again, "reviewer").click();
  await expect.poll(() => screenText(again)).toContain("fake claude ready");
  const launches = readLaunches(stateDir).filter((launch) => launch.agent === "claude");
  expect(launches).toHaveLength(2);
  expect(launches[1]!.argv).toEqual(["--resume", started?.argv[1]]);
});

test("a renamed loose terminal keeps its name when the app is opened again; only a server restart ends it", async ({
  launchApp,
  stateDir,
}) => {
  const first = await launchApp();
  const window = await openedWindow(first);
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  const natural = workspace(window).getByRole("button", { name: /^sh · / });
  await expect(natural).toHaveCount(1);

  await renameCurrent(window, (await natural.textContent()) ?? "", "logs");
  await expect(scratch(window, "logs")).toBeVisible();

  // Close the app: the server and the terminal live on, and so does the name.
  const serverPid = readEndpoint(stateDir)?.pid ?? 0;
  await first.close();
  expect(isAlive(serverPid)).toBe(true);
  const second = await launchApp();
  const again = await openedWindow(second);
  expect(readEndpoint(stateDir)?.pid).toBe(serverPid);
  await expect(scratch(again, "logs")).toBeVisible();
  await again.keyboard.type("echo still-$((6*7))");
  await again.keyboard.press("Enter");
  await expect.poll(() => screenText(again)).toContain("still-42");
  await again.screenshot({ path: path.join(EVIDENCE, "loose-terminal-rename.png") });

  // Terminals do not survive the server (decision 12), so the name goes with the terminal.
  await second.close();
  process.kill(serverPid, "SIGKILL");
  await expect.poll(() => isAlive(serverPid)).toBe(false);
  const third = await launchApp();
  const afterRestart = await openedWindow(third);
  await expect(afterRestart.getByText("Add a repository to start")).toBeVisible();
  await expect(scratch(afterRestart, "logs")).toHaveCount(0);
});

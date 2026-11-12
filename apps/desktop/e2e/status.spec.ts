import { expect, type Page } from "@playwright/test";
import {
  addProject,
  createRepo,
  createTask,
  openedWindow,
  screenText,
  sessionTab,
  taskCard,
  writeConfig,
} from "./app-helpers.ts";
import { test } from "./fixtures.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const cardStatus = (window: Page, title: string) =>
  window
    .locator(".visual-task-card")
    .filter({ has: taskCard(window, title) })
    .locator(".visual-task-status");

// An agent that reports itself blocked makes its task card and session show it; the card's
// primary-session slot is the one status surface the routed shell mounts.
test("a blocked agent shows on its task card and session, and done updates both", async ({
  launchApp,
  stateDir,
}) => {
  writeConfig(stateDir, '[tasks]\nview = "terminal"\n');
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await addProject(window, repo);
  await createTask(window, "Alpha");
  const claude = sessionTab(window, /^claude/);
  await expect(claude).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");

  await window.keyboard.type(`osc state=blocked:kind=permission:msg=${b64("Run rm -rf build?")}`);
  await window.keyboard.press("Enter");

  await expect(cardStatus(window, "Alpha")).toContainText("Blocked");

  await createTask(window, "Beta");

  await taskCard(window, "Alpha").click();
  await expect(taskCard(window, "Alpha")).toHaveAttribute("aria-current", "true");
  await expect(claude).toHaveAttribute("aria-selected", "true");
  // Selecting a card leaves the keyboard on it; the report is typed into the terminal.
  await window.locator(".terminal-host .xterm-helper-textarea").click();
  await window.keyboard.type(`osc state=done:msg=${b64("All green")}`);
  await window.keyboard.press("Enter");

  await expect(cardStatus(window, "Alpha")).toContainText("Done");
});

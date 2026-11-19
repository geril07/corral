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
import { readLaunches, test } from "./fixtures.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const cardStatus = (window: Page, title: string) =>
  window
    .locator(".visual-task-card")
    .filter({ has: taskCard(window, title) })
    .locator(".visual-task-status");

/**
 * Reports a status on a launch's own HTTP channel, as an agent plugin does. The card's unseen
 * `Done` is the one a background agent produces: the task is not on screen, so no terminal of it
 * can be typed into.
 */
async function reportStatus(
  stateDir: string,
  report: { state: "done"; message: string },
): Promise<void> {
  const launch = readLaunches(stateDir).find((entry) => entry.agent === "claude");
  const url = launch?.env.CORRAL_STATUS_URL;
  const token = launch?.env.CORRAL_STATUS_TOKEN;
  if (url === undefined || token === undefined) throw new Error("the launch has no status channel");

  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  expect(response.status).toBe(204);
}

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
  await expect(sessionTab(window, /^claude blocked/)).toBeVisible();

  // Beta takes the screen. Alpha's agent keeps running, as a background agent does, and reports
  // through its own channel: there is no Alpha terminal on screen to type into.
  await createTask(window, "Beta");
  await expect(sessionTab(window, /^claude/)).toHaveAttribute("aria-selected", "true");
  await reportStatus(stateDir, { state: "done", message: "All green" });

  // Alpha is not the task being looked at, so its completion is unseen and the card names it.
  await expect(cardStatus(window, "Alpha")).toContainText("Done");

  // Opening Alpha is the look that marks it seen: the card mutes the completion, while the
  // session keeps the done state it reported.
  await taskCard(window, "Alpha").click();
  await expect(taskCard(window, "Alpha")).toHaveAttribute("aria-current", "true");
  await expect(sessionTab(window, /^claude done/)).toBeVisible();
  await expect(cardStatus(window, "Alpha")).not.toContainText("Done");
  await expect(cardStatus(window, "Alpha")).toHaveAttribute("data-muted", "true");
});

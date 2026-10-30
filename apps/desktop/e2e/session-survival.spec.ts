import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { isAlive, readEndpoint, test } from "./fixtures.ts";

async function openedWindow(app: ElectronApplication) {
  const window = await app.firstWindow();
  await window.waitForURL(/[?&]server=/);
  return window;
}

// The test hook of apps/web/src/screen-text-hook.ts: the WebGL renderer leaves no text in the DOM.
const screenText = (page: Page) => page.evaluate<string>("window.corralScreenText?.() ?? ''");
const listItems = (page: Page) =>
  page.getByRole("navigation", { name: "terminals" }).getByRole("listitem");

// MVP step 1: the sessions belong to the server, not to the window.
test("a terminal and its screen are still there after closing the app and opening it again", async ({
  launchApp,
  stateDir,
}) => {
  const marker = `hello-${randomBytes(4).toString("hex")}`;
  const first = await launchApp();
  const firstWindow = await openedWindow(first);
  await expect(firstWindow.getByText("No terminals")).toBeVisible();
  await firstWindow.keyboard.press("Alt+KeyA");
  await firstWindow.keyboard.press("KeyC");
  await expect(listItems(firstWindow)).toHaveCount(1);

  // The arithmetic makes the marker line appear only as output, never in the echoed command.
  await firstWindow.keyboard.type(`echo ${marker}-$((6*7))`);
  await firstWindow.keyboard.press("Enter");
  await expect.poll(() => screenText(firstWindow)).toContain(`${marker}-42`);

  const pid = readEndpoint(stateDir)?.pid ?? 0;
  await first.close();
  expect(isAlive(pid)).toBe(true);

  const second = await launchApp();
  const secondWindow = await openedWindow(second);
  expect(readEndpoint(stateDir)?.pid).toBe(pid);
  await expect(listItems(secondWindow)).toHaveCount(1);
  await expect.poll(() => screenText(secondWindow)).toContain(`${marker}-42`);

  // It is the same live shell, not a copy of its screen.
  await secondWindow.keyboard.type(`echo again-${marker}-$((7*7))`);
  await secondWindow.keyboard.press("Enter");
  await expect.poll(() => screenText(secondWindow)).toContain(`again-${marker}-49`);
});

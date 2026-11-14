import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  createRepo,
  openedWindow,
  promptField,
  screenText,
  unwrappedScreenText,
} from "./app-helpers.ts";
import { isAlive, readLaunches, test } from "./fixtures.ts";

// Settling only shelves a task: what runs in it keeps running, and un-settling starts nothing.
test("settling a task shelves it while its agent keeps working, and unsettling starts nothing", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  mkdirSync(path.join(stateDir, "config"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "config", "config.toml"),
    '[tasks]\nagent = "claude"\nview = "terminal"\n',
  );
  const window = await openedWindow(await launchApp());
  await addProject(window, repo);
  await window.getByRole("button", { name: "New task", exact: true }).click();
  await promptField(window).fill("Finished");
  await promptField(window).press("Enter");
  const tabs = window.getByRole("tablist", { name: "Sessions" });
  const claudeTab = () => tabs.getByRole("tab", { name: /^claude/ });
  const shellTab = () => tabs.getByRole("tab", { name: /^shell/ });
  await expect(claudeTab()).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("first-prompt");
  await window.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(window)).toContain("fake claude got: first-prompt");
  const claudeLaunches = () => readLaunches(stateDir).filter((launch) => launch.agent === "claude");
  const [started] = claudeLaunches();
  const claudeId = started?.argv[1];
  expect(started?.argv[0]).toBe("--session-id");
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  await expect(shellTab()).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyD");

  // The shelf starts collapsed; it still shows the current task's row alone, and the toggle is
  // never disabled while the row it would hide is selected.
  const shelf = window.getByRole("button", { name: "Settled (1)" });
  await expect(shelf).toBeVisible();
  await expect(shelf).toHaveAttribute("aria-expanded", "false");
  await expect(shelf).toBeEnabled();
  const settledRow = window.getByRole("button", { name: /Finished/ });
  await expect(settledRow).toHaveAttribute("aria-current", "true");
  await expect(settledRow).toBeVisible();
  // Settle is metadata: both sessions keep running, so their tabs carry no state word.
  await expect(tabs.getByRole("tab", { name: "claude", exact: true })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "shell", exact: true })).toBeVisible();
  expect(isAlive(started!.pid)).toBe(true);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyD");

  await expect(window.getByRole("button", { name: "Settled (1)" })).toBeHidden();
  await expect(claudeTab()).toBeVisible();
  await expect(shellTab()).toBeVisible();
  // Un-settling starts nothing: the agent process was never stopped, so it is still the first launch.
  await expect
    .poll(() => claudeLaunches().map((launch) => launch.argv))
    .toEqual([["--session-id", claudeId, " Finished"]]);
  expect(isAlive(started!.pid)).toBe(true);
  await claudeTab().click();
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("after-unsettle");
  await window.keyboard.press("Enter");
  await expect.poll(() => screenText(window)).toContain("fake claude got: after-unsettle");
});

import { expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  createRepo,
  openedWindow,
  promptField,
  unwrappedScreenText,
} from "./app-helpers.ts";
import { isAlive, readEndpoint, test } from "./fixtures.ts";

// MVP step 1: the sessions belong to the server, not to the window.
test("a terminal and its screen are still there after closing the app and opening it again", async ({
  launchApp,
  stateDir,
}) => {
  const marker = `hello-${randomBytes(4).toString("hex")}`;
  const repo = createRepo(stateDir);
  mkdirSync(path.join(stateDir, "config"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "config", "config.toml"),
    '[tasks]\nagent = "pi"\nview = "terminal"\n',
  );
  const first = await launchApp();
  const firstWindow = await openedWindow(first);
  await addProject(firstWindow, repo);
  await firstWindow.getByRole("button", { name: "New task", exact: true }).click();
  await promptField(firstWindow).fill("Terminal survival");
  await promptField(firstWindow).press("Enter");
  await expect(firstWindow.getByRole("tab", { name: /^pi/ })).toBeVisible();
  await firstWindow.keyboard.press("Alt+KeyA");
  await firstWindow.keyboard.press("KeyC");
  await expect(firstWindow.getByRole("tab", { name: /^shell/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // The arithmetic makes the marker line appear only as output, never in the echoed command.
  await firstWindow.keyboard.type(`echo ${marker}-$((6*7))`);
  await firstWindow.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(firstWindow)).toContain(`${marker}-42`);

  const pid = readEndpoint(stateDir)?.pid ?? 0;
  await first.close();
  expect(isAlive(pid)).toBe(true);

  const second = await launchApp();
  const secondWindow = await openedWindow(second);
  expect(readEndpoint(stateDir)?.pid).toBe(pid);
  await secondWindow.getByRole("button", { name: /Terminal survival/ }).click();
  await expect(secondWindow.getByRole("tab", { name: /^shell/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => unwrappedScreenText(secondWindow)).toContain(`${marker}-42`);

  // It is the same live shell, not a copy of its screen.
  await secondWindow.locator(".xterm").click();
  await secondWindow.keyboard.type(`echo again-${marker}-$((7*7))`);
  await secondWindow.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(secondWindow)).toContain(`again-${marker}-49`);
});

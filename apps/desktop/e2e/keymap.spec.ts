import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addProject, createRepo, openedWindow, promptField, sessionTabs } from "./app-helpers.ts";
import { test } from "./fixtures.ts";

const shellTabs = (window: Awaited<ReturnType<typeof openedWindow>>) =>
  sessionTabs(window).getByRole("tab", { name: /^shell/ });

function writeConfig(stateDir: string, text: string) {
  const directory = path.join(stateDir, "config");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "config.toml"), text);
}

test("a config file rebinds an action before launch, and the old key does nothing", async ({
  launchApp,
  stateDir,
}) => {
  writeConfig(
    stateDir,
    '[tasks]\nagent = "pi"\nview = "terminal"\n[keys.bindings]\nnew-terminal = "z"\n',
  );
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await addProject(window, repo);
  await window.getByRole("button", { name: "New task", exact: true }).click();
  await promptField(window).fill("Keymap task");
  await promptField(window).press("Enter");
  await expect(sessionTabs(window).getByRole("tab", { name: /^pi/ })).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyZ");
  await expect(shellTabs(window)).toHaveCount(1);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  await expect(shellTabs(window)).toHaveCount(1);
});

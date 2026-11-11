import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openedWindow, workspace } from "./app-helpers.ts";
import { test } from "./fixtures.ts";

const terminalButtons = (window: Awaited<ReturnType<typeof openedWindow>>) =>
  workspace(window).getByRole("button", { name: /^sh · / });

function writeConfig(stateDir: string, text: string) {
  const directory = path.join(stateDir, "config");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "config.toml"), text);
}

test("a config file rebinds an action before launch, and the old key does nothing", async ({
  launchApp,
  stateDir,
}) => {
  writeConfig(stateDir, '[keys.bindings]\nnew-terminal = "z"\n');
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyZ");
  await expect(terminalButtons(window)).toHaveCount(1);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  await expect(terminalButtons(window)).toHaveCount(1);
});

test("the command palette opens from its key and runs the filtered action", async ({
  launchApp,
}) => {
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Space");
  const palette = window.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox", { name: "Commands" })).toBeFocused();

  await window.keyboard.type("new terminal");
  await expect(palette.getByRole("option", { name: /New terminal/ })).toBeVisible();
  await window.keyboard.press("Enter");

  await expect(palette).toBeHidden();
  await expect(terminalButtons(window)).toHaveCount(1);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Space");
  await expect(palette).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

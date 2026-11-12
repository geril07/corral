import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  createRepo,
  openedWindow,
  promptField,
  screenText,
  sessionTab,
  unwrappedScreenText,
} from "./app-helpers.ts";
import { isAlive, readEndpoint, readLaunches, test } from "./fixtures.ts";

/** Built evidence stays out of the commit; `.e2e/` is scratch. */
const EVIDENCE = path.join(import.meta.dirname, "../../../.e2e/session-labels");

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
  mkdirSync(path.join(stateDir, "config"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "config", "config.toml"),
    '[tasks]\nagent = "claude"\nview = "terminal"\n',
  );
  const first = await launchApp();
  const window = await openedWindow(first);
  await addProject(window, repo);
  await window.getByRole("button", { name: "New task", exact: true }).click();
  await promptField(window).fill("Labels");
  await promptField(window).press("Enter");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("first-prompt");
  await window.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(window)).toContain("fake claude got: first-prompt");
  const started = readLaunches(stateDir).find((launch) => launch.agent === "claude");
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  await expect(tab(window, "shell")).toBeVisible();
  await tab(window, "claude").click();

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

import { expect } from "@playwright/test";
import {
  addProject,
  createRepo,
  createTask,
  openedWindow,
  screenText,
  sessionTab,
  startShell,
  writeConfig,
} from "./app-helpers.ts";
import { test } from "./fixtures.ts";

/**
 * The app installs no application menu, so copy and paste here are Chromium's own editing
 * commands: the terminal has to leave Control+C and Control+V to the browser for the clipboard
 * to reach the shell and the selection to leave it.
 */
test("Control+V pastes into the shell and Control+C copies the selection", async ({
  launchApp,
  stateDir,
}) => {
  writeConfig(stateDir, '[tasks]\nview = "terminal"\n');
  const repo = createRepo(stateDir);
  const app = await launchApp();
  const window = await openedWindow(app);
  await addProject(window, repo);
  await createTask(window, "Clipboard");
  await startShell(window);
  await sessionTab(window, "shell").click();
  const input = window.locator(".terminal-host .xterm-helper-textarea");
  await input.click();
  await expect(input).toBeFocused();

  // Paste: the shell echoes the line it was given, and runs it once Enter arrives.
  await app.evaluate(({ clipboard }) => clipboard.writeText("echo pasted-into-the-terminal"));
  await window.keyboard.press("Control+V");
  await expect.poll(() => screenText(window)).toContain("echo pasted-into-the-terminal");
  await window.keyboard.press("Enter");
  await expect.poll(() => screenText(window)).toContain("pasted-into-the-terminal");

  // Copy: a drag over the screen selects both lines, and Control+C answers with them.
  const screen = window.locator(".terminal-host .xterm-screen");
  const box = await screen.boundingBox();
  if (!box) throw new Error("the terminal has no screen");
  await window.mouse.move(box.x + 1, box.y + 1);
  await window.mouse.down();
  await window.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
  await window.mouse.up();
  await window.keyboard.press("Control+C");
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain("pasted-into-the-terminal");
});

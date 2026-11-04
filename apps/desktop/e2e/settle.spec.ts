import { expect } from "@playwright/test";
import {
  openAgentSessionPicker,
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
import { isAlive, readLaunches, test } from "./fixtures.ts";

// Settling a task stops what runs in it; making it active again brings back what was running.
test("settling a task stops its agent and unsettling resumes the conversation", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Finished");
  await startShell(window);
  const sidebar = workspace(window);

  await openAgentSessionPicker(window, "terminal");
  const picker = window.getByRole("dialog", { name: "New agent session" });
  await expect(picker.getByRole("radio", { name: "claude" })).toBeFocused();
  await window.keyboard.press("Digit1");
  await expect(sessionTab(window, "claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("first-prompt");
  await window.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(window)).toContain("fake claude got: first-prompt");
  const claudeLaunches = () => readLaunches(stateDir).filter((launch) => launch.agent === "claude");
  const [started] = claudeLaunches();
  const claudeId = started?.argv[1];
  expect(started?.argv[0]).toBe("--session-id");

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyD");

  await expect(sidebar.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await expect(sessionTab(window, "claude stopped")).toBeVisible();
  await expect(sessionTab(window, "shell stopped")).toBeVisible();
  await expect.poll(() => isAlive(started!.pid)).toBe(false);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyD");

  await expect(sidebar.getByRole("button", { name: "Settled (1)" })).toBeHidden();
  await expect(sessionTab(window, "claude")).toBeVisible();
  await expect(sessionTab(window, "shell")).toBeVisible();
  await expect
    .poll(() => claudeLaunches().map((launch) => launch.argv))
    .toEqual([
      ["--session-id", claudeId],
      ["--resume", claudeId],
    ]);
  await sessionTab(window, "claude").click();
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("after-unsettle");
  await window.keyboard.press("Enter");
  await expect.poll(() => screenText(window)).toContain("fake claude got: after-unsettle");
});

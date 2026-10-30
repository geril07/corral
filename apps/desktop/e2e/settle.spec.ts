import { expect } from "@playwright/test";
import {
  addProject,
  createRepo,
  createTask,
  openedWindow,
  screenText,
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
  await expect(window.getByText("No terminals")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Finished");
  const sidebar = workspace(window);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyS");
  const picker = window.getByRole("dialog", { name: "New agent session" });
  await expect(picker.getByRole("radio", { name: "claude" })).toBeFocused();
  await window.keyboard.press("Digit1");
  await expect(sidebar.getByRole("button", { name: "claude", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("first-prompt");
  await window.keyboard.press("Enter");
  await expect.poll(() => screenText(window)).toContain("fake claude got: first-prompt");
  const claudeLaunches = () => readLaunches(stateDir).filter((launch) => launch.agent === "claude");
  const [started] = claudeLaunches();
  const claudeId = started?.argv[1];
  expect(started?.argv[0]).toBe("--session-id");

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyD");

  await expect(sidebar.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "claude stopped", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "shell stopped", exact: true })).toBeVisible();
  await expect.poll(() => isAlive(started!.pid)).toBe(false);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyD");

  await expect(sidebar.getByRole("button", { name: "Settled (1)" })).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "claude", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "shell", exact: true })).toBeVisible();
  await expect
    .poll(() => claudeLaunches().map((launch) => launch.argv))
    .toEqual([
      ["--session-id", claudeId],
      ["--resume", claudeId],
    ]);
  await sidebar.getByRole("button", { name: "claude", exact: true }).click();
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("after-unsettle");
  await window.keyboard.press("Enter");
  await expect.poll(() => screenText(window)).toContain("fake claude got: after-unsettle");
});

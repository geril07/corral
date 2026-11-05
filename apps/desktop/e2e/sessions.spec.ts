import { expect } from "@playwright/test";
import {
  openAgentSessionPicker,
  addProject,
  createRepo,
  createTask,
  openedWindow,
  screenText,
  sessionTab,
  sessionTabs,
  startShell,
  unwrappedScreenText,
  workspace,
} from "./app-helpers.ts";
import { isAlive, readEndpoint, readLaunches, test } from "./fixtures.ts";

// MVP step 3: shells and agents in a task are sessions; the server brings back those that were running.
test("an agent session is started, stopped and restarted, and a running one comes back after the server was killed", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const first = await launchApp();
  const window = await openedWindow(first);
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Agents");
  await startShell(window);
  const session = (name: string) => sessionTab(window, name);

  // Claude Code through the picker.
  await openAgentSessionPicker(window, "terminal");
  const picker = window.getByRole("dialog", { name: "New agent session" });
  await expect(picker.getByRole("radio", { name: "claude" })).toBeFocused();
  await window.keyboard.press("Digit1");
  await expect(picker).toBeHidden();
  await expect(session("claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("first-prompt");
  await window.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(window)).toContain("fake claude got: first-prompt");

  const started = readLaunches(stateDir).find((launch) => launch.agent === "claude");
  const claudeId = started?.argv[1];
  expect(started?.argv[0]).toBe("--session-id");

  // Stop keeps the session in the list; restart resumes the conversation.
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyX");
  await expect(session("claude stopped")).toBeVisible();
  await expect(window.getByRole("region", { name: "stopped session" })).toBeVisible();
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyR");
  await expect(session("claude")).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      readLaunches(stateDir)
        .filter((launch) => launch.agent === "claude")
        .map((launch) => launch.argv),
    )
    .toEqual([
      ["--session-id", claudeId],
      ["--resume", claudeId],
    ]);
  await expect.poll(() => screenText(window)).toContain("fake claude ready");

  // pi is started and then stopped: it must stay stopped across the restart.
  await openAgentSessionPicker(window, "terminal");
  await expect(picker.getByRole("radio", { name: "claude" })).toBeFocused();
  await window.keyboard.press("Digit3");
  await expect(session("pi")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake pi ready");
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyX");
  await expect(session("pi stopped")).toBeVisible();

  // Quit the app and kill the server and everything under it.
  const serverPid = readEndpoint(stateDir)?.pid ?? 0;
  const agentPid = readLaunches(stateDir).findLast((launch) => launch.agent === "claude")?.pid ?? 0;
  await first.close();
  process.kill(serverPid, "SIGKILL");
  await expect.poll(() => isAlive(serverPid)).toBe(false);
  await expect.poll(() => isAlive(agentPid)).toBe(false);

  const secondWindow = await openedWindow(await launchApp());
  const restored = (name: string) => sessionTab(secondWindow, name);
  await expect(restored("claude")).toBeVisible();
  expect(readEndpoint(stateDir)?.pid).not.toBe(serverPid);
  await expect(restored("shell")).toBeVisible();
  await expect(restored("pi stopped")).toBeVisible();
  await restored("claude").click();
  await expect.poll(() => screenText(secondWindow)).toContain("fake claude ready");
  await expect
    .poll(() =>
      readLaunches(stateDir)
        .filter((launch) => launch.agent === "claude")
        .map((launch) => launch.argv),
    )
    .toEqual([
      ["--session-id", claudeId],
      ["--resume", claudeId],
      ["--resume", claudeId],
    ]);
  expect(
    readLaunches(stateDir).filter(
      (launch) => launch.agent === "pi" && !launch.argv.includes("--no-session"),
    ),
  ).toHaveLength(1);

  // The restored agent is live: it answers.
  await secondWindow.keyboard.type("after-restart");
  await secondWindow.keyboard.press("Enter");
  await expect
    .poll(() => unwrappedScreenText(secondWindow))
    .toContain("fake claude got: after-restart");
});

// A8: the task's sessions are tabs in the main area, not rows in the sidebar.
test("two sessions of one task are tabs that switch by click and by key, and the header names the task", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  // The window takes keys only once the workspace has loaded.
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Tabbed", { workspace: "new-worktree" });
  await startShell(window);

  // The strip holds the task's sessions and, after them, its Changes tab (`layout.md`, **Changes**).
  const tabs = sessionTabs(window);
  await expect(tabs.getByRole("tab", { name: "Changes" })).toHaveCount(1);
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  // Sessions are not sidebar rows any more.
  await expect(workspace(window).getByRole("tab")).toHaveCount(0);

  await openAgentSessionPicker(window, "terminal");
  await expect(window.getByRole("radio", { name: "claude" })).toBeFocused();
  await window.keyboard.press("Digit1");
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(sessionTab(window, "claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");

  // A header names the task, its project, its branch and its agent.
  const header = window.getByRole("group", { name: "task header" });
  await expect(header.getByRole("heading", { name: "Tabbed" })).toBeVisible();
  await expect(header.locator("[data-task-repository]")).toContainText(" / ");

  // Clicking the shell's tab shows that terminal and leaves the keyboard with it.
  await sessionTab(window, "shell").click();
  await expect(sessionTab(window, "shell")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.type("echo shell-tab-$((5*5))");
  await window.keyboard.press("Enter");
  await expect.poll(() => screenText(window)).toContain("shell-tab-25");

  // The session count chord moves back to the agent, which keeps the keyboard.
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyN");
  await expect(sessionTab(window, "claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type("back-to-claude");
  await window.keyboard.press("Enter");
  await expect.poll(() => unwrappedScreenText(window)).toContain("fake claude got: back-to-claude");

  // The Changes tab opens by key and is not a session: the current session stays the agent's,
  // and the clean task shows the empty state (`layout.md`, **Changes**).
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("Shift+KeyC");
  await expect(window.getByRole("tab", { name: "Changes" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(sessionTab(window, "claude")).toHaveAttribute("aria-current", "true");
  await expect(window.getByText("No changes yet")).toBeVisible();
});

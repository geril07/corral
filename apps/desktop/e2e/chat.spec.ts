import { expect } from "@playwright/test";
import {
  chooseTaskAgent,
  addProject,
  createRepo,
  newTaskView,
  openedWindow,
  promptField,
  sessionTab,
} from "./app-helpers.ts";
import { readLaunches, test } from "./fixtures.ts";

// The composer's view control and the chat tab: a prompt-created task opens in chat, its agent is
// the fake pi in RPC mode, and the answer streams into the lane (stage B, decision 5).
test("a task created in chat view from the composer opens as chat", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  await expect(promptField(window)).toBeFocused();
  await window.keyboard.type("Explain the build");

  // pi is the agent with a chat driver in this build, so the view control offers chat.
  await chooseTaskAgent(window, "pi");
  await expect(newTaskView(window).getByRole("button", { name: "Open in chat" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await promptField(window).click();
  await window.keyboard.press("Enter");

  // The task's primary session is a chat tab: pi's, with the chat lane instead of a terminal.
  await expect(
    window.getByRole("navigation", { name: "workspace" }).getByRole("button", {
      name: /^Explain the build/,
    }),
  ).toHaveAttribute("aria-current", "true");
  await expect(sessionTab(window, "pi")).toHaveAttribute("aria-selected", "true");
  await expect(sessionTab(window, "shell")).toHaveCount(0);
  await expect(window.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  await expect(window.getByRole("textbox", { name: "Message" })).toBeVisible();

  // The fake pi answers only after the task prompt arrived over RPC, so the answer is the proof.
  await expect(window.getByText("Here is the answer.")).toBeVisible();

  // It was started in RPC mode, and the prompt is not on argv: a chat launch sends it as a command.
  const launch = readLaunches(stateDir).find((each) => each.agent === "pi");
  expect(launch?.argv).toContain("rpc");
  expect(launch?.argv.some((argument) => argument.trim() === "Explain the build")).toBe(false);
});

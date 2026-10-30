import { expect } from "@playwright/test";
import {
  addProject,
  createRepo,
  createTask,
  openedWindow,
  screenText,
  workspace,
} from "./app-helpers.ts";
import { test } from "./fixtures.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

// An agent that reports itself blocked makes its task and session show it, in the sidebar and on
// the board; the board and prefix g lead to the session that waits.
test("a blocked agent shows in the sidebar and on the board, and Enter jumps to its session", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("No terminals")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Alpha");
  const sidebar = workspace(window);
  const claude = sidebar.getByRole("button", { name: "claude", exact: true });

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyS");
  await expect(
    window
      .getByRole("dialog", { name: "New agent session" })
      .getByRole("radio", { name: "claude" }),
  ).toBeFocused();
  await window.keyboard.press("Digit1");
  await expect(claude).toHaveAttribute("aria-current", "true");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");

  await window.keyboard.type(`osc state=blocked:kind=permission:msg=${b64("Run rm -rf build?")}`);
  await window.keyboard.press("Enter");

  const blocked = sidebar.getByRole("img", { name: "blocked · permission" });
  await expect(blocked).toHaveCount(2);
  await expect(sidebar.getByRole("button", { name: /^Alpha/ })).toHaveAttribute(
    "title",
    "Run rm -rf build?",
  );

  await createTask(window, "Beta", 2);
  await expect(claude).not.toHaveAttribute("aria-current", "true");

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyB");
  const board = window.getByRole("dialog", { name: "Board" });
  // Keys reach the board only once it has taken focus from the terminal.
  await expect(board.getByRole("listbox")).toBeFocused();
  const alphaRow = board.getByRole("option", { name: /Alpha/ });
  await expect(alphaRow).toContainText("blocked · permission");
  await expect(alphaRow).toContainText("Run rm -rf build?");
  await expect(board.getByRole("option", { name: /Beta/ })).toContainText("no status");
  await expect(alphaRow).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");

  await expect(board).toBeHidden();
  await expect(sidebar.getByRole("button", { name: /^Alpha/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(claude).toHaveAttribute("aria-current", "true");
  await window.keyboard.type(`osc state=done:msg=${b64("All green")}`);
  await window.keyboard.press("Enter");

  await expect(sidebar.getByRole("img", { name: "done" })).toHaveCount(2);
  await expect(blocked).toHaveCount(0);
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyB");
  await expect(board.getByRole("listbox")).toBeFocused();
  await expect(board.getByRole("option", { name: /Alpha/ })).toContainText("done");
  await expect(board.getByRole("option", { name: /Alpha/ })).toContainText("All green");
  await window.keyboard.press("Escape");
  await expect(board).toBeHidden();
});

test("prefix g jumps to the blocked session from another task and says so when none is blocked", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("No terminals")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Alpha");
  const sidebar = workspace(window);

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyG");
  await expect(window.getByText("No blocked sessions.")).toBeVisible();

  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyS");
  await expect(
    window
      .getByRole("dialog", { name: "New agent session" })
      .getByRole("radio", { name: "claude" }),
  ).toBeFocused();
  await window.keyboard.press("Digit1");
  await expect.poll(() => screenText(window)).toContain("fake claude ready");
  await window.keyboard.type(`osc state=blocked:kind=question:msg=${b64("Which branch?")}`);
  await window.keyboard.press("Enter");
  await expect(sidebar.getByRole("img", { name: "blocked · question" })).toHaveCount(2);

  await createTask(window, "Beta", 2);
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyG");

  await expect(sidebar.getByRole("button", { name: /^Alpha/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(sidebar.getByRole("button", { name: "claude", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

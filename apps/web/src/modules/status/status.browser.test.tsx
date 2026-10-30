import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { reportBody } from "../../../test/osc7501.ts";
import { prefixThen, realServerClients, screenText } from "../../../test/real-client.ts";
import {
  appWithProject,
  createTask,
  focusedIsTerminal,
  taskButton,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const board = () => page.getByRole("region", { name: "Board" });
const boardRow = (title: string) => board().getByRole("option", { name: new RegExp(title) });
/** The glyphs of the sidebar that carry `name` as their text alternative. */
const indicators = (name: string) => workspace().getByRole("img", { name });
const claudeButton = () => workspace().getByRole("button", { name: /^claude/ });

/** What the agent in the focused terminal is told to print: an OSC 7501 report. */
const report = (fields: Parameters<typeof reportBody>[0]) =>
  userEvent.keyboard(`osc ${reportBody(fields)}{Enter}`);

async function startClaude() {
  await prefixThen("s");
  await expect.element(page.getByRole("dialog", { name: "New agent session" })).toBeVisible();
  await userEvent.keyboard("1");
  await expect.element(claudeButton()).toHaveAttribute("aria-current", "true");
  await expect.poll(screenText).toContain("fake claude ready");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
}

test("a blocked agent shows on its session and task; the board and prefix g jump to it, and done updates both", async () => {
  await appWithProject(newClient());
  await createTask("Alpha");
  await startClaude();

  await report({ state: "blocked", kind: "permission", msg: "Run rm -rf build?" });
  await expect.element(indicators("blocked · permission")).toHaveLength(2);
  await expect.element(taskButton("Alpha")).toHaveAttribute("title", "Run rm -rf build?");

  // A second task, which becomes current and has nothing to report.
  await createTask("Beta");
  await workspace().getByRole("button", { name: "Expand sessions for Alpha" }).click();
  await expect.element(claudeButton()).not.toHaveAttribute("aria-current");

  await prefixThen("g");
  await expect.element(taskButton("Alpha")).toHaveAttribute("aria-current", "true");
  await expect.element(claudeButton()).toHaveAttribute("aria-current", "true");

  await prefixThen("j");
  await expect.element(taskButton("Beta")).toHaveAttribute("aria-current", "true");

  await prefixThen("b");
  await expect.element(board()).toBeVisible();
  await expect.element(boardRow("Alpha")).toMatchTextContent(/blocked · permission/);
  await expect.element(boardRow("Alpha")).toMatchTextContent(/Run rm -rf build\?/);
  await expect.element(boardRow("Beta")).toMatchTextContent(/no status/);
  await expect.element(boardRow("Alpha")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");

  await expect.element(board()).not.toBeInTheDocument();
  await expect.element(taskButton("Alpha")).toHaveAttribute("aria-current", "true");
  await expect.element(claudeButton()).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await report({ state: "done", msg: "All green" });
  await expect.element(indicators("done")).toHaveLength(2);
  await expect.element(indicators("blocked · permission")).not.toBeInTheDocument();
  await prefixThen("b");
  await expect.element(boardRow("Alpha")).toMatchTextContent(/done/);
  await expect.element(boardRow("Alpha")).toMatchTextContent(/All green/);
  await userEvent.keyboard("{Escape}");
  await expect.element(board()).not.toBeInTheDocument();

  // Nothing is blocked any more.
  await prefixThen("g");
  await expect.element(page.getByText("No blocked sessions.")).toBeVisible();
});

test("stopping an agent drops the working status it had", async () => {
  await appWithProject(newClient());
  await createTask("Alpha");
  await startClaude();
  await report({ state: "working" });
  await expect.element(indicators("working")).toHaveLength(2);

  await prefixThen("x");
  await expect.element(workspace().getByRole("button", { name: "claude stopped" })).toBeVisible();
  await expect.element(indicators("working")).not.toBeInTheDocument();
});

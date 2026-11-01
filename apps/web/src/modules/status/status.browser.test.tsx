import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { reportBody } from "../../../test/osc7501.ts";
import { prefixThen, realServerClients, screenText } from "../../../test/real-client.ts";
import {
  appWithProject,
  createTask,
  createTaskWithShell,
  focusedIsTerminal,
  sessionTab,
  taskButton,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const board = () => page.getByRole("region", { name: "Board" });
const boardRow = (title: string) => board().getByRole("option", { name: new RegExp(title) });
/** Every glyph that carries `name` as its text alternative: task rows, tabs and the header. */
const indicators = (name: string) => page.getByRole("img", { name });
const claudeButton = () => sessionTab(/^claude/);

/** What the agent in the focused terminal is told to print: an OSC 7501 report. */
const report = (fields: Parameters<typeof reportBody>[0]) =>
  userEvent.keyboard(`osc ${reportBody(fields)}{Enter}`);

async function startClaude() {
  await prefixThen("s");
  await expect.element(page.getByRole("dialog", { name: "New agent session" })).toBeVisible();
  await userEvent.keyboard("1");
  await expect.element(claudeButton()).toHaveAttribute("aria-selected", "true");
  await expect.poll(screenText).toContain("fake claude ready");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
}

test("a blocked agent shows on its session and task; the board and prefix g jump to it, and done updates both", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Alpha");
  await startClaude();

  await report({ state: "blocked", kind: "permission", msg: "Run rm -rf build?" });
  // The sidebar row, the session tab and the task header all say what the task needs.
  await expect.element(indicators("blocked · permission")).toHaveLength(3);
  await expect.element(taskButton("Alpha")).toHaveAttribute("title", "Run rm -rf build?");

  // A second task, which becomes current and has nothing to report; Alpha's sessions stay with
  // Alpha, which the flat list no longer shows the sessions of.
  await createTask("Beta");
  await expect.element(claudeButton()).not.toBeInTheDocument();

  await prefixThen("g");
  await expect.element(taskButton("Alpha")).toHaveAttribute("aria-current", "true");
  await expect.element(claudeButton()).toHaveAttribute("aria-selected", "true");

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
  await expect.element(claudeButton()).toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await report({ state: "done", msg: "All green" });
  // A done tab keeps its kind icon; the row and the header carry the status.
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
  await createTaskWithShell("Alpha");
  await startClaude();
  await report({ state: "working" });
  await expect.element(indicators("working")).toHaveLength(3);

  await prefixThen("x");
  await expect.element(sessionTab("claude stopped")).toBeVisible();
  await expect.element(indicators("working")).not.toBeInTheDocument();
});

/** The color a theme token resolves to, read through a throwaway element. */
function tokenColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

test("working, needs you and done carry the three status colors, and idle stays muted", async () => {
  await appWithProject(newClient());
  await createTask("Colored");
  await startClaude();

  // The task row's glyph is the one every view shares; its color is the theme token's.
  const glyphColor = (name: string) => {
    const row = workspace().getByRole("img", { name });
    const glyph = row.element().querySelector("[data-status]");
    if (!glyph) throw new Error(`no glyph for ${name}`);
    return getComputedStyle(glyph).color;
  };

  await report({ state: "working" });
  await expect.element(indicators("working")).toHaveLength(3);
  expect(glyphColor("working")).toBe(tokenColor("--status-working"));

  await report({ state: "blocked", kind: "question", msg: "Which branch?" });
  await expect.element(indicators("blocked · question")).toHaveLength(3);
  expect(glyphColor("blocked · question")).toBe(tokenColor("--status-attention"));

  await report({ state: "error", msg: "The agent stopped" });
  await expect.element(indicators("error")).toHaveLength(2);
  expect(glyphColor("error")).toBe(tokenColor("--destructive"));

  await report({ state: "done", msg: "All green" });
  await expect.element(indicators("done")).toHaveLength(2);
  // The header always shows the done color; a row fades it to muted once the update was seen.
  const header = page.getByRole("group", { name: "task header" });
  const headerGlyph = header
    .getByRole("img", { name: "done" })
    .element()
    .querySelector("[data-status]");
  expect(getComputedStyle(headerGlyph!).color).toBe(tokenColor("--status-done"));
  expect(glyphColor("done")).toBe(tokenColor("--muted-foreground"));
});

import type { BoardRow } from "@corral/client/board";
import type { AgentStatus, Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { Board } from "./board.tsx";

const project = (id: string): Project => ({
  id,
  name: `repo-${id}`,
  path: `/repos/${id}`,
  defaultBaseBranch: "main",
});
const row = (id: string, status?: AgentStatus, sessionId = `s-${id}`): BoardRow => ({
  project: project("p1"),
  task: {
    id,
    projectId: "p1",
    title: `task ${id}`,
    titleSource: "user",
    prompt: null,
    primarySessionId: null,
    branch: id,
    workspacePath: `/work/${id}`,
    ownsWorktree: true,
    state: "active",
    seenAt: null,
    createdAt: 0,
  } satisfies Task,
  sessionId: status ? sessionId : undefined,
  status,
});

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;
const rows = [
  row("a", {
    state: "blocked",
    kind: "permission",
    message: "Run rm -rf build?",
    updatedAt: minutesAgo(5),
  }),
  row("b", { state: "error", message: "API key rejected", updatedAt: minutesAgo(120) }),
  row("c", { state: "working", updatedAt: minutesAgo(0) }),
  row("d"),
];

const dialog = () => page.getByRole("region", { name: "Board" });
const option = (title: string) => dialog().getByRole("option", { name: new RegExp(title) });

async function opened(shown: readonly BoardRow[] = rows) {
  const onJump = vi.fn<(row: BoardRow) => void>();
  const onClose = vi.fn<() => void>();
  await render(<Board rows={shown} onJump={onJump} onClose={onClose} />);
  await expect.element(dialog().getByRole("listbox")).toHaveFocus();
  return { onJump, onClose };
}

test("each row shows project, task, status with what it waits for, the agent's message and age", async () => {
  await opened();

  const blocked = option("task a");
  await expect.element(blocked).toMatchTextContent(/repo-p1/);
  await expect.element(blocked).toMatchTextContent(/blocked · permission/);
  await expect.element(blocked).toMatchTextContent(/Run rm -rf build\?/);
  await expect.element(blocked).toMatchTextContent(/5m/);
  await expect.element(option("task b")).toMatchTextContent(/error/);
  await expect.element(option("task b")).toMatchTextContent(/2h/);
  await expect.element(option("task c")).toMatchTextContent(/working/);
  await expect.element(option("task d")).toMatchTextContent(/no status/);
  await expect
    .element(blocked.getByRole("img", { name: "blocked · permission" }))
    .toHaveAttribute("title", "blocked · permission: Run rm -rf build?");
});

test("the first row is highlighted; arrows and j/k move it, wrapping around", async () => {
  await opened();
  await expect.element(option("task a")).toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(option("task b")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("j");
  await expect.element(option("task c")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("k{ArrowUp}");
  await expect.element(option("task a")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(option("task d")).toHaveAttribute("aria-selected", "true");
});

test("Enter jumps to the highlighted task and the session that needs attention", async () => {
  const { onJump } = await opened();

  await userEvent.keyboard("{ArrowDown}{Enter}");

  expect(onJump).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: "s-b" }));
  expect(onJump.mock.calls[0]?.[0].task.id).toBe("b");
});

test("clicking a row jumps to it", async () => {
  const { onJump } = await opened();

  await option("task c").click();

  expect(onJump.mock.calls[0]?.[0].task.id).toBe("c");
});

test("the back control closes the board and is reachable by pointer", async () => {
  const { onClose } = await opened();

  await dialog().getByRole("button", { name: "Back to workspace" }).click();

  expect(onClose).toHaveBeenCalledOnce();
});

test("Escape closes the board without jumping", async () => {
  const { onJump, onClose } = await opened();

  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onJump).not.toHaveBeenCalled();
});

test("the highlight stays on its task when a status change reorders the rows", async () => {
  const onJump = vi.fn<(row: BoardRow) => void>();
  const screen = await render(<Board rows={rows} onJump={onJump} onClose={() => {}} />);
  await expect.element(dialog().getByRole("listbox")).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(option("task b")).toHaveAttribute("aria-selected", "true");

  const [a, b, ...rest] = rows;
  await screen.rerender(<Board rows={[b!, a!, ...rest]} onJump={onJump} onClose={() => {}} />);

  await expect.element(option("task b")).toHaveAttribute("aria-selected", "true");
});

test("with no active tasks it says so", async () => {
  const { onJump } = { onJump: vi.fn<(row: BoardRow) => void>() };
  await render(<Board rows={[]} onJump={onJump} onClose={() => {}} />);

  await expect.element(dialog().getByText("No active tasks.")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(onJump).not.toHaveBeenCalled();
});

test("a clipped board task title keeps its full value in a tooltip", async () => {
  const longTitle =
    "A very long task title that does not fit the board's task column at the small desktop width";
  const base = row("long");
  const longRow = { ...base, task: { ...base.task, title: longTitle } };
  await render(
    <div className="w-96">
      <Board rows={[longRow]} onJump={() => {}} onClose={() => {}} />
    </div>,
  );

  const longOption = page.getByRole("option", { name: new RegExp(longTitle) });
  const title = longOption.element().querySelector("span[title]");
  expect(title?.getAttribute("title")).toBe(`repo-p1 ${longTitle}`);
  if (title) await userEvent.hover(title);
  await expect.element(page.getByRole("tooltip")).toMatchTextContent(longTitle);
});

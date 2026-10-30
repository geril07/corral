import { buildWorkspaceTree, resolveSelection, type Chosen } from "@corral/client/workspace-tree";
import type { Project, Task, TerminalInfo } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet: a dialog is only reachable once it is positioned
import "./app.css";
import { Sidebar } from "./Sidebar.tsx";

const project = (id: string): Project => ({
  id,
  name: `repo-${id}`,
  path: `/repos/${id}`,
  defaultBaseBranch: "main",
});
const task = (id: string, state: Task["state"] = "active"): Task => ({
  id,
  projectId: "p1",
  title: `task ${id}`,
  branch: `branch-${id}`,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state,
  createdAt: 0,
});
const terminal = (id: string, taskId: string | null, command = "/bin/sh"): TerminalInfo => ({
  id,
  taskId,
  command,
  args: [],
  cwd: `/work/${taskId ?? "home"}`,
  size: { cols: 80, rows: 24 },
  exit: null,
});

function renderSidebar(chosen: Chosen = {}, terminals: TerminalInfo[] = []) {
  const tree = buildWorkspaceTree(
    [project("p1"), project("p2")],
    [task("a"), task("b"), task("old", "archived")],
    [
      terminal("t1", "a"),
      terminal("t2", "a", "/usr/bin/claude"),
      terminal("t3", null),
      ...terminals,
    ],
  );
  const handlers = {
    onSelectProject: vi.fn<(project: Project) => void>(),
    onSelectTask: vi.fn<(task: Task) => void>(),
    onSelectLoose: vi.fn<() => void>(),
    onSelectTerminal: vi.fn<(terminal: TerminalInfo) => void>(),
    onCloseTerminal: vi.fn<(id: string) => void>(),
    onToggleArchive: vi.fn<(task: Task) => void>(),
    onRemoveTask: vi.fn<(task: Task) => void>(),
    onAddProject: vi.fn<() => void>(),
    onNewTask: vi.fn<() => void>(),
    onNewTerminal: vi.fn<() => void>(),
  };
  const rendered = render(
    <Sidebar tree={tree} selection={resolveSelection(tree, chosen)} {...handlers} />,
  );
  return { rendered, handlers };
}

const nav = () => page.getByRole("navigation", { name: "workspace" });

test("projects list their active tasks, each with its terminals; loose terminals sit under No task", async () => {
  await renderSidebar().rendered;

  await expect.element(nav().getByRole("button", { name: "repo-p1" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "repo-p2" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: /^task a/ })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: /^task b/ })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "sh · a" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "claude · a" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "No task" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "sh · home" })).toBeVisible();
});

test("archived tasks stay collapsed until the group is opened", async () => {
  await renderSidebar().rendered;
  const toggle = nav().getByRole("button", { name: "Archived (1)" });

  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(nav().getByRole("button", { name: /^task old/ })).not.toBeInTheDocument();

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(nav().getByRole("button", { name: /^task old/ })).toBeVisible();

  await toggle.click();
  await expect.element(nav().getByRole("button", { name: /^task old/ })).not.toBeInTheDocument();
});

test("the group opens by itself while it holds the current task", async () => {
  await renderSidebar({ taskId: "old" }).rendered;

  await expect
    .element(nav().getByRole("button", { name: /^task old/ }))
    .toHaveAttribute("aria-current", "true");
});

test("the current task and terminal are marked", async () => {
  await renderSidebar({ taskId: "a", terminalId: "t2" }).rendered;

  await expect
    .element(nav().getByRole("button", { name: /^task a/ }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(nav().getByRole("button", { name: "claude · a" }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(nav().getByRole("button", { name: "sh · a" }))
    .not.toHaveAttribute("aria-current");
});

test("clicking reports what was picked", async () => {
  const { handlers } = renderSidebar();

  await nav().getByRole("button", { name: "claude · a" }).click();
  expect(handlers.onSelectTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: "t2" }));

  await nav()
    .getByRole("button", { name: /^task b/ })
    .click();
  expect(handlers.onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

  await nav().getByRole("button", { name: "repo-p2" }).click();
  expect(handlers.onSelectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "p2" }));

  await nav().getByRole("button", { name: "archive task a" }).click();
  expect(handlers.onToggleArchive).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

  await nav().getByRole("button", { name: "remove task task b" }).click();
  expect(handlers.onRemoveTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

  await nav().getByRole("button", { name: "close sh · a" }).click();
  expect(handlers.onCloseTerminal).toHaveBeenCalledWith("t1");

  await nav().getByRole("button", { name: "Add project" }).click();
  await nav().getByRole("button", { name: "New task" }).click();
  await nav().getByRole("button", { name: "New terminal" }).click();
  expect(handlers.onAddProject).toHaveBeenCalledOnce();
  expect(handlers.onNewTask).toHaveBeenCalledOnce();
  expect(handlers.onNewTerminal).toHaveBeenCalledOnce();
});

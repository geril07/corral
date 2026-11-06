import {
  buildFlatSidebar,
  buildWorkspaceTree,
  resolveSelection,
  type Chosen,
  type SidebarMode,
  type TerminalEntry,
} from "@corral/client/workspace-tree";
import {
  DEFAULT_BINDINGS,
  DEFAULT_PREFIX,
  defaultClientConfig,
  type ClientConfig,
} from "@corral/protocol/config";
import type { Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { Sidebar } from "./sidebar.tsx";
import { SHELF_MAX_PAGES } from "./sidebar-view.ts";

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
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: `branch-${id}`,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state,
  seenAt: null,
  createdAt: 0,
});
const session = (
  id: string,
  taskId: string,
  kind: Session["kind"],
  state: Session["state"] = "running",
): Session => ({
  id,
  taskId,
  kind,
  view: "terminal",
  agentSessionId: null,
  terminalId: state === "running" ? `term-${id}` : null,
  state,
  status: null,
  createdAt: Number(id.replace(/\D/g, "")),
});
const terminal = (
  id: string,
  taskId: string | null,
  sessionId: string | null,
  label: string | null = null,
): TerminalInfo => ({
  id,
  taskId,
  sessionId,
  command: "/bin/sh",
  args: [],
  cwd: `/work/${taskId ?? "home"}`,
  size: { cols: 80, rows: 24 },
  exit: null,
  label,
});

const defaultSessions = [
  session("s1", "a", "shell"),
  session("s2", "a", "claude"),
  session("s3", "a", "codex", "stopped"),
  session("s4", "b", "pi", "unresumable"),
];

const config: ClientConfig = {
  ...defaultClientConfig(""),
  keys: { prefix: DEFAULT_PREFIX, bindings: { ...DEFAULT_BINDINGS } },
};

const handlers = () => ({
  onSelectTask: vi.fn<(task: Task) => void>(),
  onSelectLoose: vi.fn<() => void>(),
  onSelectTerminal: vi.fn<(entry: TerminalEntry) => void>(),
  onCloseTerminal: vi.fn<(id: string) => void>(),
  onRenameTerminal: vi.fn<(entry: TerminalEntry) => void>(),
  onRenameTask: vi.fn<(task: Task, opener?: HTMLElement) => void>(),
  onToggleSettle: vi.fn<(task: Task) => void>(),
  onRemoveTask: vi.fn<(task: Task) => void>(),
  onNewTask: vi.fn<(project?: Project, opener?: HTMLElement) => void>(),
  onFindTask: vi.fn<(opener?: HTMLElement) => void>(),
});

function renderSidebar(
  chosen: Chosen = {},
  sessions: Session[] = defaultSessions,
  tasks: Task[] = [task("a"), task("b"), task("old", "settled")],
  narrow = false,
  mode: SidebarMode = "project",
  composing?: { project?: Project; opened: number },
) {
  const tree = buildWorkspaceTree([project("p1"), project("p2")], tasks, sessions, [
    terminal("term-s1", "a", "s1"),
    terminal("term-s2", "a", "s2"),
    terminal("loose", null, null),
  ]);
  const spies = handlers();
  const rendered = render(
    <div className={narrow ? "flex h-screen w-52 flex-col" : "flex h-screen flex-col"}>
      <Sidebar
        tree={tree}
        selection={resolveSelection(tree, chosen)}
        composing={composing}
        flat={mode === "flat" ? buildFlatSidebar(tree) : undefined}
        config={config}
        {...spies}
      />
      {/* The shell footer the pane sits above, so the shelf measures the page a real window gives it. */}
      <div aria-hidden className="h-(--chrome-row) shrink-0" />
    </div>,
  );
  return { rendered, handlers: spies };
}

/** A sidebar whose selection the test can move without a real workspace or server. */
async function renderSelectableSidebar(
  chosen: Chosen,
  sessions: Session[] = defaultSessions,
  tasks: Task[] = [task("a"), task("b"), task("old", "settled")],
) {
  const tree = buildWorkspaceTree([project("p1"), project("p2")], tasks, sessions, [
    terminal("term-s1", "a", "s1"),
    terminal("term-s2", "a", "s2"),
    terminal("loose", null, null),
  ]);
  const spies = handlers();
  const element = (next: Chosen) => (
    <div className="flex h-screen flex-col">
      <Sidebar tree={tree} selection={resolveSelection(tree, next)} config={config} {...spies} />
      <div aria-hidden className="h-(--chrome-row) shrink-0" />
    </div>
  );
  return { rendered: await render(element(chosen)), select: (next: Chosen) => element(next) };
}

/** A sidebar whose tasks the test can settle through the row menu and whose mode it can swap. */
function ShelfFixture({
  initialTasks,
  sessions,
  mode,
  chosen,
}: {
  initialTasks: Task[];
  sessions: Session[];
  mode: SidebarMode;
  chosen: Chosen;
}) {
  const [tasks, setTasks] = useState(initialTasks);
  const tree = buildWorkspaceTree([project("p1"), project("p2")], tasks, sessions, [
    terminal("loose", null, null),
  ]);
  const spies = handlers();
  return (
    <div className="flex h-screen flex-col">
      <Sidebar
        tree={tree}
        selection={resolveSelection(tree, chosen)}
        flat={mode === "flat" ? buildFlatSidebar(tree) : undefined}
        config={config}
        {...spies}
        onToggleSettle={(settledTask) => {
          const state: Task["state"] = settledTask.state === "active" ? "settled" : "active";
          setTasks((current) =>
            current.map((each) => (each.id === settledTask.id ? { ...each, state } : each)),
          );
        }}
      />
      <div aria-hidden className="h-(--chrome-row) shrink-0" />
    </div>
  );
}

const nav = () => page.getByRole("navigation", { name: "workspace" });
const row = (title: string) => nav().getByRole("button", { name: new RegExp(`^${title}`) });
const shelfBox = () => {
  const box = nav().element().querySelector<HTMLElement>("[data-shelf-list]");
  if (box === null) throw new Error("the shelf box is not mounted");
  return box;
};
const activeList = () => {
  const list = nav().element().querySelector<HTMLElement>("[data-sidebar-list]");
  if (list === null) throw new Error("the active list is not mounted");
  return list;
};
const taskRowsIn = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-task-row]")];
const shelfTitles = () =>
  taskRowsIn(shelfBox()).map((item) => {
    const title = item.getAttribute("aria-label")?.match(/^task (\S+)/)?.[1];
    if (title === undefined) throw new Error("the shelf row has no task title");
    return title;
  });
/** Whether a row sits wholly inside a box's visible area. */
function visibleIn(element: Element, box: Element): boolean {
  const area = box.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1;
}

test("tasks are the only rows; loose terminals sit under Scratch", async () => {
  await renderSidebar().rendered;

  await expect.element(nav().getByRole("button", { name: "repo-p1" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "repo-p2" })).toBeVisible();
  await expect.element(row("task a")).toBeVisible();
  await expect.element(row("task b")).toBeVisible();

  // Sessions are tabs in the main area now, not sidebar rows.
  await expect
    .element(nav().getByRole("button", { name: /^shell|^claude|^codex/ }))
    .not.toBeInTheDocument();
  await expect.element(nav().getByRole("button", { name: "Scratch" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: /^sh · / })).toBeVisible();
});

test("a two-line task row names its branch, agent and session count on the second line", async () => {
  await renderSidebar().rendered;

  const first = nav().getByRole("button", { name: /^task a/ });
  await expect.element(first).toMatchTextContent(/branch-a · claude · 3 sessions/);
  expect(first.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(52);
  // Project mode already groups by project, so the row does not repeat its name.
  expect(first.element().textContent).not.toContain("repo-p1");
});

test("settled tasks stay collapsed until the group is opened", async () => {
  await renderSidebar().rendered;
  const toggle = nav().getByRole("button", { name: "Settled (1)" });

  // The toggle is one full-width row like a task row, not a shrink-wrapped label.
  const parent = toggle.element().parentElement;
  if (!parent) throw new Error("the settled toggle has no row");
  expect(toggle.element().getBoundingClientRect().width).toBeCloseTo(
    parent.getBoundingClientRect().width,
    0,
  );

  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(row("task old")).not.toBeInTheDocument();

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(row("task old")).toBeVisible();

  await toggle.click();
  await expect.element(row("task old")).not.toBeInTheDocument();
});

test("one bottom shelf spans every project and pages by its measured box", async () => {
  const tasks = [
    task("current"),
    ...Array.from({ length: 14 }, (_, index) => ({
      ...task(`settled-${index}`, "settled"),
      projectId: index % 2 === 0 ? "p1" : "p2",
      createdAt: index + 1,
    })),
  ];
  await renderSidebar({ taskId: "current" }, [], tasks).rendered;
  const shelf = nav().getByRole("button", { name: "Settled (14)" });
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");
  await expect.element(shelf).toBeEnabled();
  await shelf.click();
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");

  // One measured page: the rows the box fits. At 1024×640 and 100% that is four.
  const rowHeight = () => taskRowsIn(shelfBox())[0]!.getBoundingClientRect().height;
  expect(taskRowsIn(shelfBox())).toHaveLength(4);
  expect(shelfBox().clientHeight).toBeCloseTo(4 * rowHeight(), 0);
  expect(shelfBox().scrollHeight).toBeLessThanOrEqual(shelfBox().clientHeight + 1);
  expect(taskRowsIn(shelfBox()).filter((item) => visibleIn(item, shelfBox()))).toHaveLength(4);
  const showMore = nav().getByRole("button", { name: "Show more", exact: true });
  await expect.element(showMore).toBeVisible();
  // The control is the shelf's last row, inside the pane, never below the fold.
  expect(showMore.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
    nav().element().getBoundingClientRect().bottom + 1,
  );

  // Show more appends exactly one measured page, and the appended page is what you see.
  const appendPage = async (mounted: number) => {
    await showMore.click();
    await vi.waitFor(() => expect(taskRowsIn(shelfBox())).toHaveLength(mounted));
    const appended = taskRowsIn(shelfBox()).slice(mounted - 4, mounted);
    await vi.waitFor(() =>
      expect(appended.every((item) => visibleIn(item, shelfBox()))).toBe(true),
    );
    await expect.element(showMore).toBeVisible();
  };
  await appendPage(8);
  await appendPage(12);

  await showMore.click();
  await vi.waitFor(() => expect(taskRowsIn(shelfBox())).toHaveLength(14));
  const appended = taskRowsIn(shelfBox()).slice(12);
  await vi.waitFor(() => expect(appended.every((item) => visibleIn(item, shelfBox()))).toBe(true));
  await expect
    .element(nav().getByRole("button", { name: "Show more", exact: true }))
    .not.toBeInTheDocument();
});

test("at 140% interface scale the shelf shrinks first and the active list keeps four rows", async () => {
  const tasks = [
    task("current"),
    ...Array.from({ length: 14 }, (_, index) => ({
      ...task(`settled-${index}`, "settled"),
      createdAt: index + 1,
    })),
  ];
  const previous = document.documentElement.style.fontSize;
  try {
    await renderSidebar({ taskId: "current" }, [], tasks).rendered;
    await nav().getByRole("button", { name: "Settled (14)" }).click();
    const rowHeight = () => taskRowsIn(shelfBox())[0]!.getBoundingClientRect().height;
    expect(taskRowsIn(shelfBox())).toHaveLength(4);
    expect(activeList().clientHeight).toBeGreaterThanOrEqual(4 * rowHeight() - 1);

    // Growing the interface shrinks the shelf's box before it takes rows from the active list.
    document.documentElement.style.fontSize = "140%";
    await vi.waitFor(() => expect(rowHeight()).toBeGreaterThan(52 * 1.3));
    await vi.waitFor(() => {
      const pageRows = Math.max(1, Math.floor(shelfBox().clientHeight / rowHeight()));
      expect(pageRows).toBeLessThan(4);
      expect(taskRowsIn(shelfBox())).toHaveLength(pageRows);
    });
    expect(activeList().clientHeight).toBeGreaterThanOrEqual(4 * rowHeight() - 1);
    expect(shelfBox().clientHeight).toBeCloseTo(rowHeight(), 0);
  } finally {
    document.documentElement.style.fontSize = previous;
  }
});

test("a collapsed shelf shows the current task's row alone, and expanding it never clips that row", async () => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({
    ...task(`archived-${index}`, "settled"),
    createdAt: index + 1,
  }));
  // No active tasks: the shelf is the whole list, and the current row sits past the first page.
  await renderSidebar({ taskId: "archived-10" }, [], tasks).rendered;
  const shelf = nav().getByRole("button", { name: "Settled (20)" });
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");
  await expect.element(shelf).toBeEnabled();
  expect(taskRowsIn(nav().element())).toHaveLength(1);
  const currentRow = nav().getByRole("button", { name: /^task archived-10/ });
  await expect.element(currentRow).toHaveAttribute("aria-current", "true");
  expect(visibleIn(currentRow.element(), nav().element())).toBe(true);

  await shelf.click();
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  await expect.element(shelf).toBeEnabled();
  // The mount is bounded to the page holding the row plus at most one beyond it.
  await vi.waitFor(() => expect(taskRowsIn(shelfBox())).toHaveLength(16));
  await vi.waitFor(() => expect(visibleIn(currentRow.element(), shelfBox())).toBe(true));

  await shelf.click();
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");
  expect(taskRowsIn(nav().element())).toHaveLength(1);
  await expect.element(currentRow).toHaveAttribute("aria-current", "true");
});

test("a shelf the selection opened collapses when the selection leaves; a user-expanded one stays", async () => {
  const tree = buildWorkspaceTree(
    [project("p1")],
    [task("a"), task("old", "settled")],
    defaultSessions,
    [],
  );
  const spies = handlers();
  const sidebar = (chosen: Chosen) => (
    <div className="flex h-screen flex-col">
      <Sidebar tree={tree} selection={resolveSelection(tree, chosen)} config={config} {...spies} />
      <div aria-hidden className="h-(--chrome-row) shrink-0" />
    </div>
  );
  const rendered = await render(sidebar({ taskId: "a" }));
  const shelf = nav().getByRole("button", { name: "Settled (1)" });
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");

  // Selecting a settled task opens the shelf; `j` into it does the same in the workspace.
  await rendered.rerender(sidebar({ taskId: "old" }));
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  await expect.element(row("task old")).toHaveAttribute("aria-current", "true");
  // Leaving the shelf collapses what the selection opened.
  await rendered.rerender(sidebar({ taskId: "a" }));
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");
  await expect.element(row("task old")).not.toBeInTheDocument();

  // A shelf the user expanded stays open when the selection leaves.
  await shelf.click();
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  await rendered.rerender(sidebar({ taskId: "old" }));
  await expect.element(row("task old")).toHaveAttribute("aria-current", "true");
  await rendered.rerender(sidebar({ taskId: "a" }));
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
});

test("a settled task beyond page 1 opens the shelf with a bounded mount and reveals its row", async () => {
  const tasks = [
    task("live"),
    ...Array.from({ length: 20 }, (_, index) => ({
      ...task(`deep-${index}`, "settled"),
      createdAt: index + 1,
    })),
  ];
  const { rendered, select } = await renderSelectableSidebar({ taskId: "live" }, [], tasks);
  await rendered.rerender(select({ taskId: "deep-10" }));
  const shelf = nav().getByRole("button", { name: "Settled (20)" });
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  const currentRow = nav().getByRole("button", { name: /^task deep-10/ });
  await expect.element(currentRow).toHaveAttribute("aria-current", "true");
  // Mounted through the page holding the row plus one page, not the whole history.
  expect(taskRowsIn(shelfBox())).toHaveLength(16);
  await vi.waitFor(() => expect(visibleIn(currentRow.element(), shelfBox())).toBe(true));
});

test("the selected row is revealed when the selection moves and when the list changes", async () => {
  const first = Array.from({ length: 12 }, (_, index) => task(`first-${index}`));
  const second = Array.from({ length: 8 }, (_, index) => ({
    ...task(`second-${index}`),
    projectId: "p2",
  }));
  const { rendered, select } = await renderSelectableSidebar(
    { taskId: "first-0" },
    [],
    [...first, ...second, task("old", "settled")],
  );
  await rendered.rerender(select({ taskId: "second-0" }));
  const selected = row("task second-0");
  await vi.waitFor(() => expect(visibleIn(selected.element(), activeList())).toBe(true));

  // Opening the shelf shrinks the list; the revealed row stays visible.
  await nav().getByRole("button", { name: "Settled (1)" }).click();
  await vi.waitFor(() => expect(visibleIn(selected.element(), activeList())).toBe(true));

  // Expanding the group above the row pushes it down; the list reveals it again.
  const firstProject = nav().getByRole("button", { name: "repo-p1" });
  await firstProject.click();
  await expect.element(firstProject).toHaveAttribute("aria-expanded", "false");
  await vi.waitFor(() => expect(visibleIn(selected.element(), activeList())).toBe(true));
  await firstProject.click();
  await expect.element(firstProject).toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() => expect(visibleIn(selected.element(), activeList())).toBe(true));
});

test("Show more with a settled task current reveals the appended page and keeps the selection", async () => {
  const tasks = Array.from({ length: 14 }, (_, index) => ({
    ...task(`settled-${index}`, "settled"),
    createdAt: index + 1,
  }));
  const { rendered, select } = await renderSelectableSidebar({ taskId: "settled-13" }, [], tasks);

  // The newest task restores first; the collapsed shelf shows its row alone, the toggle opens it.
  const shelf = nav().getByRole("button", { name: "Settled (14)" });
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");
  await shelf.click();
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  const currentRow = nav().getByRole("button", { name: /^task settled-13/ });
  await expect.element(currentRow).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(visibleIn(currentRow.element(), shelfBox())).toBe(true));

  await nav().getByRole("button", { name: "Show more", exact: true }).click();
  await vi.waitFor(() => expect(taskRowsIn(shelfBox())).toHaveLength(8));
  // The explicit action, not the selection, decides what the box shows; the row stays selected.
  const appended = taskRowsIn(shelfBox()).slice(4);
  await vi.waitFor(() => expect(appended.every((item) => visibleIn(item, shelfBox()))).toBe(true));
  await expect.element(currentRow).toHaveAttribute("aria-current", "true");

  // A later selection change still reveals the selected row, even if Show more scrolled it away.
  await rendered.rerender(select({ taskId: "settled-2" }));
  const next = nav().getByRole("button", { name: /^task settled-2/ });
  await expect.element(next).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(visibleIn(next.element(), shelfBox())).toBe(true));
});

test("a composer's collapsed group stays with that composer while a project's collapse persists", async () => {
  const tree = buildWorkspaceTree(
    [project("p1"), project("p2")],
    [task("a"), { ...task("b"), projectId: "p2" }],
    defaultSessions,
    [],
  );
  const spies = handlers();
  const sidebar = (composing?: { project?: Project; opened: number }) => (
    <div className="flex h-screen flex-col">
      <Sidebar
        tree={tree}
        selection={resolveSelection(tree, { taskId: "a" })}
        composing={composing}
        config={config}
        {...spies}
      />
      <div aria-hidden className="h-(--chrome-row) shrink-0" />
    </div>
  );
  const composer = (opened: number) => ({ project: project("p2"), opened });

  // The composer's group is keyed by its open; collapsing it stays with that composer.
  const first = await render(sidebar(composer(1)));
  const p2 = nav().getByRole("button", { name: "repo-p2" });
  await expect.element(p2).toHaveAttribute("aria-expanded", "true");
  await p2.click();
  await expect.element(p2).toHaveAttribute("aria-expanded", "false");
  expect(JSON.parse(window.localStorage.getItem("corral.sidebar-collapsed") ?? "null")).toEqual([]);
  await first.unmount();

  // A new composer is a new open: it opens its group instead of inheriting the old collapse.
  const second = await render(sidebar(composer(2)));
  await expect
    .element(nav().getByRole("button", { name: "repo-p2" }))
    .toHaveAttribute("aria-expanded", "true");
  await second.unmount();

  // A plain project group is a device preference and survives the remount.
  const third = await render(sidebar(undefined));
  const p1 = nav().getByRole("button", { name: "repo-p1" });
  await p1.click();
  await expect.element(p1).toHaveAttribute("aria-expanded", "false");
  expect(JSON.parse(window.localStorage.getItem("corral.sidebar-collapsed") ?? "null")).toEqual([
    "p1",
  ]);
  await third.unmount();
  await render(sidebar(undefined));
  await expect
    .element(nav().getByRole("button", { name: "repo-p1" }))
    .toHaveAttribute("aria-expanded", "false");
});

test("an oversized stored page is clamped instead of mounting every settled row", async () => {
  window.localStorage.setItem(
    "corral.sidebar-shelf",
    JSON.stringify({ expanded: true, page: 999_999 }),
  );
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    ...task(`deep-${index}`, "settled"),
    createdAt: index,
  }));
  await renderSidebar({ taskId: "deep-99" }, [], tasks).rendered;

  await expect
    .element(nav().getByRole("button", { name: "Settled (100)" }))
    .toHaveAttribute("aria-expanded", "true");
  // A stored page cannot claim the whole history; four rows per page at this window.
  await vi.waitFor(() => expect(taskRowsIn(shelfBox())).toHaveLength(SHELF_MAX_PAGES * 4));
  // The user can still append pages from the clamped preference.
  await nav().getByRole("button", { name: "Show more", exact: true }).click();
  await vi.waitFor(() => expect(taskRowsIn(shelfBox())).toHaveLength(SHELF_MAX_PAGES * 4 + 4));
});

test("collapsed groups and the shelf page survive hiding the sidebar and a reload", async () => {
  const tasks = [
    task("a"),
    { ...task("b"), projectId: "p2" },
    ...Array.from({ length: 12 }, (_, index) => ({
      ...task(`settled-${index}`, "settled"),
      createdAt: index + 1,
    })),
  ];
  const first = renderSidebar({ taskId: "a" }, [], tasks);
  const firstView = await first.rendered;
  const header = nav().getByRole("button", { name: "repo-p2" });
  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  await nav().getByRole("button", { name: "Settled (12)" }).click();
  await nav().getByRole("button", { name: "Show more", exact: true }).click();
  await vi.waitFor(() => expect(taskRowsIn(shelfBox())).toHaveLength(8));
  expect(JSON.parse(window.localStorage.getItem("corral.sidebar-collapsed") ?? "null")).toEqual([
    "p2",
  ]);
  expect(JSON.parse(window.localStorage.getItem("corral.sidebar-shelf") ?? "null")).toEqual({
    expanded: true,
    page: 2,
  });

  // Hiding the sidebar unmounts it; mounting again reads the device state back.
  await firstView.unmount();
  await renderSidebar({ taskId: "a" }, [], tasks).rendered;
  await expect
    .element(nav().getByRole("button", { name: "repo-p2" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(nav().getByRole("button", { name: "Settled (12)" }))
    .toHaveAttribute("aria-expanded", "true");
  expect(taskRowsIn(shelfBox())).toHaveLength(8);
});

test("a corrupt device record falls back to the defaults instead of breaking the list", async () => {
  window.localStorage.setItem("corral.sidebar-collapsed", "not json");
  window.localStorage.setItem("corral.sidebar-shelf", '{"expanded":"yes","page":0}');
  await renderSidebar().rendered;

  await expect
    .element(nav().getByRole("button", { name: "repo-p1" }))
    .toHaveAttribute("aria-expanded", "true");
  const shelf = nav().getByRole("button", { name: "Settled (1)" });
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");
  await expect.element(shelf).toBeEnabled();
});

test("a collapsed group holding the current task shows that row alone", async () => {
  await renderSidebar({ taskId: "a", entryId: "s2" }).rendered;
  const header = nav().getByRole("button", { name: "repo-p1" });

  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  // The control is enabled, and the current row stays visible inside the closed group.
  await expect.element(header).toBeEnabled();
  await expect.element(row("task a")).toHaveAttribute("aria-current", "true");
  await expect.element(row("task b")).not.toBeInTheDocument();

  await header.click();
  await expect.element(row("task b")).toBeVisible();
});

test("the current row is the task or loose terminal, never a project or Scratch", async () => {
  const taskState = renderSidebar({ taskId: "a", entryId: "s2" });
  const taskScreen = await taskState.rendered;
  expect(nav().element().querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  await expect.element(row("task a")).toHaveAttribute("aria-current", "true");
  for (const container of ["repo-p1", "repo-p2", "Scratch"])
    expect(
      nav().getByRole("button", { name: container }).element().getAttribute("aria-current"),
    ).toBeNull();
  await taskScreen.unmount();

  const looseState = renderSidebar({ taskId: null, entryId: "loose" });
  const looseScreen = await looseState.rendered;
  expect(nav().element().querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  await expect
    .element(nav().getByRole("button", { name: /^sh · / }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(nav().getByRole("button", { name: "Scratch" }))
    .not.toHaveAttribute("aria-current");
  await looseScreen.unmount();

  // While a project's composer is open the sidebar and the composer read one value: no row is
  // current, and the composer's project is the group shown open.
  const composingState = renderSidebar(
    { taskId: "a", entryId: "s2" },
    defaultSessions,
    [task("a"), task("old", "settled"), { ...task("b"), projectId: "p2" }],
    false,
    "project",
    { project: project("p2"), opened: 1 },
  );
  await composingState.rendered;
  expect(nav().element().querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  await expect
    .element(nav().getByRole("button", { name: "repo-p2" }))
    .toHaveAttribute("aria-expanded", "true");
});

test("the current task is marked", async () => {
  await renderSidebar({ taskId: "a", entryId: "s2" }).rendered;

  await expect.element(row("task a")).toHaveAttribute("aria-current", "true");
});

test("the header offers task search with its chord and a new task button", async () => {
  const { rendered, handlers: spies } = renderSidebar();
  await rendered;

  await expect
    .element(nav().getByRole("button", { name: "Search tasks" }))
    .toHaveAttribute("title", "Search tasks · alt+a f");
  await nav().getByRole("button", { name: "Search tasks" }).click();
  expect(spies.onFindTask).toHaveBeenCalledOnce();

  await nav().getByRole("button", { name: "New task" }).click();
  expect(spies.onNewTask).toHaveBeenCalledOnce();
});

test("a project group's header offers a new task in that project", async () => {
  const { rendered, handlers: spies } = renderSidebar();
  await rendered;

  await nav().getByRole("button", { name: "New task in repo-p2" }).click();
  expect(spies.onNewTask).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "p2" }),
    expect.any(HTMLButtonElement),
  );
});

test("the project action overlays the count at 208 px and is keyboard reachable", async () => {
  const { rendered } = renderSidebar({}, defaultSessions, undefined, true);
  await rendered;
  const header = nav().getByRole("button", { name: "repo-p1" });
  const rowBox = header.element().parentElement;
  if (!rowBox) throw new Error("the project header has no row");
  expect(rowBox.getBoundingClientRect().width).toBe(208);

  // One disclosure control: the row itself. No separate collapse button returns.
  await expect.element(nav().getByRole("button", { name: /^Collapse / })).not.toBeInTheDocument();
  // The whole row is the disclosure button; the add action is not a flex sibling.
  expect(header.element().getBoundingClientRect().width).toBeCloseTo(
    rowBox.getBoundingClientRect().width,
    0,
  );
  const add = nav().getByRole("button", { name: "New task in repo-p1" });
  const action = add.element().parentElement;
  if (!action) throw new Error("the project action has no wrapper");
  expect(getComputedStyle(action).opacity).toBe("0");

  // Tab from the header reaches the action; focus shows it over the count, which hides without
  // leaving the layout: the name and the row do not move.
  const name = header.element().querySelector(".truncate");
  if (!name) throw new Error("the project name is not mounted");
  const before = name.getBoundingClientRect().width;
  const count = header.element().lastElementChild;
  if (count === null) throw new Error("the project count is not mounted");
  const countBox = count.getBoundingClientRect();
  header.element().focus();
  await userEvent.keyboard("{Tab}");
  await expect.element(add).toHaveFocus();
  await expect.poll(() => getComputedStyle(action).opacity).toBe("1");
  expect(getComputedStyle(count).visibility).toBe("hidden");
  const actionBox = action.getBoundingClientRect();
  // The action sits at the row's right edge and covers the count's place.
  expect(actionBox.right).toBeCloseTo(rowBox.getBoundingClientRect().right, 0);
  expect(actionBox.left).toBeLessThanOrEqual(countBox.left);
  expect(actionBox.right).toBeGreaterThanOrEqual(countBox.right);
  expect(name.getBoundingClientRect().width).toBeCloseTo(before, 0);
  expect(header.element().getBoundingClientRect().height).toBe(
    rowBox.getBoundingClientRect().height,
  );
});

test("opening a composer opens the composer's project group", async () => {
  const tree = buildWorkspaceTree([project("p1"), project("p2")], [task("a")], defaultSessions, []);
  const spies = handlers();
  const sidebar = (composing?: { project?: Project; opened: number }) => (
    <Sidebar
      tree={tree}
      selection={resolveSelection(tree, { taskId: "a" })}
      composing={composing}
      config={config}
      {...spies}
    />
  );
  const rendered = await render(sidebar());
  const header = nav().getByRole("button", { name: "repo-p1" });

  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  await rendered.rerender(sidebar({ project: project("p1"), opened: 1 }));
  await expect.element(header).toHaveAttribute("aria-expanded", "true");
  expect(nav().element().querySelectorAll('[aria-current="true"]')).toHaveLength(0);
});

test("clicking reports what was picked", async () => {
  const { rendered, handlers: spies } = renderSidebar();
  await rendered;

  await row("task b").click();
  expect(spies.onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

  // The project row is its group's disclosure, not a navigation: it reports no selection.
  await nav().getByRole("button", { name: "repo-p2" }).click();
  expect(spies.onSelectTask).toHaveBeenCalledOnce();

  await row("task a").click();
  await row("task a").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  expect(spies.onToggleSettle).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

  await row("task b").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  expect(spies.onRemoveTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

  await nav()
    .getByRole("button", { name: /^sh · / })
    .click();
  expect(spies.onSelectTerminal).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "terminal", id: "loose" }),
  );

  await nav()
    .getByRole("button", { name: /^sh · / })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close terminal…" }).click();
  expect(spies.onCloseTerminal).toHaveBeenCalledWith("loose");
});

test("a task's context menu renames with its row as the dialog's opener", async () => {
  const { rendered, handlers: spies } = renderSidebar();
  await rendered;
  const menu = row("task a");

  await menu.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename task…" }).click();

  expect(spies.onRenameTask).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "a" }),
    menu.element(),
  );
});

test("a row's menu is gone before the next row opens its own", async () => {
  const { rendered, handlers: spies } = renderSidebar();
  await rendered;

  await row("task a").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  expect(spies.onToggleSettle).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

  // Deliberately no wait for the first popup to leave the document before the next one opens.
  await row("task b").click({ button: "right" });
  expect(page.getByRole("menu").elements()).toHaveLength(1);
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  expect(spies.onRemoveTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
});

const reporting = (base: Session, status: NonNullable<Session["status"]>): Session => ({
  ...base,
  status,
});

test("the settled shelf keeps one order across grouping modes, so toggling leaves a row in place", async () => {
  const sessions = [
    reporting(session("s0", "active", "claude"), { state: "working", updatedAt: 1 }),
    reporting(session("s1", "settled-newest", "claude"), { state: "done", updatedAt: 90 }),
    reporting(session("s2", "settled-middle", "codex"), { state: "done", updatedAt: 60 }),
    // The oldest row is blocked: urgency rank would put it first, activity order puts it last.
    reporting(session("s3", "settled-oldest", "pi"), { state: "blocked", updatedAt: 20 }),
  ];
  const tasks = [
    task("active"),
    { ...task("settled-oldest", "settled"), projectId: "p1", createdAt: 400 },
    { ...task("settled-newest", "settled"), projectId: "p1", createdAt: 100 },
    { ...task("settled-middle", "settled"), projectId: "p2", createdAt: 300 },
  ];
  const fixture = (mode: SidebarMode) => (
    <ShelfFixture
      initialTasks={tasks}
      sessions={sessions}
      mode={mode}
      chosen={{ taskId: "active" }}
    />
  );
  const rendered = await render(fixture("project"));
  const shelf = nav().getByRole("button", { name: "Settled (3)" });
  await shelf.click();
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  const expected = ["settled-newest", "settled-middle", "settled-oldest"];
  await vi.waitFor(() => expect(shelfTitles()).toEqual(expected));

  // `prefix l` is this swap. Both modes show the same rows in the same places, twice over.
  await rendered.rerender(fixture("flat"));
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() => expect(shelfTitles()).toEqual(expected));
  await rendered.rerender(fixture("project"));
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() => expect(shelfTitles()).toEqual(expected));
});

test("settling a done task from a row menu counts it and places it by recent activity", async () => {
  const sessions = [
    reporting(session("s1", "other", "shell"), { state: "working", updatedAt: 5 }),
    reporting(session("s2", "fresh", "claude"), { state: "done", updatedAt: 100 }),
    reporting(session("s3", "settled-middle", "pi"), { state: "done", updatedAt: 70 }),
    reporting(session("s4", "settled-old", "codex"), { state: "done", updatedAt: 50 }),
  ];
  const tasks = [
    task("other"),
    // `fresh` reports done; a statusless settle would fall back to creation (recorded limit).
    task("fresh"),
    { ...task("settled-old", "settled"), projectId: "p1", createdAt: 500 },
    { ...task("settled-middle", "settled"), projectId: "p2", createdAt: 600 },
  ];
  await render(
    <ShelfFixture
      initialTasks={tasks}
      sessions={sessions}
      mode="project"
      chosen={{ taskId: "other" }}
    />,
  );
  const shelf = nav().getByRole("button", { name: "Settled (2)" });
  await shelf.click();
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  expect(shelfTitles()).toEqual(["settled-middle", "settled-old"]);

  await row("task fresh").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settle task" }).click();

  const settled = nav().getByRole("button", { name: "Settled (3)" });
  await expect.element(settled).toBeVisible();
  await expect.element(settled).toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() => expect(shelfTitles()).toEqual(["fresh", "settled-middle", "settled-old"]));
  // The newest row is on the first measured page, not behind Show more.
  expect(visibleIn(taskRowsIn(shelfBox())[0]!, shelfBox())).toBe(true);
});

test("a task shows its most urgent session status with a text alternative and the message on hover", async () => {
  await renderSidebar({}, [
    session("s1", "a", "shell"),
    reporting(session("s2", "a", "claude"), {
      state: "blocked",
      kind: "permission",
      message: "Run rm -rf build?",
      updatedAt: 1,
    }),
    reporting(session("s3", "a", "codex"), { state: "working", updatedAt: 2 }),
    reporting(session("s4", "b", "pi"), { state: "working", updatedAt: 3 }),
  ]).rendered;

  // Task a takes blocked, the most urgent of its sessions; task b is working.
  await expect.element(nav().getByRole("img", { name: "blocked · permission" })).toHaveLength(1);
  await expect.element(nav().getByRole("img", { name: "working" })).toHaveLength(1);
  await expect
    .element(nav().getByRole("img", { name: "blocked · permission" }))
    .toHaveAttribute("title", "blocked · permission: Run rm -rf build?");
  await expect.element(row("task b")).not.toHaveAttribute("title");
});

test("a stopped session keeps only the done or error status it had", async () => {
  await renderSidebar({}, [
    reporting(session("s1", "a", "claude", "stopped"), { state: "done", updatedAt: 1 }),
    reporting(session("s3", "b", "codex", "stopped"), { state: "working", updatedAt: 2 }),
  ]).rendered;

  await expect.element(nav().getByRole("img", { name: "done" })).toHaveLength(1);
  await expect.element(nav().getByRole("img", { name: "working" })).not.toBeInTheDocument();
});

test("a collapsed project shows its count and expands again from its header", async () => {
  const tasks = [task("a"), { ...task("b"), projectId: "p2" }, task("old", "settled")];
  await renderSidebar({}, defaultSessions, tasks).rendered;
  const header = nav().getByRole("button", { name: "repo-p2" });
  await expect.element(header).toHaveAttribute("aria-expanded", "true");

  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  await expect.element(row("task b")).not.toBeInTheDocument();
  await expect.element(header).toMatchTextContent("1");

  await header.click();
  await expect.element(row("task b")).toBeVisible();
  await expect.element(header).toHaveAttribute("aria-expanded", "true");
});

test("every icon action is named and its tooltip carries the effective binding", async () => {
  await renderSidebar().rendered;
  const newTask = nav().getByRole("button", { name: "New task" });
  newTask.element().focus();

  await expect.element(page.getByRole("tooltip")).toHaveLength(1);
  await expect.element(page.getByRole("tooltip")).toMatchTextContent("New task · alt+a t");
  await expect
    .element(nav().getByRole("button", { name: "New task in repo-p1" }))
    .toHaveAttribute("aria-label", "New task in repo-p1");

  const text = nav().element().textContent ?? "";
  for (const glyph of ["▾", "▴", "×", "■", "▶"]) expect(text).not.toContain(glyph);
});

test("a long task title truncates, and the full title and second line stay on focus", async () => {
  const longTitle =
    "Investigate the very long running login regression across every environment and browser " +
    "while keeping every previous task title, branch and session readable in a narrow sidebar";
  const longBranch = "feature/a-very-long-shared-prefix-that-eats-the-row/login";
  await renderSidebar(
    { taskId: "a", entryId: "s1" },
    [session("s1", "a", "shell")],
    [{ ...task("a"), title: longTitle, branch: longBranch }],
    true,
  ).rendered;

  const button = nav().getByRole("button", { name: new RegExp(`^${longTitle}`) });
  // The title and the second line are wider than their spans: both clip instead of wrapping.
  const clipped = [...button.element().querySelectorAll(".truncate")].filter(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(clipped).toHaveLength(2);
  expect(button.element().textContent).toContain(longBranch);

  button.element().focus();
  await expect.element(page.getByRole("tooltip")).toMatchTextContent(longTitle);
  await expect.element(page.getByRole("tooltip")).toMatchTextContent(longBranch);
});

test("a loose terminal shows the name the user gave it instead of its command and folder", async () => {
  const tree = buildWorkspaceTree(
    [project("p1")],
    [],
    [],
    [terminal("loose", null, null, "build logs")],
  );
  await render(
    <Sidebar
      tree={tree}
      selection={resolveSelection(tree, { taskId: null, entryId: "loose" })}
      config={config}
      {...handlers()}
    />,
  );

  await expect.element(nav().getByRole("button", { name: "build logs" })).toBeVisible();
  await nav().getByRole("button", { name: "build logs" }).click({ button: "right" });
  await expect.element(page.getByRole("menuitem", { name: "Close terminal…" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: /^sh · / })).not.toBeInTheDocument();
});

const taskWithStatus = (id: string, projectId: string, seenAt: number | null = null): Task => ({
  ...task(id),
  projectId,
  seenAt,
});

const flatSessions = [
  reporting(session("s1", "blocked", "claude"), {
    state: "blocked",
    kind: "permission",
    message: "Run rm -rf build?",
    updatedAt: 1,
  }),
  reporting(session("s2", "error", "codex"), { state: "error", updatedAt: 2 }),
  reporting(session("s3", "working", "pi"), { state: "working", updatedAt: 3 }),
  reporting(session("s4", "unseen", "claude"), { state: "done", updatedAt: 4 }),
  reporting(session("s5", "seen", "claude"), { state: "done", updatedAt: 5 }),
  reporting(session("s6", "idle", "pi"), { state: "idle", updatedAt: 6 }),
];

const flatTasks = [
  taskWithStatus("blocked", "p1"),
  taskWithStatus("error", "p1"),
  taskWithStatus("working", "p2"),
  taskWithStatus("unseen", "p2"),
  taskWithStatus("seen", "p1", 5),
  taskWithStatus("idle", "p2"),
];

test("flat mode lists every project's tasks by status, each row naming its project", async () => {
  await renderSidebar({}, flatSessions, flatTasks, false, "flat").rendered;

  // No project tree any more: sections carry the list.
  await expect.element(nav().getByRole("button", { name: "repo-p1" })).not.toBeInTheDocument();
  const headings = nav().getByRole("heading");
  await expect.element(headings).toHaveLength(3);
  await expect.element(headings.nth(0)).toMatchTextContent(/Needs you/);
  await expect.element(headings.nth(1)).toMatchTextContent(/Working/);
  await expect.element(headings.nth(2)).toMatchTextContent(/Done/);

  // The accessible name carries the second line, which the button's own label overrides.
  const names = nav()
    .getByRole("button", { name: /^task / })
    .elements()
    .map((element) => element.getAttribute("aria-label") ?? "");
  // Needs approval or input, error, working, completed and unseen; then the Done section's
  // newest-first order puts the idle task before the done task the user has already seen.
  expect(names).toEqual([
    "task blocked — repo-p1 · branch-blocked · claude",
    "task error — repo-p1 · branch-error · codex",
    "task working — repo-p2 · branch-working · pi",
    "task unseen — repo-p2 · branch-unseen · claude",
    "task idle — repo-p2 · branch-idle · pi",
    "task seen — repo-p1 · branch-seen · claude",
  ]);

  // The right slot still says what a task needs; its state is announced by the status glyph.
  await expect
    .element(nav().getByRole("button", { name: /^task blocked/ }))
    .toMatchTextContent(/needs approval/);
  await expect
    .element(nav().getByRole("button", { name: /^task error/ }))
    .toMatchTextContent(/error/);

  // A done task is marked unseen until its status is older than what the user saw.
  await expect.element(nav().getByRole("img", { name: "unseen" })).toHaveLength(1);
});

test("flat mode keeps settled tasks on a collapsed shelf until it is opened", async () => {
  await renderSidebar({}, defaultSessions, undefined, false, "flat").rendered;

  const toggle = nav().getByRole("button", { name: "Settled (1)" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(row("task old")).not.toBeInTheDocument();

  await toggle.click();
  await expect.element(row("task old")).toBeVisible();
});

test("clicking a flat row reports the task it names", async () => {
  const { rendered, handlers: spies } = renderSidebar(
    {},
    defaultSessions,
    undefined,
    false,
    "flat",
  );
  await rendered;

  await row("task b").click();
  expect(spies.onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
});

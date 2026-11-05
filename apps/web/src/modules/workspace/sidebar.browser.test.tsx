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
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { Sidebar } from "./sidebar.tsx";

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
    <div className={narrow ? "w-60" : undefined}>
      <Sidebar
        tree={tree}
        selection={resolveSelection(tree, chosen)}
        composing={composing}
        flat={mode === "flat" ? buildFlatSidebar(tree) : undefined}
        config={config}
        {...spies}
      />
    </div>,
  );
  return { rendered, handlers: spies };
}

const nav = () => page.getByRole("navigation", { name: "workspace" });
const row = (title: string) => nav().getByRole("button", { name: new RegExp(`^${title}`) });

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

test("one bottom shelf contains settled tasks from every project and reveals them in bounded pages", async () => {
  const tasks = [
    task("current"),
    ...Array.from({ length: 14 }, (_, index) => ({
      ...task(`settled-${index}`, "settled"),
      projectId: index % 2 === 0 ? "p1" : "p2",
    })),
  ];
  await renderSidebar({ taskId: "current" }, [], tasks).rendered;
  const shelf = nav().getByRole("button", { name: "Settled (14)" });
  await shelf.click();
  expect(
    nav()
      .getByRole("button", { name: /^task settled-/ })
      .elements(),
  ).toHaveLength(6);
  await nav().getByRole("button", { name: "Show more", exact: true }).click();
  expect(
    nav()
      .getByRole("button", { name: /^task settled-/ })
      .elements(),
  ).toHaveLength(12);
  await nav().getByRole("button", { name: "Show more", exact: true }).click();
  expect(
    nav()
      .getByRole("button", { name: /^task settled-/ })
      .elements(),
  ).toHaveLength(14);
  await expect
    .element(nav().getByRole("button", { name: "Show more", exact: true }))
    .not.toBeInTheDocument();
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

test("the project action overlays the count without taking a slot from the row", async () => {
  const { rendered } = renderSidebar({}, defaultSessions, undefined, true);
  await rendered;
  const header = nav().getByRole("button", { name: "repo-p1" });
  const rowBox = header.element().parentElement;
  if (!rowBox) throw new Error("the project header has no row");

  // The whole row is the disclosure button; the add action is not a flex sibling.
  expect(header.element().getBoundingClientRect().width).toBeCloseTo(
    rowBox.getBoundingClientRect().width,
    0,
  );
  const add = nav().getByRole("button", { name: "New task in repo-p1" });
  const action = add.element().parentElement;
  if (!action) throw new Error("the project action has no wrapper");
  expect(getComputedStyle(action).opacity).toBe("0");

  // Hovering shows the action over the count, which hides without leaving the layout: the name
  // and the row do not move.
  const name = header.element().querySelector(".truncate");
  if (!name) throw new Error("the project name is not mounted");
  const before = name.getBoundingClientRect().width;
  await userEvent.hover(header.element());
  await expect.poll(() => getComputedStyle(action).opacity).toBe("1");
  const count = header.element().lastElementChild;
  if (count === null) throw new Error("the project count is not mounted");
  expect(getComputedStyle(count).visibility).toBe("hidden");
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

test("flat mode keeps settled tasks on a collapsed shelf that opens itself for the current one", async () => {
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

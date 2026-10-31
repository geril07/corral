import {
  buildWorkspaceTree,
  resolveSelection,
  type Chosen,
  type Entry,
  type SidebarMode,
} from "@corral/client/workspace-tree";
import { DEFAULT_BINDINGS, DEFAULT_PREFIX, type ClientConfig } from "@corral/protocol/config";
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
  keys: { prefix: DEFAULT_PREFIX, bindings: { ...DEFAULT_BINDINGS } },
};

function renderSidebar(
  chosen: Chosen = {},
  sessions: Session[] = defaultSessions,
  tasks: Task[] = [task("a"), task("b"), task("old", "settled")],
  narrow = false,
  mode: SidebarMode = "project",
) {
  const tree = buildWorkspaceTree([project("p1"), project("p2")], tasks, sessions, [
    terminal("term-s1", "a", "s1"),
    terminal("term-s2", "a", "s2"),
    terminal("loose", null, null),
  ]);
  const handlers = {
    onSelectProject: vi.fn<(project: Project) => void>(),
    onSelectTask: vi.fn<(task: Task) => void>(),
    onSelectLoose: vi.fn<() => void>(),
    onSelectEntry: vi.fn<(entry: Entry) => void>(),
    onCloseTerminal: vi.fn<(id: string) => void>(),
    onStopSession: vi.fn<(session: Session) => void>(),
    onRestartSession: vi.fn<(session: Session) => void>(),
    onRemoveSession: vi.fn<(session: Session) => void>(),
    onRenameEntry: vi.fn<(entry: Entry) => void>(),
    onToggleSettle: vi.fn<(task: Task) => void>(),
    onRemoveTask: vi.fn<(task: Task) => void>(),
    onRenameTask: vi.fn<(task: Task) => void>(),
    onAddProject: vi.fn<() => void>(),
    onNewTask: vi.fn<() => void>(),
    onNewTerminal: vi.fn<() => void>(),
    onNewAgent: vi.fn<() => void>(),
    onOpenPalette: vi.fn<() => void>(),
    onOpenBoard: vi.fn<() => void>(),
    onFindTask: vi.fn<() => void>(),
  };
  const rendered = render(
    <div className={narrow ? "w-60" : undefined}>
      <Sidebar
        tree={tree}
        selection={resolveSelection(tree, chosen)}
        mode={mode}
        config={config}
        {...handlers}
      />
    </div>,
  );
  return { rendered, handlers };
}

const nav = () => page.getByRole("navigation", { name: "workspace" });

const sessionButton = (kind: string, state?: string) =>
  nav().getByRole("button", { name: state ? `${kind} ${state}` : new RegExp(`^${kind}$`) });

test("projects list their active tasks, each with its sessions; loose terminals sit under No task", async () => {
  await renderSidebar().rendered;

  await expect.element(nav().getByRole("button", { name: "repo-p1" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "repo-p2" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: /^task a/ })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: /^task b/ })).toBeVisible();
  await expect.element(sessionButton("shell")).toBeVisible();
  await expect.element(sessionButton("claude")).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "No task" })).toBeVisible();
  await expect.element(nav().getByRole("button", { name: /^sh · / })).toBeVisible();
});

test("two sessions of one kind in a task are numbered after the first", async () => {
  await renderSidebar({}, [session("s1", "a", "shell"), session("s2", "a", "shell")]).rendered;

  await expect.element(sessionButton("shell")).toBeVisible();
  await expect.element(nav().getByRole("button", { name: "shell 2" })).toBeVisible();
});

test("a session that is not running says so, and an unresumable one says why on hover", async () => {
  await renderSidebar().rendered;
  await nav().getByRole("button", { name: "Expand sessions for task b" }).click();

  await expect.element(sessionButton("codex", "stopped")).toBeVisible();
  await expect
    .element(sessionButton("pi", "unresumable"))
    .toHaveAttribute("title", expect.stringContaining("new conversation"));
  await expect.element(sessionButton("claude")).not.toHaveAttribute("title");
});

test("settled tasks stay collapsed until the group is opened", async () => {
  await renderSidebar().rendered;
  const toggle = nav().getByRole("button", { name: "Settled (1)" });

  // The toggle is one full-width row like a task row, not a shrink-wrapped label.
  const row = toggle.element().parentElement;
  if (!row) throw new Error("the settled toggle has no row");
  expect(toggle.element().getBoundingClientRect().width).toBeCloseTo(
    row.getBoundingClientRect().width,
    0,
  );

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

test("the current task and session are marked", async () => {
  await renderSidebar({ taskId: "a", entryId: "s2" }).rendered;

  await expect
    .element(nav().getByRole("button", { name: /^task a/ }))
    .toHaveAttribute("aria-current", "true");
  await expect.element(sessionButton("claude")).toHaveAttribute("aria-current", "true");
  await expect.element(sessionButton("shell")).not.toHaveAttribute("aria-current");
});

test("clicking reports what was picked", async () => {
  const { rendered, handlers } = renderSidebar();
  await rendered;

  await sessionButton("claude").click();
  expect(handlers.onSelectEntry).toHaveBeenCalledWith(
    expect.objectContaining({ type: "session", id: "s2" }),
  );

  await nav()
    .getByRole("button", { name: /^sh · / })
    .click();
  expect(handlers.onSelectEntry).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "terminal", id: "loose" }),
  );

  await nav()
    .getByRole("button", { name: /^task b/ })
    .click();
  expect(handlers.onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

  await nav().getByRole("button", { name: "repo-p2" }).click();
  expect(handlers.onSelectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "p2" }));

  await nav().getByRole("button", { name: "Task actions for task a" }).click();
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  expect(handlers.onToggleSettle).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

  // Opening the next row's menu must leave exactly one: the settled task's popup is gone by then.
  await nav().getByRole("button", { name: "Task actions for task b" }).click();
  expect(page.getByRole("menu").elements()).toHaveLength(1);
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  expect(handlers.onRemoveTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

  await nav().getByRole("button", { name: "stop claude" }).click();
  expect(handlers.onStopSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));

  await nav().getByRole("button", { name: "restart codex" }).click();
  expect(handlers.onRestartSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s3" }));

  await nav().getByRole("button", { name: "Session actions for shell" }).click();
  await page.getByRole("menuitem", { name: "Remove session…" }).click();
  expect(handlers.onRemoveSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));

  await nav()
    .getByRole("button", { name: /^Terminal actions for sh · / })
    .click();
  await page.getByRole("menuitem", { name: "Close terminal…" }).click();
  expect(handlers.onCloseTerminal).toHaveBeenCalledWith("loose");

  const toolbar = nav().getByRole("toolbar", { name: "Workspace actions" });
  await toolbar.getByRole("button", { name: "Add project" }).click();
  await toolbar.getByRole("button", { name: "New task" }).click();
  await toolbar.getByRole("button", { name: "New terminal" }).click();
  await toolbar.getByRole("button", { name: "New agent session" }).click();
  await toolbar.getByRole("button", { name: "Find task" }).click();
  await toolbar.getByRole("button", { name: "Command palette" }).click();
  await toolbar.getByRole("button", { name: "Open board" }).click();
  expect(handlers.onAddProject).toHaveBeenCalledOnce();
  expect(handlers.onNewTask).toHaveBeenCalledOnce();
  expect(handlers.onNewTerminal).toHaveBeenCalledOnce();
  expect(handlers.onNewAgent).toHaveBeenCalledOnce();
  expect(handlers.onFindTask).toHaveBeenCalledOnce();
  expect(handlers.onOpenPalette).toHaveBeenCalledOnce();
  expect(handlers.onOpenBoard).toHaveBeenCalledOnce();
});

test("a task's menu offers rename with the menu button as the dialog's opener", async () => {
  const { rendered, handlers } = renderSidebar();
  await rendered;
  const menu = nav().getByRole("button", { name: "Task actions for task a" });

  await menu.click();
  await page.getByRole("menuitem", { name: "Rename task…" }).click();

  expect(handlers.onRenameTask).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "a" }),
    menu.element(),
  );
});

test("a row's menu is gone before the next row opens its own", async () => {
  const { rendered, handlers } = renderSidebar();
  await rendered;

  await nav().getByRole("button", { name: "Task actions for task a" }).click();
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  expect(handlers.onToggleSettle).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

  // Deliberately no wait for the first popup to leave the document before the next one opens.
  await nav().getByRole("button", { name: "Task actions for task b" }).click();
  expect(page.getByRole("menu").elements()).toHaveLength(1);
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  expect(handlers.onRemoveTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
});

test("Enter on the selected session that is not running starts it again; on a running one it does not", async () => {
  const { rendered, handlers } = renderSidebar({ taskId: "a", entryId: "s3" });
  await rendered;

  const stopped = sessionButton("codex", "stopped");
  await expect.element(stopped).toHaveAttribute("aria-current", "true");
  stopped.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(handlers.onRestartSession).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "s3" }),
  );

  const running = sessionButton("claude");
  running.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(handlers.onRestartSession).toHaveBeenCalledOnce();
  expect(handlers.onSelectEntry).toHaveBeenCalledWith(
    expect.objectContaining({ type: "session", id: "s2" }),
  );
});

test("Enter on a stopped session that is not the selected one only selects it", async () => {
  const { rendered, handlers } = renderSidebar({ taskId: "a", entryId: "s1" });
  await rendered;

  sessionButton("codex", "stopped").element().focus();
  await userEvent.keyboard("{Enter}");

  expect(handlers.onRestartSession).not.toHaveBeenCalled();
  expect(handlers.onSelectEntry).toHaveBeenCalledWith(
    expect.objectContaining({ type: "session", id: "s3" }),
  );
});

const reporting = (base: Session, status: NonNullable<Session["status"]>): Session => ({
  ...base,
  status,
});

test("sessions and tasks show their agent status with a text alternative and the message on hover", async () => {
  await renderSidebar({}, [
    session("s1", "a", "shell"),
    reporting(session("s2", "a", "claude"), {
      state: "blocked",
      kind: "permission",
      message: "Run rm -rf build?",
      updatedAt: 1,
    }),
    reporting(session("s3", "a", "codex"), { state: "working", updatedAt: 2 }),
    reporting(session("s4", "b", "pi"), { state: "idle", updatedAt: 3 }),
  ]).rendered;
  await nav().getByRole("button", { name: "Expand sessions for task b" }).click();

  // The task takes the most urgent of its sessions' statuses; the sessions show their own.
  const status = (name: string) => nav().getByRole("img", { name });
  await expect.element(status("blocked · permission")).toHaveLength(2);
  await expect.element(status("working")).toHaveLength(1);
  await expect.element(status("idle")).toHaveLength(2);
  await expect.element(sessionButton("claude")).toHaveAttribute("title", "Run rm -rf build?");
  await expect
    .element(nav().getByRole("button", { name: /^task a/ }))
    .toHaveAttribute("title", "Run rm -rf build?");
  await expect.element(sessionButton("shell")).not.toHaveAttribute("title");
});

test("a stopped session shows only the done or error it kept, and a stale working is dropped", async () => {
  await renderSidebar({}, [
    reporting(session("s1", "a", "claude", "stopped"), { state: "done", updatedAt: 1 }),
    reporting(session("s3", "a", "codex", "stopped"), { state: "working", updatedAt: 2 }),
  ]).rendered;

  await expect.element(nav().getByRole("img", { name: "done" })).toHaveLength(2);
  await expect.element(nav().getByRole("img", { name: "working" })).not.toBeInTheDocument();
});

test("a collapsed project shows its count and expands again from its header", async () => {
  const tasks = [task("a"), { ...task("b"), projectId: "p2" }, task("old", "settled")];
  await renderSidebar({}, defaultSessions, tasks).rendered;
  await nav().getByRole("button", { name: "Collapse repo-p2" }).click();
  await expect
    .element(nav().getByRole("button", { name: "Expand repo-p2" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect.element(nav().getByRole("button", { name: /^task b/ })).not.toBeInTheDocument();
  await expect.element(nav().getByRole("button", { name: "repo-p2" })).toMatchTextContent("1");

  await nav().getByRole("button", { name: "repo-p2" }).click();
  await expect.element(nav().getByRole("button", { name: /^task b/ })).toBeVisible();
});

test("the current task's sessions stay open and another task's expand on demand", async () => {
  await renderSidebar({ taskId: "a", entryId: "s1" }).rendered;
  await expect.element(sessionButton("shell")).toBeVisible();
  await expect.element(sessionButton("pi", "unresumable")).not.toBeInTheDocument();

  await nav().getByRole("button", { name: "Expand sessions for task b" }).click();
  await expect.element(sessionButton("pi", "unresumable")).toBeVisible();
  await nav().getByRole("button", { name: "Collapse sessions for task b" }).click();
  await expect.element(sessionButton("pi", "unresumable")).not.toBeInTheDocument();

  // The selected task's disclosure stays open and cannot be collapsed under the selection.
  await expect
    .element(nav().getByRole("button", { name: "Collapse sessions for task a" }))
    .toBeDisabled();
});

test("every icon action is named and its tooltip carries the effective binding", async () => {
  await renderSidebar().rendered;
  const toolbar = nav().getByRole("toolbar", { name: "Workspace actions" });
  const terminalButton = toolbar.getByRole("button", { name: "New terminal" });
  terminalButton.element().focus();

  await expect.element(page.getByRole("tooltip")).toHaveLength(1);
  await expect.element(page.getByRole("tooltip")).toMatchTextContent("New terminal · alt+a c");
  await expect
    .element(toolbar.getByRole("button", { name: "Command palette" }))
    .toHaveAttribute("aria-label", "Command palette");

  const text = nav().element().textContent ?? "";
  for (const glyph of ["▾", "▴", "×", "■", "▶"]) expect(text).not.toContain(glyph);
});

test("a long task title end-truncates and a long branch middle-truncates, with the full value on focus", async () => {
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

  const button = nav().getByRole("button", { name: longTitle });
  await expect.element(button).toMatchTextContent(/…/);
  const spans = button.element().querySelectorAll("span");
  const titleSpan = spans[0];
  const branchSpan = spans[1];
  if (!titleSpan || !branchSpan) throw new Error("task row spans are missing");
  expect(branchSpan.textContent?.length).toBeGreaterThan(2);
  expect(branchSpan.getBoundingClientRect().width).toBeGreaterThan(20);
  expect(titleSpan.getBoundingClientRect().width).toBeGreaterThan(
    branchSpan.getBoundingClientRect().width,
  );

  button.element().focus();
  await expect.element(page.getByRole("tooltip")).toMatchTextContent(longTitle);
  await expect.element(page.getByRole("tooltip")).toMatchTextContent(longBranch);
});

test("only the selected entry offers rename, in its overflow, and it names the entry", async () => {
  const { rendered, handlers } = renderSidebar({ taskId: "a", entryId: "s2" });
  await rendered;

  await nav().getByRole("button", { name: "Session actions for shell" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  await nav().getByRole("button", { name: "Session actions for claude" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  expect(handlers.onRenameEntry).toHaveBeenCalledWith(
    expect.objectContaining({ type: "session", id: "s2" }),
  );
});

test("a loose terminal shows the name the user gave it instead of its command and folder", async () => {
  const tree = buildWorkspaceTree(
    [project("p1")],
    [],
    [],
    [terminal("loose", null, null, "build logs")],
  );
  const handlers = {
    onSelectProject: vi.fn<(project: Project) => void>(),
    onSelectTask: vi.fn<(task: Task) => void>(),
    onSelectLoose: vi.fn<() => void>(),
    onSelectEntry: vi.fn<(entry: Entry) => void>(),
    onCloseTerminal: vi.fn<(id: string) => void>(),
    onStopSession: vi.fn<(session: Session) => void>(),
    onRestartSession: vi.fn<(session: Session) => void>(),
    onRemoveSession: vi.fn<(session: Session) => void>(),
    onRenameEntry: vi.fn<(entry: Entry) => void>(),
    onToggleSettle: vi.fn<(task: Task) => void>(),
    onRemoveTask: vi.fn<(task: Task) => void>(),
    onRenameTask: vi.fn<(task: Task) => void>(),
    onAddProject: vi.fn<() => void>(),
    onNewTask: vi.fn<() => void>(),
    onNewTerminal: vi.fn<() => void>(),
    onNewAgent: vi.fn<() => void>(),
    onOpenPalette: vi.fn<() => void>(),
    onOpenBoard: vi.fn<() => void>(),
    onFindTask: vi.fn<() => void>(),
  };
  await render(
    <Sidebar
      tree={tree}
      selection={resolveSelection(tree, { taskId: null, entryId: "loose" })}
      mode="project"
      config={config}
      {...handlers}
    />,
  );

  await expect.element(nav().getByRole("button", { name: "build logs" })).toBeVisible();
  await expect
    .element(nav().getByRole("button", { name: "Terminal actions for build logs" }))
    .toBeVisible();
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

  const text = nav().element().textContent ?? "";
  const at = (id: string) => text.indexOf(`task ${id}`);
  // Needs approval or input, error, working, completed and unseen; then the Done section's
  // newest-first order puts the idle task before the done task the user has already seen.
  expect(at("blocked")).toBeLessThan(at("error"));
  expect(at("error")).toBeLessThan(at("working"));
  expect(at("working")).toBeLessThan(at("unseen"));
  expect(at("unseen")).toBeLessThan(at("idle"));
  expect(at("idle")).toBeLessThan(at("seen"));

  // Each row's second line names its project; the right slot says what the task needs.
  await expect
    .element(nav().getByRole("button", { name: /^task unseen/ }))
    .toMatchTextContent(/repo-p2/);
  await expect
    .element(nav().getByRole("button", { name: /^task blocked/ }))
    .toMatchTextContent(/needs approval/);
  await expect
    .element(nav().getByRole("button", { name: /^task error/ }))
    .toMatchTextContent(/error/);

  // A done task is marked unseen until its status is older than what the user saw.
  await expect.element(nav().getByRole("img", { name: "unseen" })).toHaveLength(1);
  await expect
    .element(nav().getByRole("button", { name: /^task unseen/ }))
    .toMatchTextContent(/claude/);
});

test("a flat row is the two-line 52 px task row, with its sessions under the selected task only", async () => {
  await renderSidebar({ taskId: "a", entryId: "s1" }, defaultSessions, undefined, false, "flat")
    .rendered;

  const row = nav()
    .getByRole("button", { name: /^task a/ })
    .element();
  expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(52);

  await expect.element(sessionButton("shell")).toBeVisible();
  await expect
    .element(nav().getByRole("button", { name: /Expand sessions/ }))
    .not.toBeInTheDocument();
  await expect.element(sessionButton("pi", "unresumable")).not.toBeInTheDocument();
});

test("flat mode keeps settled tasks on a collapsed shelf that opens itself for the current one", async () => {
  await renderSidebar({}, defaultSessions, undefined, false, "flat").rendered;

  const toggle = nav().getByRole("button", { name: "Settled (1)" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(nav().getByRole("button", { name: /^task old/ })).not.toBeInTheDocument();

  await toggle.click();
  await expect.element(nav().getByRole("button", { name: /^task old/ })).toBeVisible();
});

test("clicking a flat row reports the task it names", async () => {
  const { rendered, handlers } = renderSidebar({}, defaultSessions, undefined, false, "flat");
  await rendered;

  await nav()
    .getByRole("button", { name: /^task b/ })
    .click();
  expect(handlers.onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
});

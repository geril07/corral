import {
  buildWorkspaceTree,
  resolveSelection,
  type Chosen,
  type Entry,
} from "@corral/client/workspace-tree";
import type { Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
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
const terminal = (id: string, taskId: string | null, sessionId: string | null): TerminalInfo => ({
  id,
  taskId,
  sessionId,
  command: "/bin/sh",
  args: [],
  cwd: `/work/${taskId ?? "home"}`,
  size: { cols: 80, rows: 24 },
  exit: null,
});

const defaultSessions = [
  session("s1", "a", "shell"),
  session("s2", "a", "claude"),
  session("s3", "a", "codex", "stopped"),
  session("s4", "b", "pi", "unresumable"),
];

function renderSidebar(chosen: Chosen = {}, sessions: Session[] = defaultSessions) {
  const tree = buildWorkspaceTree(
    [project("p1"), project("p2")],
    [task("a"), task("b"), task("old", "settled")],
    sessions,
    [terminal("term-s1", "a", "s1"), terminal("term-s2", "a", "s2"), terminal("loose", null, null)],
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
    onToggleSettle: vi.fn<(task: Task) => void>(),
    onRemoveTask: vi.fn<(task: Task) => void>(),
    onAddProject: vi.fn<() => void>(),
    onNewTask: vi.fn<() => void>(),
    onNewTerminal: vi.fn<() => void>(),
    onNewAgent: vi.fn<() => void>(),
  };
  const rendered = render(
    <Sidebar tree={tree} selection={resolveSelection(tree, chosen)} {...handlers} />,
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

test("a session that is not running says so, and an unresumable one says why on hover", async () => {
  await renderSidebar().rendered;

  await expect.element(sessionButton("codex", "stopped")).toBeVisible();
  await expect
    .element(sessionButton("pi", "unresumable"))
    .toHaveAttribute("title", expect.stringContaining("new conversation"));
  await expect.element(sessionButton("claude")).not.toHaveAttribute("title");
});

test("settled tasks stay collapsed until the group is opened", async () => {
  await renderSidebar().rendered;
  const toggle = nav().getByRole("button", { name: "Settled (1)" });

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

  await nav().getByRole("button", { name: "settle task a" }).click();
  expect(handlers.onToggleSettle).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

  await nav().getByRole("button", { name: "remove task task b" }).click();
  expect(handlers.onRemoveTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));

  await nav().getByRole("button", { name: "stop claude" }).click();
  expect(handlers.onStopSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));

  await nav().getByRole("button", { name: "restart codex" }).click();
  expect(handlers.onRestartSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s3" }));

  await nav().getByRole("button", { name: "remove shell" }).click();
  expect(handlers.onRemoveSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));

  await nav()
    .getByRole("button", { name: /^close sh · / })
    .click();
  expect(handlers.onCloseTerminal).toHaveBeenCalledWith("loose");

  await nav().getByRole("button", { name: "Add project" }).click();
  await nav().getByRole("button", { name: "New task" }).click();
  await nav().getByRole("button", { name: "New terminal" }).click();
  await nav().getByRole("button", { name: "New agent" }).click();
  expect(handlers.onAddProject).toHaveBeenCalledOnce();
  expect(handlers.onNewTask).toHaveBeenCalledOnce();
  expect(handlers.onNewTerminal).toHaveBeenCalledOnce();
  expect(handlers.onNewAgent).toHaveBeenCalledOnce();
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

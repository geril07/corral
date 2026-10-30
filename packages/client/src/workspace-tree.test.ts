import type { Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import {
  buildWorkspaceTree,
  currentEntry,
  entriesOf,
  resolveSelection,
  tasksInOrder,
} from "./workspace-tree.ts";

const project = (id: string): Project => ({
  id,
  name: id,
  path: `/repos/${id}`,
  defaultBaseBranch: "main",
});
const task = (id: string, projectId: string, state: Task["state"] = "active"): Task => ({
  id,
  projectId,
  title: id,
  branch: id,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state,
  createdAt: 0,
});
const session = (
  id: string,
  taskId: string,
  terminalId: string | null,
  createdAt = 0,
  state: Session["state"] = terminalId === null ? "stopped" : "running",
): Session => ({ id, taskId, kind: "shell", agentSessionId: null, terminalId, state, createdAt });
const terminal = (id: string, taskId: string | null, sessionId: string | null): TerminalInfo => ({
  id,
  taskId,
  sessionId,
  command: "/bin/sh",
  args: [],
  cwd: "/",
  size: { cols: 80, rows: 24 },
  exit: null,
});

const projects = [project("p1"), project("p2")];
const tasks = [task("t1", "p1"), task("t2", "p1", "archived"), task("t3", "p1"), task("t4", "p2")];
const sessions = [
  session("sa", "t1", "a", 2),
  session("sb", "t3", "b"),
  session("sd", "t1", "d", 1),
  session("sx", "t1", null, 3),
  session("orphan", "gone", "o"),
];
const terminals = [
  terminal("a", "t1", "sa"),
  terminal("b", "t3", "sb"),
  terminal("c", null, null),
  terminal("d", "t1", "sd"),
  terminal("o", "gone", "orphan"),
];
const tree = buildWorkspaceTree(projects, tasks, sessions, terminals);

test("the tree groups sessions under tasks and tasks under projects, active before archived", () => {
  expect(tree.projects.map((node) => node.active.map((n) => n.task.id))).toEqual([
    ["t1", "t3"],
    ["t4"],
  ]);
  expect(tree.projects[0]?.archived.map((n) => n.task.id)).toEqual(["t2"]);
  expect(tree.loose.map((entry) => entry.id)).toEqual(["c"]);
  expect(tasksInOrder(tree).map((t) => t.id)).toEqual(["t1", "t3", "t2", "t4"]);
});

test("a task lists its sessions in creation order, each with its terminal if it has one", () => {
  const entries = tree.projects[0]?.active[0]?.sessions ?? [];
  expect(entries.map((entry) => [entry.id, entry.terminal?.id])).toEqual([
    ["sd", "d"],
    ["sa", "a"],
    ["sx", undefined],
  ]);
});

test("a session whose terminal has not arrived yet has no terminal", () => {
  const late = buildWorkspaceTree(projects, tasks, [session("s", "t1", "later")], []);
  expect(late.projects[0]?.active[0]?.sessions.map((entry) => entry.terminal)).toEqual([undefined]);
});

test("a session whose task has not arrived yet is not listed anywhere", () => {
  const shown = tree.projects.flatMap((node) =>
    [...node.active, ...node.archived].flatMap((n) => n.sessions.map((entry) => entry.id)),
  );
  expect(shown).not.toContain("orphan");
  expect(tree.loose.map((entry) => entry.id)).not.toContain("o");
});

test("with nothing chosen the first task of the first project is current, at its first session", () => {
  expect(resolveSelection(tree, {})).toEqual({ projectId: "p1", taskId: "t1", entryId: "sd" });
});

test("a chosen task and session stay current; the project follows the task", () => {
  expect(resolveSelection(tree, { taskId: "t4" })).toEqual({
    projectId: "p2",
    taskId: "t4",
    entryId: undefined,
  });
  expect(resolveSelection(tree, { taskId: "t1", entryId: "sx" }).entryId).toBe("sx");
});

test("a session that is not in the current task is replaced by the task's first one", () => {
  expect(resolveSelection(tree, { taskId: "t3", entryId: "sa" }).entryId).toBe("sb");
});

test("a chosen project selects its first task, or no task when it has none", () => {
  expect(resolveSelection(tree, { projectId: "p2" })).toMatchObject({
    projectId: "p2",
    taskId: "t4",
  });
  const bare = buildWorkspaceTree([project("empty")], [], [], terminals);
  expect(resolveSelection(bare, { projectId: "empty" })).toEqual({
    projectId: "empty",
    taskId: null,
    entryId: "c",
  });
});

test("a task that no longer exists falls back, while the no-task group can be chosen", () => {
  expect(resolveSelection(tree, { taskId: "removed" }).taskId).toBe("t1");
  expect(resolveSelection(tree, { taskId: null })).toEqual({
    projectId: "p1",
    taskId: null,
    entryId: "c",
  });
});

test("without projects the loose terminals are all there is", () => {
  const plain = buildWorkspaceTree(
    [],
    [],
    [],
    [terminal("x", null, null), terminal("y", null, null)],
  );
  expect(resolveSelection(plain, {})).toEqual({
    projectId: undefined,
    taskId: null,
    entryId: "x",
  });
  expect(entriesOf(plain, null).map((entry) => entry.id)).toEqual(["x", "y"]);
});

test("the current entry is the selected session or loose terminal, even a stopped one", () => {
  const stopped = currentEntry(tree, resolveSelection(tree, { taskId: "t1", entryId: "sx" }));
  expect(stopped).toMatchObject({ type: "session", id: "sx", terminal: undefined });
  expect(currentEntry(tree, resolveSelection(tree, { taskId: null }))).toMatchObject({
    type: "terminal",
    id: "c",
  });
  expect(currentEntry(tree, resolveSelection(tree, { taskId: "t4" }))).toBeUndefined();
});

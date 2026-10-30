import type { Project, Task, TerminalInfo } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import {
  buildWorkspaceTree,
  resolveSelection,
  tasksInOrder,
  terminalsOf,
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
const terminal = (id: string, taskId: string | null): TerminalInfo => ({
  id,
  taskId,
  command: "/bin/sh",
  args: [],
  cwd: "/",
  size: { cols: 80, rows: 24 },
  exit: null,
});

const projects = [project("p1"), project("p2")];
const tasks = [task("t1", "p1"), task("t2", "p1", "archived"), task("t3", "p1"), task("t4", "p2")];
const terminals = [
  terminal("a", "t1"),
  terminal("b", "t3"),
  terminal("c", null),
  terminal("d", "t1"),
  terminal("orphan", "gone"),
];
const tree = buildWorkspaceTree(projects, tasks, terminals);

test("the tree groups terminals under tasks and tasks under projects, active before archived", () => {
  expect(tree.projects.map((node) => node.active.map((n) => n.task.id))).toEqual([
    ["t1", "t3"],
    ["t4"],
  ]);
  expect(tree.projects[0]?.archived.map((n) => n.task.id)).toEqual(["t2"]);
  expect(tree.projects[0]?.active[0]?.terminals.map((t) => t.id)).toEqual(["a", "d"]);
  expect(tree.loose.map((t) => t.id)).toEqual(["c"]);
  expect(tasksInOrder(tree).map((t) => t.id)).toEqual(["t1", "t3", "t2", "t4"]);
});

test("a terminal whose task has not arrived yet is not listed anywhere", () => {
  const shown = [
    ...tree.loose,
    ...tree.projects.flatMap((node) =>
      [...node.active, ...node.archived].flatMap((n) => n.terminals),
    ),
  ];
  expect(shown.map((t) => t.id)).not.toContain("orphan");
});

test("with nothing chosen the first task of the first project is current", () => {
  expect(resolveSelection(tree, {})).toEqual({ projectId: "p1", taskId: "t1", terminalId: "a" });
});

test("a chosen task and terminal stay current; the project follows the task", () => {
  expect(resolveSelection(tree, { taskId: "t4" })).toEqual({
    projectId: "p2",
    taskId: "t4",
    terminalId: undefined,
  });
  expect(resolveSelection(tree, { taskId: "t1", terminalId: "d" }).terminalId).toBe("d");
});

test("a terminal that is not in the current task is replaced by the task's first one", () => {
  expect(resolveSelection(tree, { taskId: "t3", terminalId: "a" }).terminalId).toBe("b");
});

test("a chosen project selects its first task, or no task when it has none", () => {
  expect(resolveSelection(tree, { projectId: "p2" })).toMatchObject({
    projectId: "p2",
    taskId: "t4",
  });
  const bare = buildWorkspaceTree([project("empty")], [], terminals);
  expect(resolveSelection(bare, { projectId: "empty" })).toEqual({
    projectId: "empty",
    taskId: null,
    terminalId: "c",
  });
});

test("a task that no longer exists falls back, while the no-task group can be chosen", () => {
  expect(resolveSelection(tree, { taskId: "removed" }).taskId).toBe("t1");
  expect(resolveSelection(tree, { taskId: null })).toEqual({
    projectId: "p1",
    taskId: null,
    terminalId: "c",
  });
});

test("without projects the loose terminals are all there is", () => {
  const plain = buildWorkspaceTree([], [], [terminal("x", null), terminal("y", null)]);
  expect(resolveSelection(plain, {})).toEqual({
    projectId: undefined,
    taskId: null,
    terminalId: "x",
  });
  expect(terminalsOf(plain, null).map((t) => t.id)).toEqual(["x", "y"]);
});

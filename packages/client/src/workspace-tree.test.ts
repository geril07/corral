import type { Project, Session, Task, TerminalInfo } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import {
  buildFlatSidebar,
  buildWorkspaceTree,
  currentEntry,
  entriesOf,
  flatTaskOrder,
  resolveSelection,
  tasksInOrder,
} from "./workspace-tree.ts";

const reported = (
  id: string,
  taskId: string,
  state: NonNullable<Session["status"]>["state"],
  updatedAt: number,
): Session => ({
  ...session(id, taskId, `term-${id}`),
  status: { state, updatedAt },
});

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
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: id,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state,
  seenAt: null,
  createdAt: 0,
});
const session = (
  id: string,
  taskId: string,
  terminalId: string | null,
  createdAt = 0,
  state: Session["state"] = terminalId === null ? "stopped" : "running",
): Session => ({
  id,
  taskId,
  kind: "shell",
  agentSessionId: null,
  terminalId,
  state,
  status: null,
  createdAt,
});
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
const tasks = [task("t1", "p1"), task("t2", "p1", "settled"), task("t3", "p1"), task("t4", "p2")];
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

test("the tree groups sessions under tasks and tasks under projects, active before settled", () => {
  expect(tree.projects.map((node) => node.active.map((n) => n.task.id))).toEqual([
    ["t1", "t3"],
    ["t4"],
  ]);
  expect(tree.projects[0]?.settled.map((n) => n.task.id)).toEqual(["t2"]);
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
    [...node.active, ...node.settled].flatMap((n) => n.sessions.map((entry) => entry.id)),
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

/** One task per status, plus the ones that tie inside a rank, spread over two projects. */
const flatTree = (() => {
  const flatTasks = [
    { ...task("blocked-old", "p1"), seenAt: null },
    { ...task("blocked-new", "p1"), seenAt: null },
    { ...task("error", "p2"), seenAt: null },
    { ...task("working", "p1"), seenAt: null },
    { ...task("unseen-done", "p1"), seenAt: null },
    { ...task("unseen-done-p2", "p2"), seenAt: null },
    { ...task("idle", "p1"), seenAt: null },
    { ...task("seen-done", "p1"), seenAt: 60 },
    { ...task("stale-done", "p2"), seenAt: 100 },
    { ...task("plain", "p1"), seenAt: null },
    { ...task("settled-blocked", "p1", "settled"), seenAt: null },
  ];
  const flatSessions = [
    reported("sb1", "blocked-old", "blocked", 10),
    reported("sb2", "blocked-new", "blocked", 30),
    reported("se", "error", "error", 20),
    reported("sw", "working", "working", 40),
    reported("su1", "unseen-done", "done", 50),
    reported("su2", "unseen-done-p2", "done", 45),
    reported("si", "idle", "idle", 70),
    reported("ss", "seen-done", "done", 60),
    reported("st", "stale-done", "done", 55),
    reported("sx", "plain", "idle", 0),
    reported("ssb", "settled-blocked", "blocked", 80),
  ];
  // The plain task runs nothing that reports.
  return buildWorkspaceTree(
    [project("p1"), project("p2")],
    flatTasks,
    flatSessions.filter((each) => each.taskId !== "plain"),
    [],
  );
})();

test("flat mode sorts the active tasks of every project by status, then recency", () => {
  const flat = buildFlatSidebar(flatTree);

  expect(
    flat.sections.map((section) => [section.kind, section.tasks.map((row) => row.task.id)]),
  ).toEqual([
    ["needs-you", ["blocked-new", "blocked-old", "error"]],
    ["working", ["working"]],
    ["done", ["unseen-done", "unseen-done-p2", "idle", "seen-done", "stale-done", "plain"]],
  ]);
  expect(flatTaskOrder(flat).map((each) => each.id)).toEqual([
    "blocked-new",
    "blocked-old",
    "error",
    "working",
    "unseen-done",
    "unseen-done-p2",
    "idle",
    "seen-done",
    "stale-done",
    "plain",
    "settled-blocked",
  ]);
  // Every row knows the project its second line names.
  expect(flat.sections[0]?.tasks.find((row) => row.task.id === "error")?.project.id).toBe("p2");
});

test("flat mode marks only a done update newer than the task's seenAt as unseen", () => {
  const flat = buildFlatSidebar(flatTree);
  expect(
    flat.sections.flatMap((section) => section.tasks).map((row) => [row.task.id, row.unseen]),
  ).toEqual([
    ["blocked-new", false],
    ["blocked-old", false],
    ["error", false],
    ["working", false],
    ["unseen-done", true],
    ["unseen-done-p2", true],
    ["idle", false],
    ["seen-done", false],
    ["stale-done", false],
    ["plain", false],
  ]);
});

test("flat mode keeps settled tasks on their own shelf, cancelled from the sections", () => {
  const flat = buildFlatSidebar(flatTree);
  expect(flat.settled.map((row) => row.task.id)).toEqual(["settled-blocked"]);
  expect(flat.sections.flatMap((section) => section.tasks.map((row) => row.task.id))).not.toContain(
    "settled-blocked",
  );
});

test("a flat row without a status is ordered by its own age, the time its row shows", () => {
  const withStatusless = buildWorkspaceTree(
    [project("p1")],
    [
      { ...task("old-idle", "p1"), seenAt: null, createdAt: 1 },
      { ...task("fresh", "p1"), seenAt: null, createdAt: 5_000 },
    ],
    [reported("si", "old-idle", "idle", 900)],
    [],
  );
  const flat = buildFlatSidebar(withStatusless);
  expect(flat.sections[0]?.tasks.map((row) => row.task.id)).toEqual(["fresh", "old-idle"]);
});

test("empty flat sections are left out", () => {
  const quiet = buildWorkspaceTree(
    [project("p1")],
    [{ ...task("idle", "p1"), seenAt: null }],
    [],
    [],
  );
  const flat = buildFlatSidebar(quiet);
  expect(flat.sections.map((section) => section.kind)).toEqual(["done"]);
  expect(flat.settled).toEqual([]);
});

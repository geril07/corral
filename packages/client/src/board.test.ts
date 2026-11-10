import type { AgentState, Project, Session, Task } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { buildBoard, mostUrgentBlocked } from "./board.ts";
import { buildWorkspaceTree } from "./workspace-tree.ts";

const project = (id: string): Project => ({
  id,
  name: id,
  path: `/repos/${id}`,
  defaultBaseBranch: "main",
  pinnedAt: null,
});
const task = (
  id: string,
  projectId: string,
  createdAt = 0,
  state: Task["state"] = "active",
): Task => ({
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
  createdAt,
});
const session = (
  id: string,
  taskId: string,
  reported?: { state: AgentState; updatedAt: number; message?: string },
  state: Session["state"] = "running",
): Session => ({
  id,
  taskId,
  kind: reported ? "claude" : "shell",
  view: "terminal",
  agentSessionId: null,
  terminalId: null,
  state,
  status: reported ?? null,
  createdAt: 0,
});

const tree = buildWorkspaceTree(
  [project("p1"), project("p2")],
  [
    task("idle", "p1"),
    task("working-old", "p1"),
    task("blocked-old", "p2"),
    task("blocked-new", "p1"),
    task("plain-old", "p2", 1),
    task("plain-new", "p1", 2),
    task("settled", "p1", 0, "settled"),
  ],
  [
    session("s-idle", "idle", { state: "idle", updatedAt: 90 }),
    session("s-working", "working-old", { state: "working", updatedAt: 10 }),
    session("s-blocked-old", "blocked-old", { state: "blocked", updatedAt: 20 }),
    session("s-blocked-new", "blocked-new", {
      state: "blocked",
      updatedAt: 30,
      message: "run rm?",
    }),
    session("s-quiet", "blocked-new", { state: "working", updatedAt: 99 }),
    session("sh", "plain-old"),
    session("s-settled", "settled", { state: "blocked", updatedAt: 100 }),
  ],
  [],
);

test("the board lists active tasks of every project, most urgent first, then most recently reported", () => {
  expect(buildBoard(tree).map((row) => row.task.id)).toEqual([
    "blocked-new",
    "blocked-old",
    "working-old",
    "idle",
    "plain-new",
    "plain-old",
  ]);
});

test("a row names the session that gives the task its status, and carries its message", () => {
  const rows = buildBoard(tree);
  const blocked = rows[0];
  expect(blocked?.project.id).toBe("p1");
  expect(blocked?.sessionId).toBe("s-blocked-new");
  expect(blocked?.status?.message).toBe("run rm?");
  const plain = rows.find((row) => row.task.id === "plain-old");
  expect(plain?.sessionId).toBeUndefined();
  expect(plain?.status).toBeUndefined();
});

test("jumping to blocked goes to the first blocked row, or nowhere", () => {
  expect(mostUrgentBlocked(buildBoard(tree))?.task.id).toBe("blocked-new");
  expect(mostUrgentBlocked(buildBoard(tree).filter((row) => row.status?.state !== "blocked"))).toBe(
    undefined,
  );
});

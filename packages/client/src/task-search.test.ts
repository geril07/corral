import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { searchTasks } from "./task-search.ts";

const project = (id: string, name = `repo-${id}`): Project => ({
  id,
  name,
  path: `/repos/${id}`,
  defaultBaseBranch: "main",
  pinnedAt: null,
});

const task = (
  id: string,
  title: string,
  options: {
    projectId?: string;
    branch?: string;
    state?: Task["state"];
    createdAt?: number;
  } = {},
): Task => ({
  id,
  projectId: options.projectId ?? "p1",
  title,
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: options.branch ?? `branch-${id}`,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state: options.state ?? "active",
  seenAt: null,
  createdAt: options.createdAt ?? 0,
});

const titles = (results: ReturnType<typeof searchTasks>) =>
  results.map(({ task: found }) => found.title);

test("an empty query browses active tasks before settled ones, newest first, then title and id", () => {
  const results = searchTasks(
    "",
    [project("p1")],
    [
      task("s1", "Settled newer", { state: "settled", createdAt: 30 }),
      task("a1", "Active older", { createdAt: 10 }),
      task("a2", "Active newer", { createdAt: 20 }),
      task("a3", "Active tie", { createdAt: 20 }),
      task("a4", "Active tie", { createdAt: 20 }),
      task("s2", "Settled older", { state: "settled", createdAt: 5 }),
    ],
  );

  expect(titles(results)).toEqual([
    "Active newer",
    "Active tie",
    "Active tie",
    "Active older",
    "Settled newer",
    "Settled older",
  ]);
});

test("a word matches the title, branch, project name or state, case-insensitively", () => {
  const projects = [project("p1", "Corral web"), project("p2", "Other")];
  const tasks = [
    task("a", "Fix LOGIN"),
    task("b", "Second", { branch: "feature/login" }),
    task("c", "Third", { projectId: "p1" }),
    task("d", "Fourth", { projectId: "p2", state: "settled" }),
    task("e", "Fifth", { projectId: "p2" }),
  ];

  expect(titles(searchTasks("login", projects, tasks))).toEqual(["Fix LOGIN", "Second"]);
  expect(titles(searchTasks("corral", projects, tasks))).toEqual(["Fix LOGIN", "Second", "Third"]);
  expect(titles(searchTasks("SETTLED", projects, tasks))).toEqual(["Fourth"]);
  expect(titles(searchTasks("nothing", projects, tasks))).toEqual([]);
});

test("every word must match somewhere: a multiword query is an AND", () => {
  const projects = [project("p1", "corral")];
  const tasks = [
    task("a", "Fix login flow"),
    task("b", "Fix logout flow"),
    task("c", "Login flow"),
  ];

  expect(titles(searchTasks("fix login", projects, tasks))).toEqual(["Fix login flow"]);
  expect(titles(searchTasks("flow fix", projects, tasks))).toEqual([
    "Fix login flow",
    "Fix logout flow",
  ]);
  expect(titles(searchTasks("login corral", projects, tasks))).toEqual([
    "Login flow",
    "Fix login flow",
  ]);
  expect(titles(searchTasks("fix   missing", projects, tasks))).toEqual([]);
});

test("title matches outrank branch matches, which outrank project matches", () => {
  const projects = [project("p1", "login"), project("p2", "other")];
  const tasks = [
    task("project", "A task", { projectId: "p1" }),
    task("branch", "Another task", { branch: "fix/login" }),
    task("title", "Login fix"),
  ];

  expect(titles(searchTasks("login", projects, tasks))).toEqual([
    "Login fix",
    "Another task",
    "A task",
  ]);
});

test("equal scores go to the newest task, then to a stable title and id order", () => {
  const projects = [project("p1")];
  const tasks = [
    task("b", "Login beta", { createdAt: 1 }),
    task("a", "Login alpha", { createdAt: 1 }),
    task("c", "Login gamma", { createdAt: 9 }),
  ];

  expect(titles(searchTasks("login", projects, tasks))).toEqual([
    "Login gamma",
    "Login alpha",
    "Login beta",
  ]);
});

test("a task whose project has not arrived is left out instead of crashing", () => {
  const results = searchTasks(
    "",
    [project("p1")],
    [
      task("known", "Known", { projectId: "p1" }),
      task("orphan", "Orphan", { projectId: "missing" }),
    ],
  );

  expect(titles(results)).toEqual(["Known"]);
});

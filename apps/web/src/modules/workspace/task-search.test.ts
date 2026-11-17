import type { VisualTaskRow } from "../../common/ui/index.ts";
import { expect, test } from "vite-plus/test";
import { searchTasks } from "./task-search.ts";

const row = (
  id: string,
  title: string,
  options: {
    project?: string;
    branch?: string;
    settled?: boolean;
  } = {},
): VisualTaskRow => {
  const project = options.project ?? "corral";
  return {
    id,
    title,
    project,
    projectInitial: project[0]!.toUpperCase(),
    workspacePath: `/work/${id}`,
    hasSource: false,
    ...(options.branch === undefined ? {} : { copyBranch: options.branch }),
    ...(options.settled === true ? { settled: true } : {}),
    metadata: {
      project,
      ...(options.branch === undefined ? {} : { branch: options.branch }),
    },
  };
};

const titles = (results: ReturnType<typeof searchTasks>) => results.map((found) => found.title);

test("an empty query keeps the caller's order, which is the sidebar's own", () => {
  const rows = [
    row("a2", "Active newer"),
    row("a1", "Active older"),
    row("s1", "Settled", { settled: true }),
  ];

  expect(titles(searchTasks("", rows))).toEqual(["Active newer", "Active older", "Settled"]);
});

test("a word matches the title, branch, project name or state, case-insensitively", () => {
  const rows = [
    row("a", "Fix LOGIN"),
    row("b", "Second", { branch: "feature/login" }),
    row("c", "Third"),
    row("d", "Fourth", { project: "other", settled: true }),
    row("e", "Fifth", { project: "other" }),
  ];

  expect(titles(searchTasks("login", rows))).toEqual(["Fix LOGIN", "Second"]);
  expect(titles(searchTasks("corral", rows))).toEqual(["Fix LOGIN", "Second", "Third"]);
  expect(titles(searchTasks("SETTLED", rows))).toEqual(["Fourth"]);
  expect(titles(searchTasks("nothing", rows))).toEqual([]);
});

test("every word must match somewhere: a multiword query is an AND", () => {
  const rows = [row("a", "Fix login flow"), row("b", "Fix logout flow"), row("c", "Login flow")];

  expect(titles(searchTasks("fix login", rows))).toEqual(["Fix login flow"]);
  expect(titles(searchTasks("flow fix", rows))).toEqual(["Fix login flow", "Fix logout flow"]);
  expect(titles(searchTasks("login corral", rows))).toEqual(["Login flow", "Fix login flow"]);
  expect(titles(searchTasks("fix   missing", rows))).toEqual([]);
});

test("a title word start outranks a title substring, which outranks branch and project", () => {
  const rows = [
    row("project", "A task", { project: "login" }),
    row("branch", "Another task", { branch: "fix/login" }),
    row("middle", "Relogin"),
    row("title", "Login fix"),
  ];

  expect(titles(searchTasks("login", rows))).toEqual([
    "Login fix",
    "Relogin",
    "Another task",
    "A task",
  ]);
});

test("equal scores keep the caller's order instead of re-sorting by age", () => {
  const rows = [row("b", "Login beta"), row("a", "Login alpha"), row("c", "Login gamma")];

  expect(titles(searchTasks("login", rows))).toEqual(["Login beta", "Login alpha", "Login gamma"]);
});

test("a scratch row answers by its title or branch, and no project word finds it", () => {
  const rows = [
    row("a2", "Scratch active", { project: "No project", branch: "fix/login" }),
    row("s1", "Scratch settled", { project: "No project", settled: true }),
  ];

  expect(titles(searchTasks("scratch", rows))).toEqual(["Scratch active", "Scratch settled"]);
  expect(titles(searchTasks("login", rows))).toEqual(["Scratch active"]);
  expect(titles(searchTasks("settled corral", rows))).toEqual([]);
});

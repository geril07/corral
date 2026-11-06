import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { initRepo, runGit } from "../../test/git-repo.ts";
import { disabledNaming } from "../naming/naming.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TerminalCloseFailedError } from "../sessions/errors.ts";
import { openDatabase } from "../storage/database.ts";
import { defaultTaskSettings } from "./task-settings.ts";
import { TaskService, type TaskSessions } from "./task-service.ts";
import { TaskStore } from "./task-store.ts";

let root: string;
let databases: DatabaseSync[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corral-task-"));
  databases = [];
});
afterEach(async () => {
  for (const db of databases) db.close();
  await rm(root, { recursive: true, force: true });
});

const localBranches = (repo: string) =>
  runGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .filter(Boolean);
const worktreePaths = (repo: string) =>
  runGit(repo, "worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));

/**
 * The real stores and real git, with the sessions boundary under the test's control. Every
 * workspace handed to `closeTerminalsIn` is recorded, so a removal can be checked for the sweep it
 * ran (and did not run).
 */
function service(repo: string, closeTerminalsIn: (workspacePath: string) => Promise<void>) {
  const dataDir = join(root, "data");
  const db = openDatabase(dataDir);
  databases.push(db);
  const projects = new ProjectStore(db);
  projects.insert({ id: "p", name: "app", path: repo, defaultBaseBranch: "main" });
  const closed: string[] = [];
  const sessions: TaskSessions = {
    hasRunningIn: () => false,
    removeAllIn: () => Promise.resolve(),
    closeTerminalsIn: (workspacePath) => {
      closed.push(workspacePath);
      return closeTerminalsIn(workspacePath);
    },
    suspendAllIn: () => Promise.resolve(),
    resumeAllIn: () => Promise.resolve(),
    startPrimary: () => {
      throw new Error("a creation without an agent starts no session");
    },
    hasChatDriver: () => false,
  };
  const tasks = new TaskService({
    store: new TaskStore(db),
    projects,
    sessions,
    settings: defaultTaskSettings({ dataDir }),
    naming: disabledNaming(),
  });
  return { tasks, closed };
}

test("removing a worktree task closes the terminals in its workspace before the worktree goes", async () => {
  const repo = initRepo(join(root, "repo"));
  let presentAtClose: boolean | undefined;
  const { tasks, closed } = service(repo, (workspacePath) => {
    // The order the removal promises: the sweep runs while the directory and its git entry exist.
    presentAtClose = existsSync(workspacePath) && worktreePaths(repo).includes(workspacePath);
    return Promise.resolve();
  });
  const task = await tasks.create({
    projectId: "p",
    title: "Sweep",
    workspace: { type: "new-branch" },
  });

  await tasks.remove(task.id, false);

  expect(presentAtClose).toBe(true);
  expect(closed).toEqual([task.workspacePath]);
  expect(existsSync(task.workspacePath)).toBe(false);
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(localBranches(repo)).toContain("sweep");
  expect(tasks.list()).toEqual([]);
});

test("a worktree already gone outside Corral is still swept before git forgets it", async () => {
  const repo = initRepo(join(root, "repo"));
  const { tasks, closed } = service(repo, (workspacePath) => {
    // The directory is already gone, but a process may still hold it; the sweep must not skip.
    expect(existsSync(workspacePath)).toBe(false);
    return Promise.resolve();
  });
  const task = await tasks.create({
    projectId: "p",
    title: "Gone",
    workspace: { type: "new-branch" },
  });
  await rm(task.workspacePath, { recursive: true, force: true });

  await tasks.remove(task.id, false);

  expect(closed).toEqual([task.workspacePath]);
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(localBranches(repo)).toContain("gone");
  expect(tasks.list()).toEqual([]);
});

test("a main-worktree task closes no terminal in the project's own tree", async () => {
  const repo = initRepo(join(root, "repo"));
  const { tasks, closed } = service(repo, () => Promise.resolve());
  const task = await tasks.create({
    projectId: "p",
    title: "In place",
    workspace: { type: "main-worktree" },
  });

  await tasks.remove(task.id, false);

  expect(closed).toEqual([]);
  expect(existsSync(repo)).toBe(true);
  expect(tasks.list()).toEqual([]);
});

test("a terminal that does not close aborts the removal and leaves the task and its worktree", async () => {
  const repo = initRepo(join(root, "repo"));
  let workspacePath = "";
  const { tasks } = service(repo, () =>
    Promise.reject(
      new TerminalCloseFailedError(
        { id: "term-1", label: "api logs", cwd: workspacePath },
        new Error("the process did not exit"),
      ),
    ),
  );
  const task = await tasks.create({
    projectId: "p",
    title: "Stuck",
    workspace: { type: "new-branch" },
  });
  workspacePath = task.workspacePath;

  await expect(tasks.remove(task.id, false)).rejects.toThrow(
    `Could not close the terminal "api logs (term-1)" in ${task.workspacePath}`,
  );

  expect(tasks.list()).toEqual([task]);
  expect(existsSync(task.workspacePath)).toBe(true);
  expect(worktreePaths(repo)).toContain(task.workspacePath);
  expect(localBranches(repo)).toContain("stuck");
});

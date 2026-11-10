import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { cloneOfOrigin, initRepo, runGit } from "../../test/git-repo.ts";
import { GitError } from "../git/git.ts";
import { disabledNaming } from "../naming/naming.ts";
import { ProjectNotFoundError } from "../projects/errors.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { openDatabase } from "../storage/database.ts";
import { TaskService, type TaskSessions, type WorktreeOperations } from "./task-service.ts";
import { defaultTaskSettings } from "./task-settings.ts";
import { TaskStore } from "./task-store.ts";

let root: string;
let databases: DatabaseSync[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corral-undo-"));
  databases = [];
});
afterEach(async () => {
  for (const db of databases) db.close();
  await rm(root, { recursive: true, force: true });
});

const sessions: TaskSessions = {
  hasRunningIn: () => false,
  removeAllIn: () => Promise.resolve(),
  closeTerminalsIn: () => Promise.resolve(),
  suspendAllIn: () => Promise.resolve(),
  resumeAllIn: () => Promise.resolve(),
  startPrimary: () => {
    throw new Error("a creation without an agent starts no session");
  },
  hasChatDriver: () => false,
};

const localBranches = (repo: string) =>
  runGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .filter(Boolean);
const worktreePaths = (repo: string) =>
  runGit(repo, "worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));

/** The real stores on a temp database and real git, with the worktree operations under test control. */
function service(
  repo: string,
  worktree?: Partial<WorktreeOperations>,
  sessionsOverride: Partial<TaskSessions> = {},
) {
  const dataDir = join(root, "data");
  const db = openDatabase(dataDir);
  databases.push(db);
  const projects = new ProjectStore(db);
  projects.insert({ id: "p", name: "app", path: repo, defaultBaseBranch: "main" });
  const tasks = new TaskService({
    dataDir,
    store: new TaskStore(db),
    projects,
    sessions: { ...sessions, ...sessionsOverride },
    settings: defaultTaskSettings({ dataDir }),
    naming: disabledNaming(),
    ...(worktree === undefined ? {} : { worktree }),
  });
  return { tasks, projects };
}

test("a new branch another process created after planning survives the failed attempt", async () => {
  const repo = initRepo(join(root, "repo"));
  const { tasks } = service(repo, {
    async createBranch(repository, plan) {
      // The other process wins the same race git would refuse.
      runGit(repository, "branch", plan.branch);
      throw new GitError(`a branch named '${plan.branch}' already exists`);
    },
  });

  await expect(
    tasks.create({ projectId: "p", title: "Raced", workspace: { type: "new-branch" } }),
  ).rejects.toMatchObject({ message: "a branch named 'raced' already exists" });

  expect(localBranches(repo)).toContain("raced");
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(tasks.list()).toEqual([]);
});

test("a remote-tracking branch another process created after planning survives the failed attempt", async () => {
  const { clone } = cloneOfOrigin(join(root, "scratch"));
  const { tasks } = service(clone, {
    async createBranch(repository, plan) {
      runGit(repository, "branch", plan.branch);
      throw new GitError(`a branch named '${plan.branch}' already exists`);
    },
  });

  await expect(
    tasks.create({
      projectId: "p",
      title: "Release work",
      workspace: { type: "existing-branch", branch: "origin/release/1.0" },
    }),
  ).rejects.toMatchObject({ message: "a branch named 'release/1.0' already exists" });

  expect(localBranches(clone)).toContain("release/1.0");
  expect(worktreePaths(clone)).toEqual([clone]);
  expect(tasks.list()).toEqual([]);
});

test("a branch this attempt created is deleted when the worktree cannot be added", async () => {
  const repo = initRepo(join(root, "repo"));
  const { tasks } = service(repo, {
    addWorktree() {
      return Promise.reject(new GitError("could not add the worktree"));
    },
  });

  await expect(
    tasks.create({ projectId: "p", title: "Doomed", workspace: { type: "new-branch" } }),
  ).rejects.toMatchObject({ message: "could not add the worktree" });

  expect(localBranches(repo)).not.toContain("doomed");
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(tasks.list()).toEqual([]);
});

test("a project removed while the worktree is being added leaves no row, worktree or branch, and a retry makes one", async () => {
  const repo = initRepo(join(root, "repo"));
  let removed = false;
  const { tasks, projects } = service(repo, {
    async addWorktree(repository, path, plan) {
      runGit(repository, "worktree", "add", "--", path, plan.branch);
      // The other window removes the project after the first lookup and before the row.
      if (!removed) {
        removed = true;
        projects.delete("p");
      }
    },
  });
  const before = localBranches(repo);
  const hookedPath = join(root, "data", "worktrees", "app", "hooked");

  await expect(
    tasks.create({ projectId: "p", title: "Hooked", workspace: { type: "new-branch" } }),
  ).rejects.toBeInstanceOf(ProjectNotFoundError);

  expect(tasks.list()).toEqual([]);
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(localBranches(repo)).toEqual(before);
  expect(existsSync(hookedPath)).toBe(false);

  // The project comes back and the same create is retried: one worktree and one branch, no `-2`.
  projects.insert({ id: "p", name: "app", path: repo, defaultBaseBranch: "main" });
  const retried = await tasks.create({
    projectId: "p",
    title: "Hooked",
    workspace: { type: "new-branch" },
  });

  expect(retried.workspacePath).toBe(hookedPath);
  expect(worktreePaths(repo)).toEqual([repo, hookedPath]);
  expect(localBranches(repo).toSorted()).toEqual([...before, "hooked"].toSorted());
});

test("a pre-existing branch is never deleted when the create fails after the worktree exists", async () => {
  const repo = initRepo(join(root, "repo"));
  runGit(repo, "branch", "keep");
  const { tasks, projects } = service(repo, {
    async addWorktree(repository, path, plan) {
      runGit(repository, "worktree", "add", "--", path, plan.branch);
      projects.delete("p");
    },
  });

  await expect(
    tasks.create({
      projectId: "p",
      title: "Existing",
      workspace: { type: "existing-branch", branch: "keep" },
    }),
  ).rejects.toBeInstanceOf(ProjectNotFoundError);

  expect(localBranches(repo)).toEqual(["keep", "main"]);
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(tasks.list()).toEqual([]);
});

test("a primary session that throws after the row exists keeps the task, its worktree and its branch", async () => {
  const repo = initRepo(join(root, "repo"));
  const { tasks } = service(repo, undefined, {
    startPrimary: () => Promise.reject(new Error("the launch exploded")),
  });
  const updates = tasks.watch(undefined);
  expect((await updates.next()).value).toEqual([]);

  await expect(
    tasks.create({
      projectId: "p",
      title: "Kept",
      agent: { kind: "claude" },
      workspace: { type: "new-branch" },
    }),
  ).rejects.toThrow("the launch exploded");

  const [task] = tasks.list();
  expect(task).toMatchObject({ title: "Kept", branch: "kept", ownsWorktree: true });
  expect(existsSync(task!.workspacePath)).toBe(true);
  expect(worktreePaths(repo)).toContain(task!.workspacePath);
  expect(localBranches(repo)).toContain("kept");
  // The row is the user's now, so the feed names it even though the call failed.
  expect((await updates.next()).value).toHaveLength(1);
  await updates.return(undefined);
});

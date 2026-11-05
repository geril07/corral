import type { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { cloneOfOrigin, initRepo, runGit } from "../../test/git-repo.ts";
import { GitError } from "../git/git.ts";
import { disabledNaming } from "../naming/naming.ts";
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
function service(repo: string, worktree?: Partial<WorktreeOperations>) {
  const dataDir = join(root, "data");
  const db = openDatabase(dataDir);
  databases.push(db);
  const projects = new ProjectStore(db);
  projects.insert({ id: "p", name: "app", path: repo, defaultBaseBranch: "main" });
  const tasks = new TaskService({
    store: new TaskStore(db),
    projects,
    sessions,
    settings: defaultTaskSettings({ dataDir }),
    naming: disabledNaming(),
    ...(worktree === undefined ? {} : { worktree }),
  });
  return tasks;
}

test("a new branch another process created after planning survives the failed attempt", async () => {
  const repo = initRepo(join(root, "repo"));
  const tasks = service(repo, {
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
  const tasks = service(clone, {
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
  const tasks = service(repo, {
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

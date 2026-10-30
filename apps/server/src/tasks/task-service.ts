import type { CreateTaskInput, Task } from "@corral/protocol/rpc";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ChangeFeed } from "../changes/change-feed.ts";
import { GitError } from "../git/git.ts";
import { directoryName, uniqueName } from "../git/names.ts";
import {
  addWorktreeOnExistingBranch,
  addWorktreeOnNewBranch,
  addWorktreeTrackingRemote,
  currentBranch,
  deleteBranch,
  isValidBranchName,
  listBranches,
  pruneWorktrees,
  removeWorktree,
  requireCommit,
  uncommittedPaths,
} from "../git/repository.ts";
import { HasLiveTerminalsError, ProjectNotFoundError } from "../projects/errors.ts";
import type { ProjectTasks } from "../projects/project-service.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import { newId } from "../storage/ids.ts";
import { TaskNotFoundError, WorktreeDirtyError } from "./errors.ts";
import { SerialQueue } from "./serial-queue.ts";
import type { TaskStore } from "./task-store.ts";
import { isPlanFailure, planWorktree, type WorktreePlan } from "./worktree-plan.ts";

/** What tasks need from the sessions that run in them. */
export interface TaskSessions {
  hasRunningIn(taskIds: ReadonlySet<string>): boolean;
  /** Stops and forgets every session of the tasks; resolves once the processes are gone. */
  removeAllIn(taskIds: ReadonlySet<string>): Promise<void>;
  /** Stops the task's running sessions and remembers them for `resumeAllIn`. */
  suspendAllIn(taskId: string): Promise<void>;
  /** Starts the sessions `suspendAllIn` remembered. */
  resumeAllIn(taskId: string): Promise<void>;
}

const SHORT_PROJECT_ID_LENGTH = 8;

export class TaskService implements ProjectTasks {
  readonly #store: TaskStore;
  readonly #projects: ProjectStore;
  readonly #sessions: TaskSessions;
  readonly #worktreesDir: string;
  readonly #changes = new ChangeFeed();
  // Branch and directory names are picked, then used, with git calls in between.
  readonly #mutations = new SerialQueue();

  constructor(options: {
    store: TaskStore;
    projects: ProjectStore;
    sessions: TaskSessions;
    dataDir: string;
  }) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#sessions = options.sessions;
    this.#worktreesDir = join(options.dataDir, "worktrees");
  }

  list(): Task[] {
    return this.#store.list();
  }

  get(id: string): Task {
    const task = this.#store.get(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  watch(signal: AbortSignal | undefined): AsyncGenerator<Task[]> {
    return this.#changes.watch(() => this.list(), signal);
  }

  create(input: CreateTaskInput): Promise<Task> {
    return this.#mutations.run(() => this.#create(input));
  }

  setState(id: string, state: Task["state"]): Promise<Task> {
    return this.#mutations.run(() => this.#setState(id, state));
  }

  remove(id: string, force: boolean): Promise<void> {
    return this.#mutations.run(() => this.#remove(id, force));
  }

  async closeTerminalsOf(projectId: string): Promise<void> {
    const ids = new Set(this.#store.idsOfProject(projectId));
    if (this.#sessions.hasRunningIn(ids)) throw new HasLiveTerminalsError();
    await this.#sessions.removeAllIn(ids);
  }

  tasksDropped(): void {
    this.#changes.notify();
  }

  async #create(input: CreateTaskInput): Promise<Task> {
    const project = this.#project(input.projectId);
    const { workspace } = input;
    const task: Task = {
      id: newId(),
      projectId: project.id,
      title: input.title,
      branch: "",
      workspacePath: project.path,
      ownsWorktree: false,
      state: "active",
      createdAt: Date.now(),
    };

    if (workspace.type === "main-worktree") {
      task.branch = (await currentBranch(project.path)) ?? "HEAD";
      return this.#record(task);
    }

    const plan = planWorktree(workspace, {
      title: input.title,
      defaultBaseBranch: project.defaultBaseBranch,
      branches: await listBranches(project.path),
    });
    if (isPlanFailure(plan)) throw new GitError(plan.problem);
    if (plan.kind === "new-branch") {
      if (!(await isValidBranchName(project.path, plan.branch)))
        throw new GitError(`'${plan.branch}' is not a valid branch name`);
      await requireCommit(project.path, plan.base);
    }

    const path = this.#freeWorktreePath(project, plan.branch);
    await mkdir(join(path, ".."), { recursive: true });
    try {
      await addWorktree(project.path, path, plan);
      task.branch = plan.branch;
      task.workspacePath = path;
      task.ownsWorktree = true;
      return this.#record(task);
    } catch (error) {
      await undoWorktree(project.path, path, plan);
      throw error;
    }
  }

  #project(id: string) {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  }

  #record(task: Task): Task {
    this.#store.insert(task);
    this.#changes.notify();
    return task;
  }

  /** `<data dir>/worktrees/<project>-<short id>/<branch>`, in a directory that does not exist yet. */
  #freeWorktreePath(project: { id: string; name: string }, branch: string): string {
    const projectDir = join(
      this.#worktreesDir,
      `${directoryName(project.name)}-${project.id.slice(0, SHORT_PROJECT_ID_LENGTH)}`,
    );
    return join(
      projectDir,
      uniqueName(directoryName(branch), (name) => existsSync(join(projectDir, name))),
    );
  }

  async #setState(id: string, state: Task["state"]): Promise<Task> {
    const task = this.get(id);
    if (task.state === state) return task;
    // A crash between the two steps leaves sessions running in a settled task, which the next
    // start stops and remembers.
    if (state === "settled") {
      this.#store.setState(id, state);
      await this.#sessions.suspendAllIn(id);
    } else {
      await this.#sessions.resumeAllIn(id);
      this.#store.setState(id, state);
    }
    this.#changes.notify();
    return this.get(id);
  }

  async #remove(id: string, force: boolean): Promise<void> {
    const task = this.get(id);
    const project = this.#project(task.projectId);
    const worktreeOnDisk = task.ownsWorktree && existsSync(task.workspacePath);

    if (worktreeOnDisk && !force) {
      const files = await uncommittedPaths(task.workspacePath);
      if (files.length > 0) throw new WorktreeDirtyError(files);
    }
    await this.#sessions.removeAllIn(new Set([id]));
    if (worktreeOnDisk) {
      await removeWorktree(project.path, task.workspacePath, force);
    } else if (task.ownsWorktree) {
      // The directory is gone; make git forget the worktree entry. Nothing is left to protect.
      await pruneWorktrees(project.path).catch(() => undefined);
    }
    this.#store.delete(id);
    this.#changes.notify();
  }
}

function addWorktree(repo: string, path: string, plan: WorktreePlan): Promise<void> {
  if (plan.kind === "new-branch")
    return addWorktreeOnNewBranch(repo, { path, branch: plan.branch, base: plan.base });
  if (plan.kind === "track-remote")
    return addWorktreeTrackingRemote(repo, {
      path,
      branch: plan.branch,
      remoteBranch: plan.remoteBranch,
    });
  return addWorktreeOnExistingBranch(repo, { path, branch: plan.branch });
}

/** Leaves the repository as it was before the attempt; a branch the plan created goes too. */
async function undoWorktree(repo: string, path: string, plan: WorktreePlan): Promise<void> {
  await removeWorktree(repo, path, true).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
  await pruneWorktrees(repo).catch(() => undefined);
  if (plan.kind !== "existing-branch") await deleteBranch(repo, plan.branch).catch(() => undefined);
}

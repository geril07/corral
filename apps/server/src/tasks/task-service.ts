import type { CreateTaskInput, Project, Session, Task, TaskAgent } from "@corral/protocol/rpc";
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
import { BlankTaskTitleError, TaskNotFoundError, WorktreeDirtyError } from "./errors.ts";
import { SerialQueue } from "./serial-queue.ts";
import { seedTitle } from "./seed-title.ts";
import type { TaskSettings } from "./task-settings.ts";
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
  /**
   * Starts a task's primary agent session with the task's prompt. A launch that fails does not
   * throw: it leaves the session `stopped` with its launch error, so the task keeps it and the
   * user can start it again.
   */
  startPrimary(taskId: string, agent: TaskAgent, prompt: string | null): Promise<Session>;
}

export class TaskService implements ProjectTasks {
  readonly #store: TaskStore;
  readonly #projects: ProjectStore;
  readonly #sessions: TaskSessions;
  readonly #settings: TaskSettings;
  readonly #changes = new ChangeFeed();
  // Branch and directory names are picked, then used, with git calls in between.
  readonly #mutations = new SerialQueue();

  constructor(options: {
    store: TaskStore;
    projects: ProjectStore;
    sessions: TaskSessions;
    settings: TaskSettings;
  }) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#sessions = options.sessions;
    this.#settings = options.settings;
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

  rename(id: string, title: string): Promise<Task> {
    // Queued like every other task mutation: a removal that is stopping sessions must finish
    // first, so a rename never writes into a task that is going away. A4's generated title has to
    // write through this queue too, and only when `title_source <> 'user'`.
    return this.#mutations.run(async () => {
      // The wire schema refuses a blank title before the handler; a direct caller gets the same
      // refusal instead of a row whose title cannot be parsed back.
      const trimmed = title.trim();
      if (trimmed === "") throw new BlankTaskTitleError();
      this.get(id);
      this.#store.rename(id, trimmed);
      this.#changes.notify();
      return this.get(id);
    });
  }

  /** Records that the user has seen the task's current agent update; the server stamps the time. */
  markSeen(id: string): Task {
    this.get(id);
    this.#store.setSeenAt(id, Date.now());
    this.#changes.notify();
    return this.get(id);
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

  /** A task lost its primary session outside this service; clients get the list without the id. */
  primarySessionRemoved(): void {
    this.#changes.notify();
  }

  async #create(input: CreateTaskInput): Promise<Task> {
    const project = this.#project(input.projectId);
    const { workspace } = input;
    // A blank prompt is the same as none; the wire schema trimmed it already.
    const prompt = input.prompt === undefined || input.prompt === "" ? null : input.prompt;
    // An explicit title and an issue's title are the user's: the first was typed, the second seen
    // and accepted. Only a prompt-only task gets the seed (design.md, decision 16).
    const named = input.title ?? input.source?.title;
    const title = named ?? (prompt === null ? undefined : seedTitle(prompt));
    // The contract requires one of the three; this guard keeps direct callers honest too.
    if (title === undefined)
      throw new Error("a title is required unless the task comes from an issue source or a prompt");
    const task: Task = {
      id: newId(),
      projectId: project.id,
      title,
      titleSource: named === undefined ? "seed" : "user",
      ...(input.source === undefined ? {} : { source: input.source }),
      prompt,
      primarySessionId: null,
      branch: "",
      workspacePath: project.path,
      ownsWorktree: false,
      state: "active",
      seenAt: null,
      createdAt: Date.now(),
    };

    if (workspace.type === "main-worktree") {
      task.branch = (await currentBranch(project.path)) ?? "HEAD";
      return this.#record(task, input.agent);
    }

    const plan = planWorktree(workspace, {
      title,
      branchPrefix: this.#settings.branchPrefix(project),
      defaultBaseBranch: project.defaultBaseBranch,
      branches: await listBranches(project.path),
    });
    if (isPlanFailure(plan)) throw new GitError(plan.problem);
    if (plan.kind === "new-branch") {
      if (!(await isValidBranchName(project.path, plan.branch)))
        throw new GitError(`'${plan.branch}' is not a valid branch name`);
      await requireCommit(project.path, plan.base);
    }

    const path = this.#freeWorktreePath(project, plan.slug);
    await mkdir(join(path, ".."), { recursive: true });
    try {
      await addWorktree(project.path, path, plan);
    } catch (error) {
      await undoWorktree(project.path, path, plan);
      throw error;
    }
    task.branch = plan.branch;
    task.workspacePath = path;
    task.ownsWorktree = true;
    // Outside the undo scope: the worktree is good, and a session that cannot start must not remove it.
    return this.#record(task, input.agent);
  }

  #project(id: string) {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  }

  /**
   * Stores the task and, when the composer named an agent, starts its primary session with the
   * prompt. One notification covers both, so a client never sees a task without the session it
   * was created with.
   */
  async #record(task: Task, agent: TaskAgent | undefined): Promise<Task> {
    this.#store.insert(task);
    if (agent !== undefined) {
      const session = await this.#sessions.startPrimary(task.id, agent, task.prompt);
      this.#store.setPrimarySession(task.id, session.id);
    }
    this.#changes.notify();
    return this.get(task.id);
  }

  /** `<worktree root>/<repo>/<slug>`, in a directory that does not exist yet. */
  #freeWorktreePath(project: Project, slug: string): string {
    const projectDir = join(this.#settings.worktreeRoot(project), directoryName(project.name));
    return join(
      projectDir,
      uniqueName(directoryName(slug), (name) => existsSync(join(projectDir, name))),
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

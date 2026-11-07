import type {
  CreateTaskInput,
  Project,
  Session,
  SessionView,
  Task,
  TaskAgent,
} from "@corral/protocol/rpc";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ChangeFeed } from "../changes/change-feed.ts";
import { workspaceExists } from "../files/file-access.ts";
import { GitError } from "../git/git.ts";
import { directoryName, uniqueName } from "../git/names.ts";
import {
  addWorktreeOnExistingBranch,
  checkedOutBranches,
  createBranch,
  createTrackingBranch,
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
import { logNamingProblem, namingPlan, requestName } from "../naming/naming.ts";
import type { NamingPlan, NamingSettingsSource } from "../naming/naming.ts";
import { sanitizeGeneratedSlug } from "../naming/naming-output.ts";
import type { NamingName } from "../naming/naming-output.ts";
import { newId } from "../storage/ids.ts";
import { BlankTaskTitleError, TaskNotFoundError, WorktreeDirtyError } from "./errors.ts";
import { SerialQueue } from "./serial-queue.ts";
import { seedTitle } from "./seed-title.ts";
import type { TaskSettings } from "./task-settings.ts";
import type { TaskStore } from "./task-store.ts";
import {
  isPlanFailure,
  normalizedBranchPrefix,
  planWorktree,
  type WorktreePlan,
} from "./worktree-plan.ts";

type BranchCreatingPlan = Extract<WorktreePlan, { kind: "new-branch" | "track-remote" }>;

export interface WorktreeOperations {
  /** Creates the branch the plan needs; rejects when another process already created it. */
  createBranch(repo: string, plan: BranchCreatingPlan): Promise<void>;
  /** Adds the worktree for the plan's branch, which this attempt owns by then. */
  addWorktree(repo: string, path: string, plan: WorktreePlan): Promise<void>;
}

/** The real git operations; a test replaces one of them to fail between planning and undo. */
const gitWorktrees: WorktreeOperations = {
  createBranch(repo, plan) {
    return plan.kind === "new-branch"
      ? createBranch(repo, { branch: plan.branch, base: plan.base })
      : createTrackingBranch(repo, { branch: plan.branch, remoteBranch: plan.remoteBranch });
  },
  addWorktree(repo, path, plan) {
    return addWorktreeOnExistingBranch(repo, { path, branch: plan.branch });
  },
};

/** What tasks need from the sessions that run in them. */
export interface TaskSessions {
  hasRunningIn(taskIds: ReadonlySet<string>): boolean;
  /** Stops and forgets every session of the tasks; resolves once the processes are gone. */
  removeAllIn(taskIds: ReadonlySet<string>): Promise<void>;
  /**
   * Closes every terminal whose cwd is `workspacePath` or inside it — a loose terminal is not a
   * session — and resolves once each process is gone. A close that rejects stops the sweep.
   */
  closeTerminalsIn(workspacePath: string): Promise<void>;
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
  /** Whether this build has a chat driver for the agent, so a configured `chat` view can apply. */
  hasChatDriver(kind: TaskAgent["kind"]): boolean;
}

export class TaskService implements ProjectTasks {
  readonly #store: TaskStore;
  readonly #projects: ProjectStore;
  readonly #sessions: TaskSessions;
  readonly #settings: TaskSettings;
  readonly #naming: NamingSettingsSource;
  readonly #worktree: WorktreeOperations;
  readonly #changes = new ChangeFeed();
  // Branch and directory names are picked, then used, with git calls in between.
  readonly #mutations = new SerialQueue();

  constructor(options: {
    store: TaskStore;
    projects: ProjectStore;
    sessions: TaskSessions;
    settings: TaskSettings;
    naming: NamingSettingsSource;
    /** Test seam; production runs git. */
    worktree?: Partial<WorktreeOperations>;
  }) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#sessions = options.sessions;
    this.#settings = options.settings;
    this.#naming = options.naming;
    this.#worktree = { ...gitWorktrees, ...options.worktree };
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
    return this.#create(input);
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

  /**
   * Whether a project can be removed is answered on the task mutation queue, together with the
   * terminal close and the row deletion: a create holds that queue from its worktree until its
   * task and primary session are recorded, so a project removed during a launch now waits and is
   * then refused, instead of cascading the task and leaving the just-started terminal behind.
   */
  async removeProject(projectId: string): Promise<void> {
    return this.#mutations.run(async () => {
      this.#project(projectId);
      const ids = new Set(this.#store.idsOfProject(projectId));
      if (this.#sessions.hasRunningIn(ids)) throw new HasLiveTerminalsError();
      await this.#sessions.removeAllIn(ids);
      this.#projects.delete(projectId);
      this.#changes.notify();
    });
  }

  /** A task lost its primary session outside this service; clients get the list without the id. */
  primarySessionRemoved(): void {
    this.#changes.notify();
  }

  /**
   * A restart of a settled task makes it active before any session starts. This is deliberately
   * not `setState`: that runs on `#mutations` and waits for `resumeAllIn` on the session queue,
   * while this is called from inside a session-queue job and would deadlock. A settle racing this
   * write is last-write-wins; settle stops and remembers, so the end state is consistent.
   */
  taskActivated(taskId: string): void {
    this.#store.setState(taskId, "active");
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
    const titleSource = named === undefined ? "seed" : "user";
    // Only a new branch the user did not name can take a generated slug; an existing branch keeps
    // its name, and the worktree directory follows it.
    const generatedSlug =
      workspace.type === "new-branch" &&
      workspace.branch === undefined &&
      this.#settings.slugMode(project) === "generated";
    // Naming runs only for a prompt-only task with a configured runner (decision 16).
    let naming: { plan: NamingPlan; prompt: string } | undefined;
    if (named === undefined && prompt !== null) {
      const plan = namingPlan(this.#naming, { generatedSlug });
      if (plan !== undefined) naming = { plan, prompt };
    }

    if (workspace.type === "main-worktree") {
      return this.#mutations.run(async () => {
        const task = this.#newTask(input, project, { title, titleSource, prompt });
        task.branch = (await currentBranch(project.path)) ?? "HEAD";
        const recorded = await this.#record(task, input.agent);
        // The task is visible with its seed title now; a slow naming call must not hold the
        // response or the mutation queue. Its write is queued and never replaces a user's title.
        if (naming !== undefined)
          void this.#nameLater(recorded.id, naming.plan, naming.prompt, project.name);
        return recorded;
      });
    }

    const name =
      naming === undefined
        ? undefined
        : await requestName(naming.plan, { prompt: naming.prompt, projectName: project.name });
    return this.#mutations.run(() =>
      this.#createInWorktree(input, workspace, project, {
        title: name?.title ?? title,
        titleSource: name === undefined ? titleSource : "generated",
        prompt,
        name,
        generatedSlug: naming?.plan.generatedSlug === true,
      }),
    );
  }

  #newTask(
    input: CreateTaskInput,
    project: Project,
    fields: { title: string; titleSource: Task["titleSource"]; prompt: string | null },
  ): Task {
    return {
      id: newId(),
      projectId: project.id,
      title: fields.title,
      titleSource: fields.titleSource,
      ...(input.source === undefined ? {} : { source: input.source }),
      prompt: fields.prompt,
      primarySessionId: null,
      branch: "",
      workspacePath: project.path,
      ownsWorktree: false,
      state: "active",
      seenAt: null,
      createdAt: Date.now(),
    };
  }

  async #createInWorktree(
    input: CreateTaskInput,
    workspace: Exclude<CreateTaskInput["workspace"], { type: "main-worktree" }>,
    project: Project,
    fields: {
      title: string;
      titleSource: Task["titleSource"];
      prompt: string | null;
      name: NamingName | undefined;
      generatedSlug: boolean;
    },
  ): Promise<Task> {
    const task = this.#newTask(input, project, fields);
    const branchPrefix = this.#settings.branchPrefix(project);
    const slug =
      fields.generatedSlug && fields.name !== undefined
        ? this.#generatedSlugOf(fields.name, branchPrefix)
        : undefined;
    const plan = await this.#planWorktree(workspace, project, fields.title, slug);
    // The picker's list is a snapshot; the worktree list is read again immediately before the
    // branch is checked out, so a branch taken since then is named instead of echoing git stderr.
    if (plan.kind !== "new-branch") {
      const held = (await checkedOutBranches(project.path)).get(plan.branch);
      if (held !== undefined)
        throw new GitError(
          `branch '${plan.branch}' is already checked out at ${held}; choose another branch`,
        );
    }
    const path = this.#freeWorktreePath(project, plan.slug);
    await mkdir(join(path, ".."), { recursive: true });
    // The branch is created first, in one atomic git call: if another process already made it,
    // `createdBranch` stays false and undo leaves that branch alone. The row is the owner of the
    // worktree and the branch: while it does not exist, the attempt's branch and worktree are
    // unowned and go together; once it exists, a launch that fails keeps everything.
    let createdBranch = false;
    try {
      if (plan.kind !== "existing-branch") {
        await this.#worktree.createBranch(project.path, plan);
        createdBranch = true;
      }
      await this.#worktree.addWorktree(project.path, path, plan);
      task.branch = plan.branch;
      task.workspacePath = path;
      task.ownsWorktree = true;
      return await this.#record(task, input.agent);
    } catch (error) {
      // The row can also disappear after the insert: project removal cascades it, and the attempt
      // is unowned again. A branch that existed before the attempt is still never deleted.
      if (this.#store.get(task.id) === undefined)
        await undoWorktree(project.path, path, plan, createdBranch);
      throw error;
    }
  }

  /**
   * The generated slug both the branch and the worktree directory are named after. The branch the
   * agent returned may carry the configured prefix; it must sanitize to the same slug as the
   * worktree, or the pair is not one name and the title's slug is used instead.
   */
  #generatedSlugOf(name: NamingName, branchPrefix: string): string | undefined {
    const prefix = normalizedBranchPrefix(branchPrefix);
    const branch = name.branch ?? "";
    const branchText =
      prefix !== "" && branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;
    const worktree = sanitizeGeneratedSlug(name.worktree ?? "");
    const branchSlug = sanitizeGeneratedSlug(branchText);
    if (worktree === "" || branchSlug === "") {
      logNamingProblem(
        "the generated branch or worktree has no usable slug; using the title's slug",
      );
      return undefined;
    }
    if (worktree !== branchSlug) {
      logNamingProblem("the generated branch and worktree disagree; using the title's slug");
      return undefined;
    }
    return worktree;
  }

  async #planWorktree(
    workspace: Exclude<CreateTaskInput["workspace"], { type: "main-worktree" }>,
    project: Project,
    title: string,
    generatedSlug: string | undefined,
  ): Promise<WorktreePlan> {
    const context = {
      title,
      branchPrefix: this.#settings.branchPrefix(project),
      defaultBaseBranch: project.defaultBaseBranch,
      branches: await listBranches(project.path),
    };
    const planned = (slug: string | undefined) =>
      planWorktree(workspace, slug === undefined ? context : { ...context, generatedSlug: slug });
    let plan = planned(generatedSlug);
    if (isPlanFailure(plan)) throw new GitError(plan.problem);
    if (plan.kind === "new-branch" && !(await isValidBranchName(project.path, plan.branch))) {
      // Only a generated name can fall back; a branch the user chose is theirs to fix.
      if (generatedSlug === undefined || workspace.branch !== undefined)
        throw new GitError(`'${plan.branch}' is not a valid branch name`);
      logNamingProblem(
        `the generated branch '${plan.branch}' is not a valid branch name; using the title's slug`,
      );
      plan = planned(undefined);
      if (isPlanFailure(plan)) throw new GitError(plan.problem);
      if (plan.kind === "new-branch" && !(await isValidBranchName(project.path, plan.branch)))
        throw new GitError(`'${plan.branch}' is not a valid branch name`);
    }
    if (plan.kind === "new-branch") await requireCommit(project.path, plan.base);
    return plan;
  }

  /**
   * Names a task after it was already recorded (the main working tree): the generated title is
   * written through the mutation queue, and only while the title is not the user's.
   */
  async #nameLater(
    taskId: string,
    plan: NamingPlan,
    prompt: string,
    projectName: string,
  ): Promise<void> {
    try {
      const name = await requestName(plan, { prompt, projectName });
      if (name === undefined) return;
      await this.#mutations.run(async () => {
        if (this.#store.setGeneratedTitle(taskId, name.title)) {
          this.#changes.notify();
          return;
        }
        if (this.#store.get(taskId)?.titleSource === "user")
          logNamingProblem(
            "the task was renamed while its title was generated; keeping the user's title",
          );
      });
    } catch (error) {
      logNamingProblem(error instanceof Error ? error.message : String(error));
    }
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
    // A create names the project before a network call and the worktree, and `projects.remove` is
    // not on this queue: re-read it immediately before the insert, with no await between, so the
    // project-removal race is the contract's PROJECT_NOT_FOUND rather than a foreign-key error.
    const project = this.#project(task.projectId);
    this.#store.insert(task);
    try {
      if (agent !== undefined) {
        const session = await this.#sessions.startPrimary(
          task.id,
          { ...agent, view: this.#viewFor(project, agent) },
          task.prompt,
        );
        this.#store.setPrimarySession(task.id, session.id);
      }
      this.#changes.notify();
      return this.get(task.id);
    } catch (error) {
      // The row is the user's once it exists, so a failure here keeps it; still announce it, or a
      // client would hold a task the feed never named.
      if (this.#store.get(task.id) !== undefined) this.#changes.notify();
      throw error;
    }
  }

  /**
   * The view a task's primary session opens in when the request names none: the project's
   * configured view. A `chat` view needs a driver in this build, so for any other agent it opens
   * in the terminal — the config file already warned when it named that agent itself.
   */
  #viewFor(project: Project, agent: TaskAgent): SessionView {
    if (agent.view !== undefined) return agent.view;
    const configured = this.#settings.view(project);
    return configured === "chat" && !this.#sessions.hasChatDriver(agent.kind)
      ? "terminal"
      : configured;
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
      // The task reads active before any remembered session starts, so Continue never runs a
      // session under a task that still says settled.
      this.#store.setState(id, state);
      await this.#sessions.resumeAllIn(id);
    }
    this.#changes.notify();
    return this.get(id);
  }

  async #remove(id: string, force: boolean): Promise<void> {
    const task = this.get(id);
    const project = this.#project(task.projectId);
    const worktreeOnDisk = task.ownsWorktree && (await workspaceExists(task.workspacePath));

    if (worktreeOnDisk && !force) {
      const files = await uncommittedPaths(task.workspacePath);
      if (files.length > 0) throw new WorktreeDirtyError(files);
    }
    // The directory is already gone, so pruning only touches git metadata and no live process is
    // in its way. It runs before the teardown: a prune that fails must refuse the removal without
    // having stopped the task's sessions or closed their terminals first.
    if (!worktreeOnDisk && task.ownsWorktree) {
      await pruneWorktrees(project.path);
    }
    await this.#sessions.removeAllIn(new Set([id]));
    // The session terminals are gone; a loose terminal in the workspace is not a session and would
    // otherwise keep a deleted cwd. Sweep even when the directory is already gone: its process may
    // still hold it. A main-worktree task owns nothing, so the project's own terminals stay.
    if (task.ownsWorktree) await this.#sessions.closeTerminalsIn(task.workspacePath);
    if (worktreeOnDisk) {
      await removeWorktree(project.path, task.workspacePath, force);
    }
    this.#store.delete(id);
    this.#changes.notify();
  }
}

/** Leaves the repository as it was before the attempt; a branch this attempt created goes too. */
async function undoWorktree(
  repo: string,
  path: string,
  plan: WorktreePlan,
  createdBranch: boolean,
): Promise<void> {
  await removeWorktree(repo, path, true).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
  await pruneWorktrees(repo).catch(() => undefined);
  if (createdBranch) await deleteBranch(repo, plan.branch).catch(() => undefined);
}

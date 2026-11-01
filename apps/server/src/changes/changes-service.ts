import type {
  ChangeDiff,
  ChangesFinish,
  ChangesRemote,
  IssueProvider,
  Project,
  PullRequest,
  Task,
  TaskChanges,
} from "@corral/protocol/rpc";
import { readChanges, readFileDiff } from "../git/diff.ts";
import {
  checkedOutBranch,
  listRemotes,
  remoteHasBranch,
  remoteUrl,
  resolvePushRemote,
} from "../git/remotes.ts";
import { commit as commitIndex, pushBranch, stagePaths, stagedPaths } from "../git/writes.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { TaskNotFoundError } from "../tasks/errors.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import { ChangeFeed } from "./change-feed.ts";
import {
  ChangesBranchMismatchError,
  ChangesEmptyMessageError,
  ChangesNoRemoteError,
  ChangesNothingStagedError,
  ChangesPushRequiredError,
  ChangesRemoteMismatchError,
  ChangeFileUnknownError,
} from "./errors.ts";
import {
  createPullRequest as createRequest,
  DEFAULT_PULL_REQUEST_TIMEOUT_MS,
  describeReadFailure,
  readPullRequest,
} from "./pull-request.ts";
import type { PullRequestStore } from "./pull-request-store.ts";

/**
 * The read model behind `changes.*` (`layout.md`, **Changes**) and its writes (C6): each task's
 * changed files under a base the server computes on every read, one file's capped diff, and the
 * staging, commit, push and pull-request actions the user confirms one at a time.
 *
 * Every read stays read-only — no index update, no checkout — and every write is reached only from
 * an explicit action that names the remote and branch it targets; the push and the pull request
 * check the remote's URL against the one the user confirmed and refuse a mismatch.
 *
 * The base is recomputed rather than stored, so a rebased branch or a deleted base branch is
 * reflected on the next read. A snapshot is cached only to spare the watch a full recompute when
 * one thing changed: `workspaceChanged` marks one task dirty and the next read recomputes that
 * task, merging it into the list the other tasks already have.
 */
export class ChangesService {
  readonly #tasks: TaskStore;
  readonly #projects: ProjectStore;
  readonly #sessions: SessionStore;
  readonly #pullRequests: PullRequestStore;
  readonly #pullRequestTimeoutMs: number;
  readonly #changes = new ChangeFeed();
  readonly #cache = new Map<string, TaskChanges>();
  readonly #dirty = new Set<string>();

  constructor(options: {
    tasks: TaskStore;
    projects: ProjectStore;
    sessions: SessionStore;
    pullRequests: PullRequestStore;
    /** Deadline for one `gh`/`glab` call; tests shorten it. */
    pullRequestTimeoutMs?: number;
  }) {
    this.#tasks = options.tasks;
    this.#projects = options.projects;
    this.#sessions = options.sessions;
    this.#pullRequests = options.pullRequests;
    this.#pullRequestTimeoutMs = options.pullRequestTimeoutMs ?? DEFAULT_PULL_REQUEST_TIMEOUT_MS;
  }

  /** Every task's changes now and after the server learns one of their workspaces may have changed. */
  watch(signal: AbortSignal | undefined): AsyncGenerator<TaskChanges[]> {
    return this.#changes.watch(() => this.#read(), signal);
  }

  /**
   * One task's changes, recomputed now: what a client asks for when the tab becomes current or
   * the window regains focus, because the watch cannot see an edit made outside Corral.
   */
  async files(taskId: string): Promise<TaskChanges> {
    const task = this.#task(taskId);
    const snapshot = await this.#snapshot(task);
    this.#cache.set(task.id, snapshot);
    this.#dirty.delete(task.id);
    return snapshot;
  }

  /**
   * One changed file's unified diff under the task's current base. The cached snapshot is reused
   * when it is current, so clicking through files reads one diff, not the whole workspace again;
   * a dirty task (an agent tool call) or a task never read is recomputed first.
   */
  async diff(taskId: string, path: string): Promise<ChangeDiff> {
    const task = this.#task(taskId);
    const cached = this.#cache.get(task.id);
    const snapshot =
      cached === undefined || this.#dirty.has(task.id) ? await this.#snapshot(task) : cached;
    if (snapshot !== cached) {
      this.#cache.set(task.id, snapshot);
      this.#dirty.delete(task.id);
    }
    const file = snapshot.files.find((each) => each.path === path);
    if (file === undefined) throw new ChangeFileUnknownError(path);
    return readFileDiff(task.workspacePath, snapshot.base, file);
  }

  /**
   * What the commit, push and pull-request controls open with: the checked-out branch, the base a
   * pull request would target, the remote a push would use and the paths the index holds. Read on
   * mount and after every write; nothing here writes.
   */
  async finish(taskId: string): Promise<ChangesFinish> {
    const task = this.#task(taskId);
    const branch = await checkedOutBranch(task.workspacePath);
    const base = this.#projects.get(task.projectId)?.defaultBaseBranch ?? null;
    const remotes = await listRemotes(task.workspacePath);
    const remote =
      branch === undefined ? undefined : await resolvePushRemote(task.workspacePath, branch);
    return {
      taskId: task.id,
      branch: branch ?? null,
      base,
      remote: remote ?? null,
      remotes,
      staged: await stagedPaths(task.workspacePath),
    };
  }

  /** Stages or unstages the paths the user selected, or every change. */
  async stage(
    taskId: string,
    input: { paths: readonly string[] | "all"; staged: boolean },
  ): Promise<ChangesFinish> {
    const task = this.#task(taskId);
    await stagePaths(task.workspacePath, input.paths, input.staged);
    this.workspaceChanged(task.id, { byTask: true });
    return this.finish(taskId);
  }

  /**
   * Commits the index with the message the user typed. An empty message and an empty index are
   * refused before git runs, so the UI keeps the message and the selection instead of showing a
   * git sentence about "no changes added to commit".
   */
  async commit(
    taskId: string,
    message: string,
  ): Promise<{ sha: string; shortSha: string; subject: string; finish: ChangesFinish }> {
    const task = this.#task(taskId);
    if (message.trim() === "") throw new ChangesEmptyMessageError();
    if ((await stagedPaths(task.workspacePath)).length === 0) throw new ChangesNothingStagedError();
    const committed = await commitIndex(task.workspacePath, message);
    this.workspaceChanged(task.id, { byTask: true });
    return { ...committed, finish: await this.finish(taskId) };
  }

  /**
   * Pushes the checked-out branch to the remote the user confirmed. The branch and the remote's URL
   * are checked again here: what was confirmed is what runs, and a workspace that moved on between
   * the dialog and the write is refused instead of pushed.
   */
  async push(
    taskId: string,
    input: { remote: ChangesRemote; branch: string },
  ): Promise<{ remote: ChangesRemote; branch: string; commit: string; finish: ChangesFinish }> {
    const task = this.#task(taskId);
    await this.#confirmedRemote(task, input.remote, input.branch);
    const { commit } = await pushBranch(task.workspacePath, input.remote.name, input.branch);
    return {
      remote: input.remote,
      branch: input.branch,
      commit,
      finish: await this.finish(taskId),
    };
  }

  /**
   * Opens the pull or merge request through the server host's own CLI and stores the link on the
   * task. The remote must be the confirmed one and must already have the branch: `gh pr create`
   * pushes a missing head branch, and a silent push is what this slice refuses.
   */
  async createPullRequest(
    taskId: string,
    input: {
      provider: IssueProvider;
      remote: ChangesRemote;
      branch: string;
      base: string;
      title: string;
      body: string;
      draft?: boolean | undefined;
    },
  ): Promise<PullRequest> {
    const task = this.#task(taskId);
    await this.#confirmedRemote(task, input.remote, input.branch);
    if (!(await remoteHasBranch(task.workspacePath, input.remote.name, input.branch))) {
      throw new ChangesPushRequiredError(input.remote.name, input.branch);
    }
    const snapshot = await createRequest({
      provider: input.provider,
      cwd: task.workspacePath,
      branch: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft === true,
      timeoutMs: this.#pullRequestTimeoutMs,
      signal: undefined,
      // The host is the CLI's own repository resolution from the task's remote, not a client-supplied
      // URL, so there is no untrusted host to strip tokens for here.
      stripGitHubTokens: false,
    });
    const request: PullRequest = { ...snapshot, taskId: task.id };
    this.#pullRequests.put(request);
    return request;
  }

  /**
   * The task's pull request and, with `refresh`, its state as the CLI reports it now. A refresh
   * that cannot read the state keeps the link and stores `unknown` with the reason: a failed read
   * is never reported as `closed`, and the user's next focus tries again.
   */
  async pullRequest(taskId: string, refresh = false): Promise<PullRequest | null> {
    const task = this.#task(taskId);
    const stored = this.#pullRequests.get(task.id);
    if (stored === undefined || !refresh) return stored ?? null;
    try {
      const snapshot = await readPullRequest({
        provider: stored.provider,
        cwd: task.workspacePath,
        timeoutMs: this.#pullRequestTimeoutMs,
        signal: undefined,
        stripGitHubTokens: false,
      });
      const next: PullRequest = { ...stored, ...snapshot, taskId: task.id };
      this.#pullRequests.put(next);
      return next;
    } catch (error) {
      const next: PullRequest = {
        ...stored,
        state: "unknown",
        stateReason: describeReadFailure(error),
      };
      this.#pullRequests.put(next);
      return next;
    }
  }

  /**
   * A session's agent did something that may have touched its workspace: a tool call from the chat
   * stream. Only the session's task is recomputed, and only when a watcher reads next. A terminal
   * agent (or an editor outside Corral) reports nothing, which is what the refresh on focus covers.
   */
  workspaceChanged(sessionId: string): void;
  /** A write of Corral's own (staging, a commit): the task is dirty even though no session spoke. */
  workspaceChanged(taskId: string, options: { byTask: true }): void;
  workspaceChanged(id: string, options?: { byTask: true }): void {
    const taskId = options?.byTask === true ? id : this.#sessions.get(id)?.taskId;
    if (taskId === undefined || this.#tasks.get(taskId) === undefined) return;
    this.#dirty.add(taskId);
    this.#changes.notify();
  }

  /** Refuses a write whose confirmed branch or remote URL is no longer what the workspace has. */
  async #confirmedRemote(task: Task, remote: ChangesRemote, branch: string): Promise<void> {
    const actualBranch = await checkedOutBranch(task.workspacePath);
    if (actualBranch !== branch) {
      throw new ChangesBranchMismatchError(branch, actualBranch ?? null);
    }
    const actualUrl = await remoteUrl(task.workspacePath, remote.name);
    if (actualUrl === undefined) throw new ChangesNoRemoteError(branch);
    if (actualUrl !== remote.url) {
      throw new ChangesRemoteMismatchError(remote.name, remote.url, actualUrl);
    }
  }

  async #read(): Promise<TaskChanges[]> {
    const tasks = this.#tasks.list();
    const listed = new Set(tasks.map((task) => task.id));
    for (const id of this.#cache.keys()) {
      if (!listed.has(id)) this.#cache.delete(id);
    }
    for (const task of tasks) {
      if (!this.#dirty.has(task.id) && this.#cache.has(task.id)) continue;
      // oxlint-disable-next-line no-await-in-loop -- one task at a time keeps the git calls bounded
      this.#cache.set(task.id, await this.#snapshot(task));
    }
    this.#dirty.clear();
    return tasks.flatMap((task) => {
      const snapshot = this.#cache.get(task.id);
      return snapshot === undefined ? [] : [snapshot];
    });
  }

  #task(taskId: string): Task {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    return task;
  }

  /** One task's read model; a workspace that cannot be read is a snapshot with the reason, not an error. */
  async #snapshot(task: Task): Promise<TaskChanges> {
    const project: Project | undefined = this.#projects.get(task.projectId);
    if (project === undefined) {
      return failed(task.id, "the task's project is gone");
    }
    try {
      const { base, files, truncated } = await readChanges(task.workspacePath, {
        worktree: task.ownsWorktree,
        defaultBaseBranch: project.defaultBaseBranch,
      });
      return {
        taskId: task.id,
        base,
        files,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        truncated,
        error: null,
      };
    } catch (error) {
      // A missing worktree is the common case: the task stays listed, its tab says why it is empty.
      return failed(task.id, error instanceof Error ? error.message : String(error));
    }
  }
}

function failed(taskId: string, message: string): TaskChanges {
  return {
    taskId,
    base: { commit: null, label: "unreadable", fallback: null },
    files: [],
    additions: 0,
    deletions: 0,
    truncated: false,
    error: message,
  };
}

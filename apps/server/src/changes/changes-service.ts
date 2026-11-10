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
import { workspaceMissingMessage } from "@corral/protocol/workspace";
import { workspaceExists } from "../files/file-access.ts";
import { GitError } from "../git/git.ts";
import { readChanges, readFileDiff } from "../git/diff.ts";
import {
  checkedOutBranch,
  listRemotes,
  localBranchCommit,
  remoteBranchCommit,
  remoteConfiguredPushUrl,
  remoteDestination,
  remotePushUrl,
  resolvePushRemote,
} from "../git/remotes.ts";
import type { RemoteDestination } from "../git/remotes.ts";
import { hostTrust } from "../issues/trusted-hosts.ts";
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

const SCRATCH_GIT_UNAVAILABLE = "Git operations are unavailable for a no-project scratch task";

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
  /**
   * One pull-request refresh per task at a time. A window regaining focus, a tick of every client's
   * interval and a tab mount can ask together; sharing the promise keeps one focus burst to one
   * `gh pr view` per task instead of one per asker.
   */
  readonly #refreshing = new Map<string, Promise<PullRequest | null>>();

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
    const task = this.#gitTask(taskId);
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
    const task = this.#gitTask(taskId);
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
    const task = this.#gitTask(taskId);
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
    const task = this.#gitTask(taskId);
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
    const task = this.#gitTask(taskId);
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
    const task = this.#gitTask(taskId);
    await this.#confirmedRemote(task, input.remote, input.branch);
    // The remote must have this branch **at its tip**: a branch pushed two commits ago would open a
    // request for code the user did not confirm, and `gh pr create` would happily do it.
    const local = await localBranchCommit(task.workspacePath, input.branch);
    const pushed = await remoteBranchCommit(task.workspacePath, input.remote.url, input.branch);
    if (local === undefined || pushed !== local) {
      throw new ChangesPushRequiredError(input.remote.name, input.branch);
    }
    // `--repo` comes from the remote's configured URL (the forge repository), never from the
    // expanded push address a local `insteadOf` alias may have produced.
    const configured = await remoteConfiguredPushUrl(task.workspacePath, input.remote.name);
    const destination = remoteDestination(configured ?? input.remote.url);
    const snapshot = await createRequest({
      provider: input.provider,
      cwd: task.workspacePath,
      destination,
      branch: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft === true,
      timeoutMs: this.#pullRequestTimeoutMs,
      signal: undefined,
      ...(await this.#tokenPolicy(task, input.provider, destination)),
    });
    const request: PullRequest = {
      ...snapshot,
      taskId: task.id,
      // Host and path in one value: the refresh must not be able to drift to another forge.
      repository:
        destination === undefined ? null : `${destination.host}/${destination.segments.join("/")}`,
    };
    this.#pullRequests.put(request);
    return request;
  }

  /**
   * The task's pull request and, with `refresh`, its state as the CLI reports it now. A refresh
   * that cannot read the state keeps the link and stores `unknown` with the reason: a failed read
   * is never reported as `closed`, and the user's next focus tries again.
   */
  async pullRequest(taskId: string, refresh = false): Promise<PullRequest | null> {
    const task = this.#gitTask(taskId);
    const stored = this.#pullRequests.get(task.id);
    if (stored === undefined || !refresh) return stored ?? null;
    const running = this.#refreshing.get(task.id);
    if (running !== undefined) return running;
    const work = this.#refresh(task, stored).finally(() => this.#refreshing.delete(task.id));
    this.#refreshing.set(task.id, work);
    return work;
  }

  /**
   * One refresh: the CLI's answer stored, or `unknown` with the reason. A state that could not be
   * read takes the checks with it — a summary from the last successful read would describe a
   * request whose state nobody can confirm.
   */
  async #refresh(task: Task, stored: PullRequest): Promise<PullRequest> {
    // The repository the request was opened on, kept on the row with its host: a renamed or removed
    // remote, or a forge that redirects the request's URL, must not move a refresh elsewhere.
    const destination = storedRepositoryDestination(stored.repository ?? null);
    try {
      const snapshot = await readPullRequest({
        provider: stored.provider,
        cwd: task.workspacePath,
        destination,
        // `--repo` needs the request positionally (probed against the real `gh`); the stored number
        // is exact.
        selector: stored.number,
        timeoutMs: this.#pullRequestTimeoutMs,
        signal: undefined,
        ...(await this.#tokenPolicy(task, stored.provider, destination)),
      });
      const next: PullRequest = { ...stored, ...snapshot, taskId: task.id };
      this.#pullRequests.put(next);
      return next;
    } catch (error) {
      const next: PullRequest = {
        ...stored,
        state: "unknown",
        stateReason: describeReadFailure(error),
        checks: null,
      };
      this.#pullRequests.put(next);
      return next;
    }
  }

  /**
   * The `issue-import.ts` token rule, applied to the confirmed repository's host: the operator's
   * GitHub tokens travel only to a host the project's own remotes or `GH_HOST` vouch for (or a
   * public GitHub host). A push URL naming no host (a local path) strips them: the CLI may then
   * resolve a host nobody confirmed. The provider is the user's choice, so a GitLab call never
   * carries GitHub tokens at all.
   */
  async #tokenPolicy(
    task: Task,
    provider: IssueProvider,
    destination: RemoteDestination | undefined,
  ): Promise<{ stripGitHubTokens: boolean }> {
    if (provider !== "github") return { stripGitHubTokens: true };
    if (destination === undefined) return { stripGitHubTokens: true };
    const trust = await hostTrust(task.workspacePath, provider, destination.host, process.env);
    return { stripGitHubTokens: trust === undefined || (!trust.publicHost && !trust.operatorHost) };
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
    if (taskId === undefined) return;
    const task = this.#tasks.get(taskId);
    if (task === undefined || task.projectId === null) return;
    this.#dirty.add(taskId);
    this.#changes.notify();
  }

  /** Refuses a write whose confirmed branch or remote URL is no longer what the workspace has. */
  async #confirmedRemote(task: Task, remote: ChangesRemote, branch: string): Promise<void> {
    const actualBranch = await checkedOutBranch(task.workspacePath);
    if (actualBranch !== branch) {
      throw new ChangesBranchMismatchError(branch, actualBranch ?? null);
    }
    // The **push** URL, not the fetch URL: `remote.<name>.pushurl` is where a push really goes.
    const actualUrl = await remotePushUrl(task.workspacePath, remote.name);
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

  #gitTask(taskId: string): Task & { projectId: string } {
    const task = this.#task(taskId);
    if (task.projectId === null) throw new GitError(SCRATCH_GIT_UNAVAILABLE);
    return { ...task, projectId: task.projectId };
  }

  /** One task's read model; a workspace that cannot be read is a snapshot with the reason, not an error. */
  async #snapshot(task: Task): Promise<TaskChanges> {
    if (task.projectId === null) return failed(task.id, SCRATCH_GIT_UNAVAILABLE);
    const project: Project | undefined = this.#projects.get(task.projectId);
    if (project === undefined) {
      return failed(task.id, "the task's project is gone");
    }
    // The task stays listed with a reason it can act on, rather than git's raw "no such directory".
    if (!(await workspaceExists(task.workspacePath))) {
      return failed(task.id, workspaceMissingMessage(task.workspacePath));
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
      // The directory can disappear between the preflight above and git's first read; that window
      // still names the state instead of surfacing git's `no such directory`.
      if (!(await workspaceExists(task.workspacePath))) {
        return failed(task.id, workspaceMissingMessage(task.workspacePath));
      }
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

/** `forge.example/acme/app` → the destination the CLI needs; host first, then the path segments. */
function storedRepositoryDestination(repository: string | null): RemoteDestination | undefined {
  if (repository === null) return undefined;
  const slash = repository.indexOf("/");
  if (slash <= 0 || slash === repository.length - 1) return undefined;
  return {
    host: repository.slice(0, slash),
    segments: repository.slice(slash + 1).split("/"),
  };
}

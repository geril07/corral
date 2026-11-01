import type { ChangeDiff, Project, Task, TaskChanges } from "@corral/protocol/rpc";
import { readChanges, readFileDiff } from "../git/diff.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { TaskNotFoundError } from "../tasks/errors.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import { ChangeFeed } from "./change-feed.ts";
import { ChangeFileUnknownError } from "./errors.ts";

/**
 * The read model behind `changes.*` (`layout.md`, **Changes**): each task's changed files under a
 * base the server computes on every read, and one file's capped diff. Nothing here writes to the
 * repository — no index update, no checkout, no `git add`; staging and committing are C6's.
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
  readonly #changes = new ChangeFeed();
  readonly #cache = new Map<string, TaskChanges>();
  readonly #dirty = new Set<string>();

  constructor(options: { tasks: TaskStore; projects: ProjectStore; sessions: SessionStore }) {
    this.#tasks = options.tasks;
    this.#projects = options.projects;
    this.#sessions = options.sessions;
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

  /** One changed file's unified diff under the task's current base. */
  async diff(taskId: string, path: string): Promise<ChangeDiff> {
    const task = this.#task(taskId);
    const snapshot = await this.#snapshot(task);
    this.#cache.set(task.id, snapshot);
    this.#dirty.delete(task.id);
    const file = snapshot.files.find((each) => each.path === path);
    if (file === undefined) throw new ChangeFileUnknownError(path);
    return readFileDiff(task.workspacePath, snapshot.base, file);
  }

  /**
   * A session's agent did something that may have touched its workspace: a tool call from the chat
   * stream. Only the session's task is recomputed, and only when a watcher reads next. A terminal
   * agent (or an editor outside Corral) reports nothing, which is what the refresh on focus covers.
   */
  workspaceChanged(sessionId: string): void {
    const taskId = this.#sessions.get(sessionId)?.taskId;
    if (taskId === undefined || this.#tasks.get(taskId) === undefined) return;
    this.#dirty.add(taskId);
    this.#changes.notify();
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

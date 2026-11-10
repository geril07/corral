import type { IssueProvider, Project, TaskSource } from "@corral/protocol/rpc";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { ChangeFeed } from "../changes/change-feed.ts";
import { expandHomePath } from "../config/home-path.ts";
import { GitError } from "../git/git.ts";
import { branchConflict, localNameOfRemote } from "../git/names.ts";
import {
  checkedOutBranches,
  defaultBaseBranch,
  findMainWorkingTree,
  listBranches,
} from "../git/repository.ts";
import type { IssueImportService } from "../issues/issue-import.ts";
import { newId } from "../storage/ids.ts";
import { NotAGitRepositoryError, ProjectExistsError, ProjectNotFoundError } from "./errors.ts";
import type { ProjectStore } from "./project-store.ts";
import { directoryCompletions } from "./directory-completions.ts";

/** What a project path must be before git sees it: absolute, or relative to the server's home. */
const PROJECT_PATH_RULE = "the project path must be an absolute path or start with ~/";

/** The `code` of a failed filesystem call, for mapping it to a refusal. */
function ioErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/** A `stat` failure as a sentence about the path the user asked for, never a raw system error. */
function statFailure(error: unknown, path: string): GitError {
  const code = ioErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return new GitError(`no such directory: ${path}`);
  if (code === "EACCES" || code === "EPERM") return new GitError(`permission denied: ${path}`);
  if (code === "ELOOP") return new GitError(`too many levels of symbolic links: ${path}`);
  if (code === "ENAMETOOLONG") return new GitError(`path is too long: ${path}`);
  const cause = error instanceof Error ? error.message : String(error);
  return new GitError(`cannot read ${path}: ${cause}`);
}

/**
 * The absolute directory an add-project input names. Trimming and `~` happen on the server,
 * because the path is the server's filesystem fact; a client on another machine cannot know it.
 * A missing path and a file keep the cause git would have reported in its own words.
 */
async function resolveProjectPath(input: string, home: string): Promise<string> {
  const written = input.trim();
  if (written !== "~" && !written.startsWith("~/") && !isAbsolute(written))
    throw new GitError(PROJECT_PATH_RULE);
  const path = expandHomePath(written, home);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw statFailure(error, path);
  }
  if (!info.isDirectory()) throw new GitError(`not a directory: ${path}`);
  return path;
}

/** What removing a project needs from the tasks that belong to it. */
export interface ProjectTasks {
  /**
   * Removes the project and the tasks that cascade with it as one task-mutation step, so a
   * create cannot record its task between the terminal check and the project's deletion. Rejects
   * with `HasLiveTerminalsError` while one of its sessions still runs and `ProjectNotFoundError`
   * when it is already gone.
   */
  removeProject(projectId: string): Promise<void>;
}

export class ProjectService {
  readonly #store: ProjectStore;
  readonly #tasks: ProjectTasks;
  readonly #issues: IssueImportService;
  readonly #home: string;
  readonly #changes = new ChangeFeed();

  constructor(
    store: ProjectStore,
    tasks: ProjectTasks,
    issues: IssueImportService,
    options: { home: string },
  ) {
    this.#store = store;
    this.#tasks = tasks;
    this.#issues = issues;
    this.#home = options.home;
  }

  list(): Project[] {
    return this.#store.list();
  }

  directories(path: string, signal?: AbortSignal) {
    return directoryCompletions(path, this.#home, signal);
  }

  watch(signal: AbortSignal | undefined): AsyncGenerator<Project[]> {
    return this.#changes.watch(() => this.list(), signal);
  }

  get(id: string): Project {
    const project = this.#store.get(id);
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  }

  async add(input: string): Promise<Project> {
    const path = await resolveProjectPath(input, this.#home);
    let root: string;
    try {
      root = await findMainWorkingTree(path);
    } catch (error) {
      // git also fails for a missing directory, a bare repository and a broken repository; only
      // its own not-a-repository refusal becomes the typed error, so the rest keeps its cause.
      if (error instanceof GitError && error.message.includes("not a git repository"))
        throw new NotAGitRepositoryError(path);
      throw error;
    }
    const baseBranch = await defaultBaseBranch(root);
    if (baseBranch === undefined)
      throw new GitError(`cannot tell which branch tasks start from: ${root} has no branch`);
    // No await between this check and the insert, so two adds of one path cannot both pass.
    const existing = this.#store.findByPath(root);
    if (existing) throw new ProjectExistsError(existing.id);
    const project: Project = {
      id: newId(),
      name: basename(root),
      path: root,
      defaultBaseBranch: baseBranch,
      pinnedAt: null,
    };
    this.#store.insert(project);
    this.#changes.notify();
    return project;
  }

  async remove(id: string): Promise<void> {
    // The task queue owns the check, the terminal close and the row deletion together: a create
    // holds that queue until its task and primary session are recorded, so removing the project
    // under a launch cannot cascade the task and strand the terminal it just started.
    await this.#tasks.removeProject(id);
    this.#changes.notify();
  }

  /** Pins a project at the current time, or clears the pin. A pin lives on the project row. */
  setPinned(id: string, pinned: boolean): Project {
    this.get(id);
    this.#store.setPinned(id, pinned ? Date.now() : null);
    const project = this.get(id);
    this.#changes.notify();
    return project;
  }

  /**
   * Local branches, then remote-tracking ones (`origin/x`), for targets a new worktree can check
   * out: a branch no worktree of the project holds, and a remote whose derived local branch is
   * free and does not conflict with a local branch above or below it.
   */
  async branches(id: string): Promise<string[]> {
    const { path } = this.get(id);
    const [{ local, remote }, checkedOut] = await Promise.all([
      listBranches(path),
      checkedOutBranches(path),
    ]);
    const localNames = new Set(local);
    return [
      ...local.filter((branch) => !checkedOut.has(branch)),
      ...remote.filter((branch) => {
        const localName = localNameOfRemote(branch);
        return !checkedOut.has(localName) && branchConflict(localName, localNames) === undefined;
      }),
    ];
  }

  /** Reads one issue through the server's CLI inside the project, with no remote changes. */
  resolveIssue(
    id: string,
    input: { url: string; provider?: IssueProvider | undefined },
    signal?: AbortSignal,
  ): Promise<TaskSource> {
    return this.#issues.resolve(this.get(id).path, input, signal);
  }
}

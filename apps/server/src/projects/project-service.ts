import type { IssueProvider, Project, TaskSource } from "@corral/protocol/rpc";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { ChangeFeed } from "../changes/change-feed.ts";
import { expandHomePath } from "../config/home-path.ts";
import { GitError } from "../git/git.ts";
import { defaultBaseBranch, findMainWorkingTree, listBranches } from "../git/repository.ts";
import type { IssueImportService } from "../issues/issue-import.ts";
import { newId } from "../storage/ids.ts";
import { NotAGitRepositoryError, ProjectExistsError, ProjectNotFoundError } from "./errors.ts";
import type { ProjectStore } from "./project-store.ts";

/** What a project path must be before git sees it: absolute, or relative to the server's home. */
const PROJECT_PATH_RULE = "the project path must be an absolute path or start with ~/";

/** The `code` of a failed filesystem call, for mapping it to a refusal. */
function ioErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
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
    const code = ioErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new GitError(`no such directory: ${path}`);
    throw error;
  }
  if (!info.isDirectory()) throw new GitError(`not a directory: ${path}`);
  return path;
}

/** What removing a project needs from the tasks that belong to it. */
export interface ProjectTasks {
  /** Closes the project's terminals; rejects with `HasLiveTerminalsError` while one still runs. */
  closeTerminalsOf(projectId: string): Promise<void>;
  /** The database dropped the project's tasks together with the project. */
  tasksDropped(): void;
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
    };
    this.#store.insert(project);
    this.#changes.notify();
    return project;
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    await this.#tasks.closeTerminalsOf(id);
    this.#store.delete(id);
    this.#tasks.tasksDropped();
    this.#changes.notify();
  }

  /** Local branches, then remote-tracking ones (`origin/x`). */
  async branches(id: string): Promise<string[]> {
    const { local, remote } = await listBranches(this.get(id).path);
    return [...local, ...remote];
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

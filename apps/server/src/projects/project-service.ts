import type { IssueProvider, Project, TaskSource } from "@corral/protocol/rpc";
import { basename } from "node:path";
import { ChangeFeed } from "../changes/change-feed.ts";
import { GitError } from "../git/git.ts";
import { defaultBaseBranch, findMainWorkingTree, listBranches } from "../git/repository.ts";
import type { IssueImportService } from "../issues/issue-import.ts";
import { newId } from "../storage/ids.ts";
import { NotAGitRepositoryError, ProjectExistsError, ProjectNotFoundError } from "./errors.ts";
import type { ProjectStore } from "./project-store.ts";

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
  readonly #changes = new ChangeFeed();

  constructor(store: ProjectStore, tasks: ProjectTasks, issues: IssueImportService) {
    this.#store = store;
    this.#tasks = tasks;
    this.#issues = issues;
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

  async add(path: string): Promise<Project> {
    let root: string;
    try {
      root = await findMainWorkingTree(path);
    } catch (error) {
      if (error instanceof GitError) throw new NotAGitRepositoryError(path);
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

export class NotAGitRepositoryError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`not a git repository: ${path}`);
    this.path = path;
  }
}

export class ProjectExistsError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`project already added: ${id}`);
    this.id = id;
  }
}

export class ProjectNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`no such project: ${id}`);
    this.id = id;
  }
}

export class HasLiveTerminalsError extends Error {
  constructor() {
    super("the project has tasks with running terminals");
  }
}

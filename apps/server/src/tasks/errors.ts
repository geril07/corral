export class TaskNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`no such task: ${id}`);
    this.id = id;
  }
}

export class WorktreeDirtyError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(`worktree has uncommitted changes: ${files.join(", ")}`);
    this.files = files;
  }
}

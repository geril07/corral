export class TaskNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`no such task: ${id}`);
    this.id = id;
  }
}

/** A title with nothing in it. The wire schema refuses it before the handler; a direct caller gets the same refusal. */
export class BlankTaskTitleError extends Error {
  constructor() {
    super("a task needs a title");
  }
}

export class WorktreeDirtyError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(`worktree has local changes, including ignored files: ${files.join(", ")}`);
    this.files = files;
  }
}

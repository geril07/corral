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

/** A wake time that is not an epoch millisecond time in the future. */
export class SnoozeTimeError extends Error {
  constructor(until: number) {
    super(`${until} is not a future wake time`);
  }
}

/** A task whose agent waits on the user cannot be hidden: the wake rule would return it at once. */
export class TaskNeedsUserError extends Error {
  constructor() {
    super("this task's agent is waiting on a permission or a question, so it cannot be snoozed");
  }
}

/** A settled task is already off the list, and two hidden states would need a rule for which shows. */
export class SettledTaskSnoozeError extends Error {
  constructor() {
    super("a settled task is already off the active list; make it active to snooze it");
  }
}

export class WorktreeDirtyError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(`worktree has local changes, including ignored files: ${files.join(", ")}`);
    this.files = files;
  }
}

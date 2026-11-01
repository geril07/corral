/** A `changes.diff` path that is not among the task's changed files. */
export class ChangeFileUnknownError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`'${path}' is not a changed file of this task`);
    this.path = path;
  }
}

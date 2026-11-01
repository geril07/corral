/** A `changes.diff` path that is not among the task's changed files. */
export class ChangeFileUnknownError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`'${path}' is not a changed file of this task`);
    this.path = path;
  }
}

/**
 * The remote's URL is not the one the user confirmed. The confirmation is the consent: a remote
 * rewritten between the dialog and the write (`insteadOf`, an edited `.git/config`) must not push.
 */
export class ChangesRemoteMismatchError extends Error {
  readonly remote: string;
  readonly confirmed: string;
  readonly actual: string;

  constructor(remote: string, confirmed: string, actual: string) {
    super(`remote '${remote}' is ${actual}, not the confirmed ${confirmed}`);
    this.remote = remote;
    this.confirmed = confirmed;
    this.actual = actual;
  }
}

/** No remote would take the push: no upstream, no `origin`, not exactly one remote. */
export class ChangesNoRemoteError extends Error {
  readonly branch: string;

  constructor(branch: string) {
    super(`no remote to push '${branch}' to`);
    this.branch = branch;
  }
}

/** The workspace is on another branch than the one the confirmation named. */
export class ChangesBranchMismatchError extends Error {
  readonly confirmed: string;
  readonly actual: string | null;

  constructor(confirmed: string, actual: string | null) {
    super(`the workspace is on ${actual ?? "a detached HEAD"}, not the confirmed '${confirmed}'`);
    this.confirmed = confirmed;
    this.actual = actual;
  }
}

/** Nothing is in the index; the commit is refused instead of failing with git's own sentence. */
export class ChangesNothingStagedError extends Error {
  constructor() {
    super("nothing is staged: select files to commit first");
  }
}

/** An empty or blank commit message; the UI keeps what the user typed. */
export class ChangesEmptyMessageError extends Error {
  constructor() {
    super("a commit needs a message");
  }
}

/** The remote does not have the branch, so a pull request would have to push first. */
export class ChangesPushRequiredError extends Error {
  readonly remote: string;
  readonly branch: string;

  constructor(remote: string, branch: string) {
    super(`${remote} has no branch '${branch}': push it first`);
    this.remote = remote;
    this.branch = branch;
  }
}

/** `gh` or `glab` is not on the server's PATH. */
export class PullRequestCliMissingError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`${command} is not on the server's PATH`);
    this.command = command;
  }
}

/** The server host's CLI has no usable login. */
export class PullRequestAuthRequiredError extends Error {
  readonly provider: "github" | "gitlab";

  constructor(provider: "github" | "gitlab") {
    super(`the server's ${provider} CLI is not authenticated`);
    this.provider = provider;
  }
}

/** The CLI failed; `message` is a sentence about the failure, never its own output. */
export class PullRequestFailedError extends Error {
  readonly provider: "github" | "gitlab";

  constructor(provider: "github" | "gitlab", message: string) {
    super(message);
    this.provider = provider;
  }
}

/** The CLI's answer is not a pull request Corral can read (another shape, empty output). */
export class PullRequestInvalidResponseError extends Error {
  readonly provider: "github" | "gitlab";

  constructor(provider: "github" | "gitlab") {
    super(`the ${provider} CLI returned something Corral could not read`);
    this.provider = provider;
  }
}

import { git, GitError, gitRead } from "./git.ts";

/**
 * The writes behind the Changes tab (C6): staging, committing and pushing, each one an action the
 * user confirmed. Plain `git`, not `gitRead`: these are meant to move the index, and the read model
 * (`readChanges`, `readFileDiff`) stays on `gitRead` so a read still writes nothing.
 *
 * Paths always come from Corral's own read model, and `GIT_LITERAL_PATHSPECS` keeps a name like
 * `*.txt` a file name; `--` ends the options so a path can never be read as one.
 */
const WRITE_ENV = { GIT_LITERAL_PATHSPECS: "1" } as const;

/** Stages (`staged: true`) or unstages exactly these paths, or every change in the workspace. */
export async function stagePaths(
  workspace: string,
  paths: readonly string[] | "all",
  staged: boolean,
): Promise<void> {
  if (staged) {
    // `git add` records a deletion too (git ≥ 2.0), so a removed file stages as a removal, and
    // `--all` without a pathspec is the whole worktree. An explicit path that is in neither the
    // index nor the worktree is dropped first: a committed rename still shows the old path in the
    // read model, but `git add` would refuse that pathspec instead of staging the new file.
    const targets = paths === "all" ? "all" : await presentPaths(workspace, paths);
    // Keep git's own refusal when no explicit path exists: a typo is an error, not a silent no-op.
    const requested = Array.isArray(targets) && targets.length === 0 ? paths : targets;
    await git(workspace, ["add", "--all", ...pathArgs(requested)], { env: WRITE_ENV });
    return;
  }
  /*
   * Unstaging what is not staged is a no-op, not an error: `git restore --staged -- .` on an empty
   * index fails with "fatal: pathspec '.' did not match any files" (and `git rm --cached` on a
   * repository with no commit does the same), which would surface as a git failure for a click that
   * had nothing to undo. The staged set is read here; explicit paths are intersected with it.
   */
  const current = await stagedPaths(workspace);
  if (current.length === 0) return;
  const targets = paths === "all" ? "all" : paths.filter((path) => current.includes(path));
  if (Array.isArray(targets) && targets.length === 0) return;
  // `git restore --staged` always wants a pathspec, so "everything" is `.` from the workspace root
  // (the task's worktree or the main tree). It also needs HEAD, so a repository with no commit yet
  // falls back to taking the paths out of the index directly — the first-commit case a staging UI
  // reaches before any commit exists. Only the staged paths go back: an explicit path from a
  // committed rename is gone and `git restore` would refuse it.
  try {
    await git(workspace, ["restore", "--staged", ...unstageArgs(targets)], { env: WRITE_ENV });
  } catch (error) {
    if (!(error instanceof GitError) || !/could not resolve 'HEAD'/.test(error.message))
      throw error;
    await git(workspace, ["rm", "--cached", "--quiet", "-r", ...unstageArgs(targets)], {
      env: WRITE_ENV,
    });
  }
}

/**
 * The explicit paths that exist in the index or the worktree. A directory matches through the files
 * below it, and an ignored file does not match: `git add --all` would not stage it either.
 */
async function presentPaths(workspace: string, paths: readonly string[]): Promise<string[]> {
  const listing = await gitRead(workspace, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...paths,
  ]);
  const present = listing.split("\0").filter((path) => path !== "");
  return paths.filter((path) =>
    present.some((entry) => entry === path || entry.startsWith(`${path}/`)),
  );
}

/** Paths in the index, sorted; the workspace's own staged set, not the whole repository's. */
export async function stagedPaths(workspace: string): Promise<string[]> {
  const listing = await gitRead(workspace, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
  ]);
  return listing
    .split("\0")
    .filter((path) => path !== "")
    .toSorted();
}

/**
 * Commits what is staged with the user's message and returns the new commit. Hooks run as they
 * would from a terminal; git's own deadline and closed stdin keep a hook from holding the RPC.
 */
export async function commit(
  workspace: string,
  message: string,
): Promise<{ sha: string; shortSha: string; subject: string }> {
  await git(workspace, ["commit", "-m", message], { env: WRITE_ENV });
  const sha = (await gitRead(workspace, ["rev-parse", "HEAD"])).trim();
  const [shortSha, subject] = (await gitRead(workspace, ["log", "-1", "--format=%h%n%s"])).split(
    "\n",
  );
  return { sha, shortSha: shortSha ?? sha.slice(0, 7), subject: subject ?? "" };
}

/**
 * Pushes `branch` to `remote` under its own name. Never `--force`, never `--delete`, and no
 * `--set-upstream`: the upstream is the user's to configure, and a missing one does not block a
 * push. Returns the commit the remote now has, as the branch's own id.
 */
export async function pushBranch(
  workspace: string,
  remote: string,
  branch: string,
): Promise<{ commit: string }> {
  await git(
    workspace,
    ["push", "--porcelain", "--", remote, `refs/heads/${branch}:refs/heads/${branch}`],
    {
      env: WRITE_ENV,
      // A push to a slow remote is the one git call that legitimately takes a while.
      timeoutMs: 120_000,
    },
  );
  const head = (await gitRead(workspace, ["rev-parse", `refs/heads/${branch}`])).trim();
  return { commit: head };
}

function pathArgs(paths: readonly string[] | "all"): string[] {
  return paths === "all" ? [] : ["--", ...paths];
}

function unstageArgs(paths: readonly string[] | "all"): string[] {
  return paths === "all" ? ["--", "."] : ["--", ...paths];
}

import { GitError, git, gitRead } from "./git.ts";
import { cappedPaths, changedPaths } from "./status-porcelain.ts";
import { worktreeRecords } from "./worktree-porcelain.ts";

export interface Branches {
  /** `main`, `feature/x` */
  local: string[];
  /** `origin/main`; the symbolic `origin/HEAD` is left out. */
  remote: string[];
}

/** The main working tree of the repository containing `path`; rejects with `GitError` outside a working tree. */
export async function findMainWorkingTree(path: string): Promise<string> {
  await git(path, ["rev-parse", "--show-toplevel"]);
  // The first entry is always the main working tree, also when `path` is in a linked one.
  const listing = await git(path, ["worktree", "list", "--porcelain", "-z"]);
  const first = worktreeRecords(listing)[0];
  if (first === undefined) throw new GitError(`unexpected worktree list: ${listing}`);
  return first.path;
}

/** Checked-out branch of the working tree at `path`; undefined when HEAD is detached. */
export async function currentBranch(path: string): Promise<string | undefined> {
  const branch = (await git(path, ["branch", "--show-current"])).trim();
  return branch === "" ? undefined : branch;
}

/** `origin/HEAD`'s branch, else the current branch, else `main`/`master` or the first local branch. */
export async function defaultBaseBranch(repo: string): Promise<string | undefined> {
  const originHead = await git(repo, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
    .then((out) => out.trim())
    .catch(() => "");
  if (originHead.startsWith("origin/")) return originHead.slice("origin/".length);
  const current = await currentBranch(repo);
  if (current) return current;
  const { local } = await listBranches(repo);
  return ["main", "master"].find((name) => local.includes(name)) ?? local[0];
}

/**
 * Every branch checked out in the repository's worktrees (the main tree included), by branch name,
 * with the path of the worktree that holds it. A detached worktree holds no branch.
 */
export async function checkedOutBranches(repo: string): Promise<Map<string, string>> {
  const listing = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  const checkedOut = new Map<string, string>();
  for (const record of worktreeRecords(listing))
    if (record.branch !== undefined) checkedOut.set(record.branch, record.path);
  return checkedOut;
}

export async function listBranches(repo: string): Promise<Branches> {
  const out = await git(repo, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches: Branches = { local: [], remote: [] };
  for (const ref of out.split("\n")) {
    if (ref.startsWith("refs/heads/")) branches.local.push(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD"))
      branches.remote.push(ref.slice("refs/remotes/".length));
  }
  return branches;
}

/** Whether `name` is acceptable as a local branch name. */
export async function isValidBranchName(repo: string, name: string): Promise<boolean> {
  try {
    await git(repo, ["check-ref-format", "--branch", name]);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

/** Rejects with `GitError` unless `rev` names a commit. */
export async function requireCommit(repo: string, rev: string): Promise<void> {
  try {
    await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  } catch (error) {
    if (error instanceof GitError) throw new GitError(`not a branch or commit: ${rev}`);
    throw error;
  }
}

/** Creates local `branch` at `base` without an upstream; rejects when the branch exists. */
export async function createBranch(
  repo: string,
  options: { branch: string; base: string },
): Promise<void> {
  // --no-track: the new branch must not push to or pull from the branch it started at.
  await git(repo, ["branch", "--no-track", "--", options.branch, options.base]);
}

/** Creates local `branch` tracking `remoteBranch` (`origin/x`); rejects when the branch exists. */
export async function createTrackingBranch(
  repo: string,
  options: { branch: string; remoteBranch: string },
): Promise<void> {
  await git(repo, ["branch", "--track", "--", options.branch, options.remoteBranch]);
}

export async function addWorktreeOnExistingBranch(
  repo: string,
  options: { path: string; branch: string },
): Promise<void> {
  await git(repo, ["worktree", "add", "--", options.path, options.branch]);
}

export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  await git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), "--", path]);
}

/** Forgets worktrees whose directory is gone. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

/** Force-deletes `branch`, merged or not; callers only use it for a branch they just created. */
export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ["branch", "-D", "--", branch]);
}

/** The most local paths one removal warning lists; the rest become a final `+N more` entry. */
export const MAX_LOCAL_PATHS = 20;

/**
 * Paths with local changes, ignored entries included; a directory is one `dir/` path. The list is
 * capped so an ignored `node_modules/` with a million files still costs one `git status`.
 */
export async function uncommittedPaths(worktree: string): Promise<string[]> {
  const paths = changedPaths(await gitRead(worktree, ["status", "--porcelain", "--ignored", "-z"]));
  return cappedPaths(paths, MAX_LOCAL_PATHS);
}

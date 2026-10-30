import { GitError, git } from "./git.ts";
import { changedPaths } from "./status-porcelain.ts";

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
  const listing = await git(path, ["worktree", "list", "--porcelain"]);
  const first = listing.split("\n")[0] ?? "";
  if (!first.startsWith("worktree ")) throw new GitError(`unexpected worktree list: ${listing}`);
  return first.slice("worktree ".length);
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

export async function addWorktreeOnNewBranch(
  repo: string,
  options: { path: string; branch: string; base: string },
): Promise<void> {
  // --no-track: the new branch must not push to or pull from the branch it started at.
  await git(repo, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    options.branch,
    "--",
    options.path,
    options.base,
  ]);
}

export async function addWorktreeOnExistingBranch(
  repo: string,
  options: { path: string; branch: string },
): Promise<void> {
  await git(repo, ["worktree", "add", "--", options.path, options.branch]);
}

/** Creates local `branch` tracking `remoteBranch` (`origin/x`). */
export async function addWorktreeTrackingRemote(
  repo: string,
  options: { path: string; branch: string; remoteBranch: string },
): Promise<void> {
  await git(repo, [
    "worktree",
    "add",
    "--track",
    "-b",
    options.branch,
    "--",
    options.path,
    options.remoteBranch,
  ]);
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

/** Paths with uncommitted or untracked changes (untracked directories are listed as `dir/`). */
export async function uncommittedPaths(worktree: string): Promise<string[]> {
  return changedPaths(await git(worktree, ["status", "--porcelain", "-z"]));
}

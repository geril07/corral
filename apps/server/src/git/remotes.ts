import type { ChangesRemote } from "@corral/protocol/rpc";
import { git, GitError, gitRead } from "./git.ts";

/**
 * A remote as the confirmation shows it: the name git's argv takes and the URL the user was shown.
 * Every remote write carries both back, so a URL that changed after the confirmation is refused
 * instead of being pushed to (`CHANGES_REMOTE_MISMATCH`).
 */
export type RemoteRef = ChangesRemote;

/** Every configured remote, sorted by name. A remote without a URL is left out. */
export async function listRemotes(workspace: string): Promise<RemoteRef[]> {
  const listing = await gitRead(workspace, ["remote"]);
  const names = listing
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .toSorted();
  const remotes: RemoteRef[] = [];
  for (const name of names) {
    // oxlint-disable-next-line no-await-in-loop -- one name at a time keeps the reads ordered
    const url = await remoteUrl(workspace, name);
    if (url !== undefined) remotes.push({ name, url });
  }
  return remotes;
}

/** The fetch URL of `name`, or `undefined` when there is no such remote. */
export async function remoteUrl(workspace: string, name: string): Promise<string | undefined> {
  try {
    const url = (await gitRead(workspace, ["remote", "get-url", "--", name])).trim();
    return url === "" ? undefined : url;
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

/**
 * The remote a push of `branch` would use (C6 decision c): the remote its upstream is configured
 * on (`branch.<name>.remote`), else `origin`, else the only configured remote. `undefined` means no
 * remote would take the push, and the push is refused rather than guessed. An upstream that is a
 * local worktree (`.`) is not a remote, so the fallback applies.
 */
export async function resolvePushRemote(
  workspace: string,
  branch: string,
): Promise<RemoteRef | undefined> {
  const remotes = await listRemotes(workspace);
  if (remotes.length === 0) return undefined;
  const configured = await gitRead(workspace, ["config", "--get", `branch.${branch}.remote`])
    .then((output) => output.trim())
    .catch(() => "");
  const upstream = remotes.find((remote) => remote.name === configured);
  if (upstream !== undefined) return upstream;
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin !== undefined) return origin;
  return remotes.length === 1 ? remotes[0] : undefined;
}

/** Whether `remote` already has `branch`: what makes `gh pr create` safe, because it only pushes when it does not. */
export async function remoteHasBranch(
  workspace: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  const listing = await gitRead(workspace, [
    "ls-remote",
    "--heads",
    "--",
    remote,
    `refs/heads/${branch}`,
  ]);
  return listing.trim() !== "";
}

/** The branch checked out in `workspace`, or `undefined` when HEAD is detached. */
export async function checkedOutBranch(workspace: string): Promise<string | undefined> {
  const branch = (await git(workspace, ["branch", "--show-current"])).trim();
  return branch === "" ? undefined : branch;
}

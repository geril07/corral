import type { ChangesRemote } from "@corral/protocol/rpc";
import { git, GitError, gitRead } from "./git.ts";

/**
 * A remote as the confirmation shows it: the name git's argv takes and the **push** URL — the
 * address a push actually reaches, which is not always the fetch URL (`remote.<name>.pushurl`).
 * Every remote write carries both back, and the server re-reads them before git runs, so a URL that
 * changed after the confirmation is refused instead of being pushed to (`CHANGES_REMOTE_MISMATCH`).
 */
export type RemoteRef = ChangesRemote;

/** Every configured remote, sorted by name, with its push URL. A remote without one is left out. */
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
    const url = await remotePushUrl(workspace, name);
    if (url !== undefined) remotes.push({ name, url });
  }
  return remotes;
}

/**
 * The address a push to `name` goes to: `git remote get-url --push`, which honours
 * `remote.<name>.pushurl` and falls back to the fetch URL. Naming the fetch URL in a confirmation
 * while git pushes somewhere else is exactly the mismatch this slice must not allow.
 */
export async function remotePushUrl(workspace: string, name: string): Promise<string | undefined> {
  try {
    const url = (await gitRead(workspace, ["remote", "get-url", "--push", "--", name])).trim();
    return url === "" ? undefined : url;
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

/**
 * The remote's configured **push** URL as written in `.git/config`, before git's `insteadOf`
 * rewrite: the name of the forge repository, which is what `gh`/`glab` need for `--repo` (a
 * rewrite to a local mirror or an ssh alias is not a repository name). `remotePushUrl` above is the
 * expanded address a push really reaches, which is what the confirmation names.
 */
export async function remoteConfiguredPushUrl(
  workspace: string,
  name: string,
): Promise<string | undefined> {
  const configured = (key: string) =>
    gitRead(workspace, ["config", "--get", key])
      .then((output) => output.trim())
      .catch(() => "");
  const push = await configured(`remote.${name}.pushurl`);
  if (push !== "") return push;
  const url = await configured(`remote.${name}.url`);
  return url === "" ? undefined : url;
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

/**
 * The commit `destination` has for `branch`, or `undefined` when it has none. The destination is the
 * **push URL** the user confirmed (a URL, not a remote name: `ls-remote` on a name reads the fetch
 * URL). A branch that exists at an older commit is not a pushed branch, which is why the caller
 * compares this with the local branch tip.
 */
export async function remoteBranchCommit(
  workspace: string,
  destination: string,
  branch: string,
): Promise<string | undefined> {
  const listing = await gitRead(workspace, [
    "ls-remote",
    "--heads",
    "--",
    destination,
    `refs/heads/${branch}`,
  ]);
  const line = listing.split("\n").find((entry) => entry.trim() !== "");
  return line?.split(/\s+/)[0];
}

/** The branch checked out in `workspace`, or `undefined` when HEAD is detached. */
export async function checkedOutBranch(workspace: string): Promise<string | undefined> {
  const branch = (await git(workspace, ["branch", "--show-current"])).trim();
  return branch === "" ? undefined : branch;
}

/** The commit a local branch points at, or `undefined` when it does not exist. */
export async function localBranchCommit(
  workspace: string,
  branch: string,
): Promise<string | undefined> {
  try {
    return (await gitRead(workspace, ["rev-parse", "--verify", `refs/heads/${branch}`])).trim();
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

/** A repository a CLI can be pointed at: `owner/repo` (or nested for GitLab) under a host. */
export interface RemoteDestination {
  /** Plain host, no port and no credentials: what `gh`'s `[HOST/]OWNER/REPO` takes. */
  host: string;
  /** Path segments without the trailing `.git`. */
  segments: string[];
}

const SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;

/**
 * The forge repository a push URL names, or `undefined` for a local path, a `file:` URL, a host
 * with a port or a path that is not a repository (`owner/repo`, or nested for GitLab). The CLI
 * calls pass it as `--repo`, so they act on the confirmed repository rather than on whichever
 * remote they happen to resolve — a fork beside an upstream is the case this closes.
 */
export function remoteDestination(url: string): RemoteDestination | undefined {
  if (/^[a-z]:/i.test(url) || /^(?:\/\/|\\\\)/.test(url) || /^file:/i.test(url)) return undefined;
  let host: string | undefined;
  let path: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    // A password is always a credential; an ssh user is the login, not a secret.
    if (parsed.password !== "") return undefined;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (parsed.username !== "") return undefined;
      // A web port is part of the host the CLI would have to be told about, and gh's form has none.
      if (parsed.port !== "") return undefined;
      host = parsed.hostname;
    } else if (parsed.protocol === "ssh:" || parsed.protocol === "git:") {
      // ssh and git ports are transport, not web/API ports: the host is what names the repository.
      host = parsed.hostname;
    } else return undefined;
    path = parsed.pathname;
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (scp === null) return undefined;
    host = scp[1];
    path = scp[2];
  }
  if (host === undefined || path === undefined) return undefined;
  const segments = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length < 2) return undefined;
  if (!segments.every((segment) => SEGMENT.test(segment))) return undefined;
  return { host: host.toLowerCase(), segments };
}

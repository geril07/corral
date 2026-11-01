import { isAbsolute, resolve } from "node:path";

/**
 * What is wrong with a worktree root as written, or `undefined` when it is usable: an absolute
 * path or one below `~`, and a `~`-relative root may not climb out of the home directory.
 * "Absolute" is the platform's rule (`isAbsolute`), so `C:\wt` is a root on Windows and `/wt`
 * elsewhere; the config is read by the server on the machine that uses it.
 */
export function worktreeRootProblem(root: string): string | undefined {
  if (root === "~") return undefined;
  if (root.startsWith("~/")) {
    const climbs = root
      .slice(1)
      .split("/")
      .some((segment) => segment === "..");
    return climbs ? 'a ~-relative worktree root may not hold ".."' : undefined;
  }
  return isAbsolute(root)
    ? undefined
    : "the worktree root must be an absolute path or start with ~/";
}

/**
 * The absolute directory a worktree root names, with `~` expanded and separators collapsed by
 * the platform's `resolve`. Consumers call this before touching the filesystem, so a root has
 * one meaning everywhere; an unusable root throws the message `worktreeRootProblem` reports.
 */
export function expandWorktreeRoot(root: string, home: string): string {
  const problem = worktreeRootProblem(root);
  if (problem !== undefined) throw new Error(problem);
  if (root === "~") return resolve(home);
  if (root.startsWith("~/")) return resolve(home, root.slice(1).replace(/^[/\\]+/, ""));
  return resolve(root);
}

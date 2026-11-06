import { rmSync } from "node:fs";

/**
 * The server-side half of the browser command: deletes a task's workspace the way a user cleaning
 * up outside Corral does. Unlike `git worktree remove`, it leaves the git worktree entry stale, so
 * a removal test can see the prune.
 */
export function removeDirectoryIn(_context: unknown, path: string): void {
  rmSync(path, { recursive: true, force: true });
}

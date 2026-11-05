export interface WorktreeRecord {
  path: string;
  /** The checked-out branch; a detached worktree has none. */
  branch?: string;
}

/**
 * Worktrees named by `git worktree list --porcelain -z`. A NUL ends every field and an empty
 * field ends the record, so a path holding a newline is one path and cannot become a field of
 * its own. `branch refs/heads/<name>` names the checked-out branch.
 */
export function worktreeRecords(porcelainZ: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const field of porcelainZ.split("\0")) {
    if (field === "") current = undefined;
    else if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length) };
      records.push(current);
    } else if (field.startsWith("branch refs/heads/") && current !== undefined) {
      current.branch = field.slice("branch refs/heads/".length);
    }
  }
  return records;
}

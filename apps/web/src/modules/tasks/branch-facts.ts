/**
 * A task keeps the branch it had when it was created (`Task.branch`); the workspace can be on
 * another branch, or none, by the time it is read. These helpers keep that one distinction in one
 * place (`docs/layout.md`, **Task header**): git has no branch on a detached HEAD, which the
 * protocol records as `"HEAD"` at create and reports as `null` live.
 */

/** The branch a read names, or `undefined` for an empty value, `"HEAD"` or no read at all. */
export function branchName(branch: string | null | undefined): string | undefined {
  if (branch === null || branch === undefined) return undefined;
  const name = branch.trim();
  return name === "" || name === "HEAD" ? undefined : name;
}

/**
 * The recorded label split into the name and its qualifier, so a narrow row can truncate the name
 * while keeping the qualifier whole.
 */
export function recordedBranchParts(
  branch: string,
  detached = "no branch",
): { readonly name: string | undefined; readonly qualifier: string } {
  const name = branchName(branch);
  return { name, qualifier: name === undefined ? detached : "(recorded)" };
}

/** The compact recorded label; the header passes `"detached"` where the long form would not fit. */
export function recordedBranchLabel(branch: string, detached = "no branch"): string {
  const { name, qualifier } = recordedBranchParts(branch, detached);
  return name === undefined ? qualifier : `${name} ${qualifier}`;
}

/** The accessible name spells out the qualifier that the visual label abbreviates. */
export function recordedBranchAccessible(branch: string): string {
  const name = branchName(branch);
  return name === undefined ? "no branch checked out at create" : `${name} (recorded at create)`;
}

/** Changes' drift line; none when the two reads agree or either side has no branch. */
export function branchDrift(recorded: string, live: string | null | undefined): string | undefined {
  const createdOn = branchName(recorded);
  const checkedOutNow = branchName(live);
  if (createdOn === undefined || checkedOutNow === undefined || createdOn === checkedOutNow) {
    return undefined;
  }
  return `Checked out now: ${checkedOutNow} · the task was created on ${createdOn}.`;
}

/**
 * What Remove promises about the branch. `undefined` is a read still pending or unavailable; a
 * `null` live branch is a detached HEAD, which is not the recorded name either.
 */
export function removalBranchCopy(live: string | null | undefined): string {
  const name = branchName(live);
  if (name !== undefined) return `The branch ${name} stays.`;
  if (live === null) return "No branch is checked out in the worktree; branches are not deleted.";
  return "The branch checked out in the worktree stays.";
}

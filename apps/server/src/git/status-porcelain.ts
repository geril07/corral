/**
 * Paths named by `git status --porcelain -z`, ignored entries included. Entries are `XY <path>`
 * separated by NUL; a rename or copy is followed by one more entry holding the original path,
 * which is not a changed file of its own.
 */
export function changedPaths(porcelainZ: string): string[] {
  const entries = porcelainZ.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") i++;
  }
  return paths;
}

/** At most `limit` paths, then one `+N more` entry for the rest. */
export function cappedPaths(paths: string[], limit: number): string[] {
  return paths.length <= limit
    ? paths
    : [...paths.slice(0, limit), `+${paths.length - limit} more`];
}

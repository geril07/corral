const MAX_SLUG_LENGTH = 50;

/** Lowercase ASCII words joined by `-`, for a branch name derived from a task title. Never empty. */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" ? "task" : slug;
}

/** `base`, else `base-2`, `base-3`, … — the first candidate `isTaken` does not claim. */
export function uniqueName(base: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/**
 * Whether a new branch `name` cannot be created next to `existing` branches: the same name, or
 * a branch under `name/` (git stores refs as files, so `a` and `a/b` cannot both exist).
 */
export function branchNameTaken(name: string, existing: ReadonlySet<string>): boolean {
  if (existing.has(name)) return true;
  for (const branch of existing) if (branch.startsWith(`${name}/`)) return true;
  return false;
}

/** One safe path segment for a directory named after `name` (a branch or project name). Never empty. */
export function directoryName(name: string): string {
  const segment = name.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^[-.]+|[-.]+$/g, "");
  return segment === "" ? "task" : segment;
}

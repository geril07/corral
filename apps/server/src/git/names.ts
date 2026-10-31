const MAX_SLUG_LENGTH = 50;

/**
 * Lowercase ASCII words joined by `-`, at most 50 characters; empty when nothing usable is left.
 * Total: any text in, a safe single ref segment or `""` out.
 */
export function sanitizeSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, "");
}

/** `sanitizeSlug` of a task title, or `task` when that is empty. Never empty. */
export function slugifyTitle(title: string): string {
  const slug = sanitizeSlug(title);
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
 * The first ref above `name` that `existing` already holds (`a` for `a/b/c`), if any: git stores
 * refs as files, so `a` and `a/b` cannot both exist. `undefined` when every ancestor is free.
 */
export function takenAncestor(name: string, existing: ReadonlySet<string>): string | undefined {
  const segments = name.split("/");
  for (let count = 1; count < segments.length; count++) {
    const ancestor = segments.slice(0, count).join("/");
    if (existing.has(ancestor)) return ancestor;
  }
  return undefined;
}

/**
 * Whether a new branch `name` cannot be created next to `existing` branches: the same name, a
 * branch under `name/`, or a branch `name` would sit under.
 */
export function branchNameTaken(name: string, existing: ReadonlySet<string>): boolean {
  return branchConflict(name, existing) !== undefined;
}

/**
 * The existing ref that keeps `name` from being created: itself, a ref above it (`a` for `a/b/c`),
 * or a ref below it (`a/b/c` for `a`); git stores refs as files. `undefined` when `name` is free.
 */
export function branchConflict(name: string, existing: ReadonlySet<string>): string | undefined {
  if (existing.has(name)) return name;
  const ancestor = takenAncestor(name, existing);
  if (ancestor !== undefined) return ancestor;
  for (const branch of existing) if (branch.startsWith(`${name}/`)) return branch;
  return undefined;
}

/** One safe path segment for a directory named after `name` (a branch or project name). Never empty. */
export function directoryName(name: string): string {
  const segment = name.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^[-.]+|[-.]+$/g, "");
  return segment === "" ? "task" : segment;
}

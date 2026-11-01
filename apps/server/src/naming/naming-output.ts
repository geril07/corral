import { sanitizeSlug } from "../git/names.ts";
import { seedTitle } from "../tasks/seed-title.ts";

/** The longest generated slug; short enough for a readable branch and directory name. */
export const MAX_GENERATED_SLUG_LENGTH = 40;

/** The name a naming response asked for. `branch` and `worktree` are raw strings from `generated` mode. */
export interface NamingName {
  title: string;
  branch?: string;
  worktree?: string;
}

export type NamingParse = { ok: true; name: NamingName } | { ok: false; reason: string };

/**
 * One line, at most 60 characters: the same shape as a seed title, so a generated title can
 * replace one without changing what the sidebar has room for. Control characters (newlines
 * included) become spaces rather than being stored, so a title is always one visible line.
 */
export function sanitizeTitle(value: string): string {
  return seedTitle(value.replaceAll(/[\p{Cc}]+/gu, " "));
}

/** A slug from a naming response: lowercase ASCII letters, digits and `-`, at most 40 characters. */
export function sanitizeGeneratedSlug(value: string): string {
  return sanitizeSlug(value).slice(0, MAX_GENERATED_SLUG_LENGTH).replaceAll(/-+$/g, "");
}

/**
 * The first JSON object in `stdout`, parsed. Models sometimes wrap the object in prose or a code
 * fence, so everything before and after it is ignored; a `{` that does not start a valid object
 * is skipped. Anything else is a failure with a reason that is safe to log.
 */
export function parseNamingOutput(
  stdout: string,
  options: { generatedSlug: boolean },
): NamingParse {
  for (let start = stdout.indexOf("{"); start >= 0; start = stdout.indexOf("{", start + 1)) {
    const end = objectEnd(stdout, start);
    if (end === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(stdout.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const record = value;
    const rawTitle = record["title"];
    if (typeof rawTitle !== "string") return { ok: false, reason: "the response has no title" };
    const title = sanitizeTitle(rawTitle);
    if (title === "") return { ok: false, reason: "the response's title is empty" };
    if (!options.generatedSlug) return { ok: true, name: { title } };
    const branch = record["branch"];
    const worktree = record["worktree"];
    if (typeof branch !== "string" || typeof worktree !== "string")
      return { ok: false, reason: "the response has no branch and worktree" };
    return { ok: true, name: { title, branch, worktree } };
  }
  return { ok: false, reason: "the response has no JSON object" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The index of the `}` that closes the object starting at `start`, ignoring braces in strings. */
function objectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

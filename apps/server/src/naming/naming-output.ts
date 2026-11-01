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
 * replace one without changing what the sidebar has room for. Control and format characters
 * (newlines and bidi overrides included) become spaces rather than being stored, so a title is
 * one visible line in a predictable order.
 */
export function sanitizeTitle(value: string): string {
  return seedTitle(value.replaceAll(/[\p{Cc}\p{Cf}]+/gu, " "));
}

/** A slug from a naming response: lowercase ASCII letters, digits and `-`, at most 40 characters. */
export function sanitizeGeneratedSlug(value: string): string {
  return sanitizeSlug(value).slice(0, MAX_GENERATED_SLUG_LENGTH).replaceAll(/-+$/g, "");
}

/** How many `{` candidates one answer may try; bounds a brace flood to a small constant. */
const MAX_CANDIDATE_ATTEMPTS = 64;

/**
 * The first valid JSON object in `stdout`, parsed. Models sometimes wrap the object in prose or a
 * code fence, so everything before and after it is ignored.
 *
 * Each `{` starts a candidate. A candidate that does not parse is abandoned by rewinding one
 * character past its start, so prose with a stray brace before the object does not hide it; at
 * most `MAX_CANDIDATE_ATTEMPTS` candidates are tried, which keeps a flood of unbalanced braces
 * linear in practice instead of quadratic.
 *
 * A generated-mode reply that names no branch or worktree still yields its title; the caller
 * falls back to the title's slug for both names. Anything that is not an object with a usable
 * title is a failure with a reason that is safe to log.
 */
export function parseNamingOutput(
  stdout: string,
  options: { generatedSlug: boolean },
): NamingParse {
  let from = 0;
  for (let attempt = 0; attempt < MAX_CANDIDATE_ATTEMPTS; attempt++) {
    const candidate = nextCandidate(stdout, from);
    if (candidate === undefined) break;
    if (candidate.record !== undefined) return nameFrom(candidate.record, options);
    // The balanced text was not JSON: the real object may start at any later brace, including
    // one inside the failed candidate.
    from = candidate.start + 1;
  }
  return { ok: false, reason: "the response has no JSON object" };
}

/** The first `{` at or after `from`, its matching `}`, and the parsed record when it is JSON. */
function nextCandidate(
  text: string,
  from: number,
): { start: number; record: Record<string, unknown> | undefined } | undefined {
  const start = text.indexOf("{", from);
  if (start < 0) return undefined;
  let depth = 1;
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
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
      if (depth === 0) return { start, record: objectAt(text.slice(start, index + 1)) };
    }
  }
  return { start, record: undefined };
}

function objectAt(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function nameFrom(
  record: Record<string, unknown>,
  options: { generatedSlug: boolean },
): NamingParse {
  const rawTitle = record["title"];
  if (typeof rawTitle !== "string") return { ok: false, reason: "the response has no title" };
  const title = sanitizeTitle(rawTitle);
  if (title === "") return { ok: false, reason: "the response's title is empty" };
  // The prompt's own placeholder (`…`) is a valid answer shape but not a name; keeping the seed
  // title is better than replacing it with punctuation.
  if (!/[\p{L}\p{N}]/u.test(title))
    return { ok: false, reason: "the response's title has no letters or digits" };
  if (!options.generatedSlug) return { ok: true, name: { title } };
  const branch = record["branch"];
  const worktree = record["worktree"];
  return {
    ok: true,
    name: {
      title,
      ...(typeof branch === "string" ? { branch } : {}),
      ...(typeof worktree === "string" ? { worktree } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

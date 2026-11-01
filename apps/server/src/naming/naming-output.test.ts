import { expect, test } from "vite-plus/test";
import {
  MAX_GENERATED_SLUG_LENGTH,
  parseNamingOutput,
  sanitizeGeneratedSlug,
  sanitizeTitle,
} from "./naming-output.ts";

const TITLE = { generatedSlug: false };
const GENERATED = { generatedSlug: true };

test("the first JSON object is read through prose and code fences", () => {
  expect(
    parseNamingOutput('Here you go:\n```json\n{"title": "Add OAuth login"}\n```\nDone.', TITLE),
  ).toEqual({ ok: true, name: { title: "Add OAuth login" } });
});

test("a brace that does not start an object is skipped, and braces inside strings do not end one", () => {
  expect(parseNamingOutput('Use {this} then {"title": "Fix {login}"}', TITLE)).toEqual({
    ok: true,
    name: { title: "Fix {login}" },
  });
});

test("an unmatched prose brace before the object does not hide the title", () => {
  expect(parseNamingOutput('I could not { do that. {"title":"Add OAuth"}', TITLE)).toEqual({
    ok: true,
    name: { title: "Add OAuth" },
  });
});

test("generated mode carries the raw branch and worktree for the caller to check", () => {
  expect(
    parseNamingOutput(
      JSON.stringify({ title: "Add OAuth login", branch: "OAuth SSO", worktree: "oauth-sso" }),
      GENERATED,
    ),
  ).toEqual({
    ok: true,
    name: { title: "Add OAuth login", branch: "OAuth SSO", worktree: "oauth-sso" },
  });
});

test("generated mode keeps a good title when the reply names no branch or worktree", () => {
  expect(parseNamingOutput('{"title": "Add OAuth login"}', GENERATED)).toEqual({
    ok: true,
    name: { title: "Add OAuth login" },
  });
  expect(
    parseNamingOutput('{"title": "Add OAuth login", "branch": "oauth-sso"}', GENERATED),
  ).toEqual({ ok: true, name: { title: "Add OAuth login", branch: "oauth-sso" } });
});

test("anything that is not a JSON object with a title is a failure with a loggable reason", () => {
  expect(parseNamingOutput("I could not name this.", TITLE)).toEqual({
    ok: false,
    reason: "the response has no JSON object",
  });
  expect(parseNamingOutput("{}", TITLE)).toEqual({
    ok: false,
    reason: "the response has no title",
  });
  expect(parseNamingOutput('{"title": "  "}', TITLE)).toEqual({
    ok: false,
    reason: "the response's title is empty",
  });
  // The prompt's own placeholder, echoed back, is not a name.
  expect(parseNamingOutput('{"title": "…"}', TITLE)).toEqual({
    ok: false,
    reason: "the response's title has no letters or digits",
  });
  expect(parseNamingOutput('{"title": "!!!"}', TITLE)).toEqual({
    ok: false,
    reason: "the response's title has no letters or digits",
  });
  expect(parseNamingOutput("[1, 2]", TITLE)).toEqual({
    ok: false,
    reason: "the response has no JSON object",
  });
});

test("an unbalanced brace flood fails in bounded time", () => {
  // 64 candidate attempts over 100k braces: linear with a small constant, not one rescan per `{`.
  const started = Date.now();
  expect(parseNamingOutput("{".repeat(100_000), TITLE)).toEqual({
    ok: false,
    reason: "the response has no JSON object",
  });
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a title is one line, without control or format characters, at most 60 characters", () => {
  expect(sanitizeTitle("  Add\u0007 OAuth\nsecond line  ")).toBe("Add OAuth second line");
  // U+202E (right-to-left override) and U+202C (pop) can visually reorder a row.
  expect(sanitizeTitle("Fix \u202Eevil\u202C login")).toBe("Fix evil login");
  expect(sanitizeTitle("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
  expect(sanitizeTitle(" \n\t ")).toBe("");
});

test("a generated slug is lowercase, safe and at most 40 characters", () => {
  expect(sanitizeGeneratedSlug("OAuth SSO")).toBe("oauth-sso");
  expect(sanitizeGeneratedSlug("../Release 1.2!")).toBe("release-1-2");
  expect(sanitizeGeneratedSlug("!!!")).toBe("");
  expect(sanitizeGeneratedSlug("a".repeat(41))).toHaveLength(MAX_GENERATED_SLUG_LENGTH);
  expect(sanitizeGeneratedSlug(`${"a".repeat(39)}-tail`).endsWith("-")).toBe(false);
});

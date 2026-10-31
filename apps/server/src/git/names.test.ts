import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  branchNameTaken,
  directoryName,
  sanitizeSlug,
  slugifyTitle,
  takenAncestor,
  uniqueName,
} from "./names.ts";

describe("sanitizeSlug", () => {
  test("anything becomes one lowercase ref segment, or nothing at all", () => {
    expect(sanitizeSlug("OAuth SSO")).toBe("oauth-sso");
    expect(sanitizeSlug("  ../Release 1.2!  ")).toBe("release-1-2");
    expect(sanitizeSlug("")).toBe("");
    expect(sanitizeSlug("---")).toBe("");
    expect(sanitizeSlug("日本語 ✨")).toBe("");
  });

  test("the result is never a path, never longer than the limit, and is its own slug", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        const slug = sanitizeSlug(text);
        expect(slug).toMatch(/^$|^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(slug.length).toBeLessThanOrEqual(50);
        expect(sanitizeSlug(slug)).toBe(slug);
      }),
    );
  });
});

describe("slugifyTitle", () => {
  test.each([
    ["Fix the login bug", "fix-the-login-bug"],
    ["  Add  OAuth / SSO!  ", "add-oauth-sso"],
    ["Café déjà vu", "cafe-deja-vu"],
    ["v1.2.3", "v1-2-3"],
  ])("%j becomes %j", (title, slug) => {
    expect(slugifyTitle(title)).toBe(slug);
  });

  test("a title with no ASCII letters or digits still gives a usable name", () => {
    expect(slugifyTitle("日本語 ✨")).toBe("task");
    expect(slugifyTitle("---")).toBe("task");
  });

  test("a long title is cut without leaving a trailing dash", () => {
    const slug = slugifyTitle("word ".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("any title gives a non-empty lowercase ASCII slug that is a valid single ref segment", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (title) => {
        const slug = slugifyTitle(title);
        expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(slug.length).toBeLessThanOrEqual(50);
      }),
    );
  });

  test("a slug is its own slug", () => {
    fc.assert(
      fc.property(fc.string(), (title) => {
        const slug = slugifyTitle(title);
        expect(slugifyTitle(slug)).toBe(slug);
      }),
    );
  });
});

describe("uniqueName", () => {
  test("keeps a free name and numbers a taken one from 2", () => {
    expect(uniqueName("fix", () => false)).toBe("fix");
    expect(uniqueName("fix", (name) => name === "fix")).toBe("fix-2");
    expect(uniqueName("fix", (name) => ["fix", "fix-2", "fix-3"].includes(name))).toBe("fix-4");
  });

  test("the result is never taken, and it is the base whenever the base is free", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 6 })),
        fc.string({ maxLength: 6 }),
        (taken, base) => {
          const takenSet = new Set(taken);
          const name = uniqueName(base, (candidate) => takenSet.has(candidate));
          expect(takenSet.has(name)).toBe(false);
          expect(name === base || takenSet.has(base)).toBe(true);
        },
      ),
    );
  });
});

describe("branchNameTaken", () => {
  test("a name is taken by the same branch, by a branch below it, or by a branch above it", () => {
    const existing = new Set(["main", "feature/login", "fix-2", "corral"]);
    expect(branchNameTaken("main", existing)).toBe(true);
    expect(branchNameTaken("feature", existing)).toBe(true);
    expect(branchNameTaken("feat", existing)).toBe(false);
    expect(branchNameTaken("fix", existing)).toBe(false);
    expect(branchNameTaken("corral/fix-login", existing)).toBe(true);
    expect(branchNameTaken("corral/fix-login-2", existing)).toBe(true);
    expect(branchNameTaken("corralx/fix-login", existing)).toBe(false);
  });
});

describe("takenAncestor", () => {
  test("names the first existing ref the name would sit under, if any", () => {
    const existing = new Set(["corral", "team/corral"]);
    expect(takenAncestor("corral/fix-login", existing)).toBe("corral");
    expect(takenAncestor("team/corral/fix-login", existing)).toBe("team/corral");
    expect(takenAncestor("team/other/fix-login", existing)).toBeUndefined();
    expect(takenAncestor("fix-login", existing)).toBeUndefined();
  });
});

describe("directoryName", () => {
  test("a branch with slashes becomes one segment", () => {
    expect(directoryName("feature/login page")).toBe("feature-login-page");
    expect(directoryName("release_1.2")).toBe("release_1.2");
  });

  test("never empty, never a path traversal", () => {
    expect(directoryName("..")).toBe("task");
    expect(directoryName("/")).toBe("task");
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (name) => {
        const segment = directoryName(name);
        expect(segment).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$|^task$/);
        expect(segment).not.toMatch(/[/\\]/);
      }),
    );
  });
});

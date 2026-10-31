import { expect, test } from "vite-plus/test";
import { planWorktree, taskSlug } from "./worktree-plan.ts";

const context = (local: string[], remote: string[] = [], overrides: object = {}) => ({
  title: "Fix login",
  branchPrefix: "",
  defaultBaseBranch: "main",
  branches: { local, remote },
  ...overrides,
});

test("a new branch is named from the title, off the project's default base unless told otherwise", () => {
  expect(planWorktree({ type: "new-branch" }, context(["main"]))).toEqual({
    kind: "new-branch",
    branch: "fix-login",
    base: "main",
    slug: "fix-login",
  });
  expect(planWorktree({ type: "new-branch", baseBranch: "origin/dev" }, context(["main"]))).toEqual(
    { kind: "new-branch", branch: "fix-login", base: "origin/dev", slug: "fix-login" },
  );
});

test("a title whose branch exists gets -2, -3, and a name blocked by a branch below it is avoided", () => {
  expect(planWorktree({ type: "new-branch" }, context(["main", "fix-login"]))).toMatchObject({
    branch: "fix-login-2",
  });
  expect(
    planWorktree({ type: "new-branch" }, context(["fix-login", "fix-login-2", "fix-login-3"])),
  ).toMatchObject({ branch: "fix-login-4" });
  expect(planWorktree({ type: "new-branch" }, context(["fix-login/part"]))).toMatchObject({
    branch: "fix-login-2",
  });
});

test("a branch prefix from settings goes in front of the slug, and the worktree is named after the slug", () => {
  expect(
    planWorktree({ type: "new-branch" }, context(["main"], [], { branchPrefix: "corral/" })),
  ).toEqual({ kind: "new-branch", branch: "corral/fix-login", base: "main", slug: "fix-login" });
  expect(
    planWorktree(
      { type: "new-branch" },
      context(["corral/fix-login"], [], { branchPrefix: "corral/" }),
    ),
  ).toMatchObject({ branch: "corral/fix-login-2", slug: "fix-login" });
});

test("a generated slug wins over the title, so A4 can name the branch and worktree", () => {
  expect(
    planWorktree(
      { type: "new-branch" },
      context(["main"], [], { branchPrefix: "corral/", generatedSlug: "oauth-sso" }),
    ),
  ).toMatchObject({ branch: "corral/oauth-sso", slug: "oauth-sso" });
  expect(taskSlug({ title: "Fix login" })).toBe("fix-login");
  expect(taskSlug({ title: "Fix login", generatedSlug: "oauth-sso" })).toBe("oauth-sso");
});

test("a generated slug is sanitized, and one with nothing usable falls back to the title", () => {
  expect(taskSlug({ title: "Fix login", generatedSlug: "OAuth SSO" })).toBe("oauth-sso");
  expect(taskSlug({ title: "Fix login", generatedSlug: "../Release 1.2!" })).toBe("release-1-2");
  expect(taskSlug({ title: "Fix login", generatedSlug: "" })).toBe("fix-login");
  expect(taskSlug({ title: "Fix login", generatedSlug: "---" })).toBe("fix-login");
  expect(
    planWorktree(
      { type: "new-branch" },
      context(["main"], [], { branchPrefix: "corral/", generatedSlug: "OAuth SSO" }),
    ),
  ).toMatchObject({ branch: "corral/oauth-sso", slug: "oauth-sso" });
});

test("a prefix is trimmed, loses empty segments and joins the slug with one separator", () => {
  for (const [branchPrefix, branch] of [
    ["corral", "corral/fix-login"],
    ["corral/", "corral/fix-login"],
    ["corral//", "corral/fix-login"],
    ["/corral/", "corral/fix-login"],
    ["corral ", "corral/fix-login"],
    ["a//b", "a/b/fix-login"],
    [" team / corral ", "team/corral/fix-login"],
    ["/", "fix-login"],
    ["  ", "fix-login"],
  ] as const) {
    expect(
      planWorktree({ type: "new-branch" }, context(["main"], [], { branchPrefix })),
    ).toMatchObject({ branch, slug: "fix-login" });
  }
});

test("a local branch the prefix would sit under fails with that conflict, not with raw git", () => {
  expect(
    planWorktree(
      { type: "new-branch" },
      context(["main", "corral"], [], { branchPrefix: "corral/" }),
    ),
  ).toEqual({ problem: "a branch named 'corral' blocks every branch under the prefix 'corral/'" });
  expect(
    planWorktree(
      { type: "new-branch" },
      context(["main", "corral"], [], { branchPrefix: "corral" }),
    ),
  ).toEqual({ problem: "a branch named 'corral' blocks every branch under the prefix 'corral/'" });
});

test("a branch name given by the user is used as is, and refused when it exists", () => {
  expect(
    planWorktree({ type: "new-branch", branch: "Feature/X" }, context(["main"])),
  ).toMatchObject({ branch: "Feature/X", slug: "Feature/X" });
  expect(planWorktree({ type: "new-branch", branch: "main" }, context(["main"]))).toEqual({
    problem: "a branch named 'main' already exists",
  });
});

test("a chosen branch that git could not store next to the existing ones fails with that conflict", () => {
  expect(
    planWorktree({ type: "new-branch", branch: "corral/fix" }, context(["main", "corral"])),
  ).toEqual({ problem: "a branch named 'corral' blocks 'corral/fix'" });
  expect(planWorktree({ type: "new-branch", branch: "a" }, context(["main", "a/b/c"]))).toEqual({
    problem: "a branch named 'a/b/c' is nested under 'a'",
  });
});

test("an existing local branch is used; a remote-tracking one gets a tracking local branch unless that exists", () => {
  expect(
    planWorktree({ type: "existing-branch", branch: "dev" }, context(["main", "dev"])),
  ).toEqual({ kind: "existing-branch", branch: "dev", slug: "dev" });
  expect(
    planWorktree(
      { type: "existing-branch", branch: "origin/feat/x" },
      context(["main"], ["origin/feat/x"]),
    ),
  ).toEqual({
    kind: "track-remote",
    branch: "feat/x",
    remoteBranch: "origin/feat/x",
    slug: "feat/x",
  });
  expect(
    planWorktree({ type: "existing-branch", branch: "origin/x" }, context(["x"], ["origin/x"])),
  ).toEqual({ kind: "existing-branch", branch: "x", slug: "x" });
});

test("an unknown branch is a problem", () => {
  expect(planWorktree({ type: "existing-branch", branch: "nope" }, context(["main"]))).toEqual({
    problem: "no such branch: nope",
  });
});

import { ORPCError } from "@orpc/client";
import { expect, test } from "vite-plus/test";
import { describeError, dirtyWorktreeFiles } from "./rpc-errors.ts";

// The server sends these over the wire as defined errors, which the client rebuilds as ORPCError.
function defined(code: string, data: unknown) {
  return new ORPCError(code, { defined: true, data });
}

test("typed errors become sentences, git's own message stays as it is", () => {
  expect(describeError(defined("NOT_A_GIT_REPOSITORY", { path: "/tmp/x" }))).toBe(
    "/tmp/x is not inside a git repository.",
  );
  expect(describeError(defined("PROJECT_EXISTS", { id: "p1" }))).toBe(
    "This repository is already added.",
  );
  expect(
    describeError(defined("GIT_FAILED", { message: "fatal: 'x' is already checked out" })),
  ).toBe("fatal: 'x' is already checked out");
});

test("an error outside the contract falls back to its message", () => {
  expect(describeError(new Error("not connected to the server"))).toBe(
    "not connected to the server",
  );
  expect(describeError(new ORPCError("INTERNAL_SERVER_ERROR", { message: "boom" }))).toBe("boom");
  expect(describeError("plain")).toBe("plain");
});

test("only WORKTREE_DIRTY yields the list of blocking files", () => {
  expect(dirtyWorktreeFiles(defined("WORKTREE_DIRTY", { files: ["a.txt", "b/c.ts"] }))).toEqual([
    "a.txt",
    "b/c.ts",
  ]);
  expect(dirtyWorktreeFiles(defined("GIT_FAILED", { message: "x" }))).toBeUndefined();
  expect(dirtyWorktreeFiles(new Error("WORKTREE_DIRTY"))).toBeUndefined();
});

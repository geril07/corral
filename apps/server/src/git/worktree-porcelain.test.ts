import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { worktreeRecords } from "./worktree-porcelain.ts";

test("a path holding a newline stays one path, even when it looks like another field", () => {
  const path = "/tmp/held\nbranch refs/heads/injected";
  const output = `worktree ${path}\0HEAD 1234567\0branch refs/heads/held\0\0`;
  expect(worktreeRecords(output)).toEqual([{ path, branch: "held" }]);
});

test("the main tree and linked worktrees keep their paths and branches; a detached one has none", () => {
  const output = [
    "worktree /repo",
    "HEAD 1111111",
    "branch refs/heads/main",
    "",
    "worktree /repo with space",
    "HEAD 2222222",
    "branch refs/heads/feature/login",
    "",
    "worktree /repo detached",
    "HEAD 3333333",
    "detached",
    "",
  ].join("\0");
  expect(worktreeRecords(`${output}\0`)).toEqual([
    { path: "/repo", branch: "main" },
    { path: "/repo with space", branch: "feature/login" },
    { path: "/repo detached" },
  ]);
});

test("empty and malformed output yields no records", () => {
  expect(worktreeRecords("")).toEqual([]);
  expect(worktreeRecords("\0\0")).toEqual([]);
  expect(worktreeRecords("HEAD 1234567\0branch refs/heads/main\0\0")).toEqual([]);
});

test("paths without NUL round-trip", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          path: fc.string().filter((path) => !path.includes("\0")),
          branch: fc.option(
            fc.string({ minLength: 1 }).filter((branch) => !/[\0\n]/.test(branch)),
            { nil: undefined },
          ),
        }),
      ),
      (records) => {
        const output = records
          .map(
            (record) =>
              `worktree ${record.path}\0HEAD 1234567\0` +
              (record.branch === undefined
                ? "detached\0"
                : `branch refs/heads/${record.branch}\0`) +
              "\0",
          )
          .join("");
        expect(worktreeRecords(output)).toEqual(records);
      },
    ),
  );
});

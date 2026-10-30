import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { changedPaths } from "./status-porcelain.ts";

test("lists modified, staged, untracked and deleted paths", () => {
  const output = " M src/a.ts\0A  src/b.ts\0?? notes.txt\0 D gone.ts\0";
  expect(changedPaths(output)).toEqual(["src/a.ts", "src/b.ts", "notes.txt", "gone.ts"]);
});

test("a rename is one changed file; the original path that follows is not another", () => {
  expect(changedPaths("R  new name.ts\0old name.ts\0 M other.ts\0")).toEqual([
    "new name.ts",
    "other.ts",
  ]);
  expect(changedPaths("RM new.ts\0old.ts\0")).toEqual(["new.ts"]);
  expect(changedPaths(" C copy.ts\0orig.ts\0")).toEqual(["copy.ts"]);
});

test("a clean worktree has no changed paths", () => {
  expect(changedPaths("")).toEqual([]);
});

test("paths with spaces, quotes, newlines and non-ASCII come back verbatim", () => {
  const paths = ["with space.txt", 'quo"te.txt', "new\nline.txt", "файл.txt"];
  expect(changedPaths(paths.map((path) => `?? ${path}\0`).join(""))).toEqual(paths);
});

test("paths of well-formed records round-trip", () => {
  const record = fc.record({
    status: fc.constantFrom(" M", "A ", "??", " D", "M "),
    path: fc.string({ minLength: 1 }).filter((path) => !path.includes("\0")),
  });
  fc.assert(
    fc.property(fc.array(record), (records) => {
      const output = records.map(({ status, path }) => `${status} ${path}\0`).join("");
      expect(changedPaths(output)).toEqual(records.map(({ path }) => path));
    }),
  );
});

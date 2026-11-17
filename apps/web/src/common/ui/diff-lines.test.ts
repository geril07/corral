import { expect, test } from "vite-plus/test";
import { diffFiles } from "./diff-lines.ts";

const patchFor = (path: string, lines: number) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${lines} +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => ` line ${index + 1}`),
    "",
  ].join("\n");

test("a patch's file is named, and its content lines exclude the file and hunk headers", () => {
  const files = diffFiles(patchFor("src/a.ts", 40));
  expect(files.map((file) => file.name)).toEqual(["src/a.ts"]);
  expect(files[0]?.unifiedLineCount).toBe(40);
});

test("a multi-file patch lists each file with its own lines instead of becoming one body", () => {
  const files = diffFiles([patchFor("src/a.ts", 30), patchFor("src/b.ts", 20)].join("\n"));
  expect(files.map((file) => [file.name, file.unifiedLineCount])).toEqual([
    ["src/a.ts", 30],
    ["src/b.ts", 20],
  ]);
});

test("a malformed patch parses to no file instead of claiming one", () => {
  expect(diffFiles("not a patch")).toEqual([]);
});

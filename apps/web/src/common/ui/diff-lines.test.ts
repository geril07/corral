import { expect, test } from "vite-plus/test";
import { diffContentLines } from "./diff-lines.ts";

const patchFor = (path: string, lines: number) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${lines} +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => ` line ${index + 1}`),
    "",
  ].join("\n");

test("content lines exclude file and hunk headers", () => {
  expect(diffContentLines(patchFor("src/a.ts", 40))).toBe(40);
});

test("a multi-file patch counts each file without counting its headers", () => {
  expect(diffContentLines([patchFor("src/a.ts", 30), patchFor("src/b.ts", 30)].join("\n"))).toBe(
    60,
  );
});

test("a malformed patch counts zero instead of claiming a fold", () => {
  expect(diffContentLines("not a patch")).toBe(0);
});

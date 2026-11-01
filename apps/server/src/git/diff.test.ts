import { expect, test } from "vite-plus/test";
import {
  capDiff,
  MAX_DIFF_CHARACTERS,
  mergeChangedFiles,
  newFilePatch,
  parseNameStatus,
  parseNumstat,
  splitLines,
  untrackedPaths,
} from "./diff.ts";

test("name-status parses a modification, a rename with its score and a copy", () => {
  expect(parseNameStatus("M\0src/a.ts\0R100\0old.ts\0new.ts\0C075\0one.ts\0two.ts\0")).toEqual([
    { status: "M", path: "src/a.ts", oldPath: null },
    { status: "R", path: "new.ts", oldPath: "old.ts" },
    // `layout.md` has four letters; a copy adds a file, so it is listed as an addition.
    { status: "A", path: "two.ts", oldPath: null },
  ]);
});

test("name-status maps the letters without one of their own onto modification", () => {
  expect(parseNameStatus("T\0mode.sh\0U\0conflict.txt\0A\0added.txt\0D\0gone.txt\0")).toEqual([
    { status: "M", path: "mode.sh", oldPath: null },
    { status: "M", path: "conflict.txt", oldPath: null },
    { status: "A", path: "added.txt", oldPath: null },
    { status: "D", path: "gone.txt", oldPath: null },
  ]);
});

test("numstat keys a rename by its new path and reads a binary file's dashes", () => {
  const counts = parseNumstat("3\t2\tsrc/a.ts\0-\t-\t\0old.bin\0new.bin\0");
  expect(counts.get("src/a.ts")).toEqual({ additions: 3, deletions: 2, binary: false });
  expect(counts.get("new.bin")).toEqual({ additions: 0, deletions: 0, binary: true });
  expect(counts.get("old.bin")).toBeUndefined();
});

test("merging sorts by path and gives a file git counted nothing for zeros", () => {
  const files = mergeChangedFiles(
    [
      { status: "M", path: "README.md", oldPath: null },
      { status: "R", path: "renamed.ts", oldPath: "before.ts" },
    ],
    new Map([["README.md", { additions: 1, deletions: 1, binary: false }]]),
  );
  expect(files).toEqual([
    { path: "README.md", oldPath: null, status: "M", additions: 1, deletions: 1, binary: false },
    {
      path: "renamed.ts",
      oldPath: "before.ts",
      status: "R",
      additions: 0,
      deletions: 0,
      binary: false,
    },
  ]);
});

test("untracked paths leave out a rename's original path", () => {
  expect(
    untrackedPaths("?? new.txt\0R  moved.txt\0before.txt\0 M changed.txt\0?? b/c.txt\0"),
  ).toEqual(["new.txt", "b/c.txt"]);
});

test("an untracked file is patched as a new file, with or without a final newline", () => {
  const patch = newFilePatch("notes/a.txt", Buffer.from("one\ntwo\n"));
  expect(patch.binary).toBe(false);
  expect(patch.text).toBe(
    [
      "diff --git a/notes/a.txt b/notes/a.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/notes/a.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n"),
  );

  const unterminated = newFilePatch("no-newline.txt", Buffer.from("only"));
  expect(unterminated.text).toContain("+only\n\\ No newline at end of file\n");
  expect(unterminated.text).toContain("@@ -0,0 +1,1 @@");
});

test("an untracked file with a NUL byte is binary, and an empty one has an empty patch", () => {
  expect(newFilePatch("blob.bin", Buffer.from([0x89, 0x00, 0x01]))).toEqual({
    text: null,
    binary: true,
  });
  expect(newFilePatch("empty.txt", Buffer.from("")).text).not.toContain("@@");
});

test("splitLines is the line count a patch adds", () => {
  expect(splitLines("")).toEqual([]);
  expect(splitLines("a\n")).toEqual(["a"]);
  expect(splitLines("a\nb")).toEqual(["a", "b"]);
  expect(splitLines("a\n\n")).toEqual(["a", ""]);
});

test("a diff longer than the cap is cut at a line boundary and flagged", () => {
  const long = `${"x".repeat(100)}\n`.repeat(Math.ceil(MAX_DIFF_CHARACTERS / 101) + 10);
  const capped = capDiff(long);
  expect(capped.truncated).toBe(true);
  expect(capped.text.length).toBeLessThanOrEqual(MAX_DIFF_CHARACTERS);
  expect(capped.text.endsWith("\n")).toBe(true);
  expect(capDiff("short\n")).toEqual({ text: "short\n", truncated: false });
});

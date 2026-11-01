import { expect, test } from "vite-plus/test";
import {
  capDiff,
  countLines,
  MAX_DIFF_CHARACTERS,
  mergeChangedFiles,
  newFilePatch,
  parseNameStatus,
  parseNumstat,
  quotePatchPath,
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
    {
      path: "README.md",
      oldPath: null,
      status: "M",
      additions: 1,
      deletions: 1,
      binary: false,
      partial: false,
      note: null,
    },
    {
      path: "renamed.ts",
      oldPath: "before.ts",
      status: "R",
      additions: 0,
      deletions: 0,
      binary: false,
      partial: false,
      note: null,
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
    truncated: false,
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

test("numstat keeps a path that holds a tab", () => {
  const counts = parseNumstat("1\t2\ttab\tname.txt\0-\t-\t\0old\tone.bin\0new\tone.bin\0");
  expect(counts.get("tab\tname.txt")).toEqual({ additions: 1, deletions: 2, binary: false });
  expect(counts.get("new\tone.bin")).toEqual({ additions: 0, deletions: 0, binary: true });
});

test("countLines does not open an empty line after a trailing newline", () => {
  expect(countLines(Buffer.from(""))).toBe(0);
  expect(countLines(Buffer.from("a\n"))).toBe(1);
  expect(countLines(Buffer.from("a\nb"))).toBe(2);
  expect(countLines(Buffer.from("a\n\n"))).toBe(2);
});

test("a path with a tab or a quote is quoted in the patch header", () => {
  const patch = newFilePatch("tab\tname.txt", Buffer.from("x\n"));
  expect(patch.text).toContain('+++ "b/tab\\tname.txt"');
  expect(patch.text).toContain('diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"');
  expect(quotePatchPath("plain.txt")).toBe("plain.txt");
});

test("a symlink patch is git's mode 120000 with the target as the content", () => {
  const patch = newFilePatch("link", Buffer.from("../outside/secret"), "120000");
  expect(patch.binary).toBe(false);
  expect(patch.truncated).toBe(false);
  expect(patch.text).toContain("new file mode 120000");
  expect(patch.text).toContain("@@ -0,0 +1,1 @@");
  expect(patch.text).toContain("+../outside/secret");
  expect(patch.text).toContain("\\ No newline at end of file");
});

test("a long new file is cut inside the cap with the hunk counting what is really there", () => {
  const patch = newFilePatch("big.txt", Buffer.from("x\n".repeat(400_000)));
  expect(patch.truncated).toBe(true);
  const text = patch.text ?? "";
  expect(text.length).toBeLessThanOrEqual(MAX_DIFF_CHARACTERS);
  const header = /@@ -0,0 \+1,(\d+) @@/.exec(text);
  const body = text
    .slice(text.indexOf("@@"))
    .split("\n")
    .filter((line) => line.startsWith("+"));
  expect(header?.[1]).toBe(String(body.length));
  expect(body.length).toBeLessThan(400_000);
});

test("a capped tracked patch is cut at a hunk boundary when one is inside the cap", () => {
  const body = "+x".repeat(300_000);
  const patch = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    `@@ -1,1 +1,${body.length + 1} @@`,
    body,
    "@@ -5,1 +5,2 @@",
    "+second hunk",
    "",
  ].join("\n");
  const capped = capDiff(patch);
  expect(capped.truncated).toBe(true);
  expect(capped.text).not.toContain("second hunk");
  expect(capped.text.endsWith("\n")).toBe(true);
  // What is left is a complete first hunk, not a body with a header that promises more.
  expect(capped.text.trimEnd().split("\n@@ ").length).toBe(1);
});

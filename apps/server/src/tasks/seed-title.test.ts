import { expect, test } from "vite-plus/test";
import { seedTitle, SEED_TITLE_LENGTH } from "./seed-title.ts";

test("the seed title is the prompt's first non-empty line, whitespace collapsed", () => {
  expect(seedTitle("Fix the flaky login test")).toBe("Fix the flaky login test");
  expect(seedTitle("\n\n  Fix   the\tflaky  login test  \n\nand add a regression test")).toBe(
    "Fix the flaky login test",
  );
  expect(seedTitle("   \n\t\n")).toBe("");
});

test("a long prompt is cut at a word boundary, at most 60 characters with an ellipsis", () => {
  const line = "Rename the worktree layout so that every checkout reads as repository and slug";
  const title = seedTitle(line);

  expect(title.length).toBeLessThanOrEqual(SEED_TITLE_LENGTH);
  expect(title.endsWith("…")).toBe(true);
  expect(title).toBe("Rename the worktree layout so that every checkout reads as…");
  expect(line.startsWith(title.slice(0, -1))).toBe(true);
  // The character after the cut is the space the boundary fell on, not half a word.
  expect(line[title.length - 1]).toBe(" ");
});

test("a prompt whose first word alone is too long is cut where the limit is", () => {
  const word = "a".repeat(SEED_TITLE_LENGTH + 20);
  const title = seedTitle(word);

  expect(title).toBe(`${"a".repeat(SEED_TITLE_LENGTH - 1)}…`);
});

test("a seed exactly at the limit is kept whole", () => {
  const line = "b".repeat(SEED_TITLE_LENGTH);

  expect(seedTitle(line)).toBe(line);
});

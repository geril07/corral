import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import {
  detectLinks,
  fileLinkHref,
  localLinkTransform,
  parseFileLinkHref,
  pathCandidates,
  type MarkdownNode,
} from "./local-links.ts";

const paths = (text: string) =>
  detectLinks(text).map((link) => (link.kind === "url" ? link.raw : link.target));

test("absolute paths, relative paths and a line and column suffix are detected", () => {
  expect(paths("look at /home/me/app/src/main.ts please")).toEqual([
    { path: "/home/me/app/src/main.ts" },
  ]);
  expect(paths("see src/app.ts:12 and lib/util.js:7:3")).toEqual([
    { path: "src/app.ts", line: 12 },
    { path: "lib/util.js", line: 7, column: 3 },
  ]);
  expect(paths("./notes.md and ../sibling/readme.md")).toEqual([
    { path: "./notes.md" },
    { path: "../sibling/readme.md" },
  ]);
  expect(paths("open `README.md` next")).toEqual([{ path: "README.md" }]);
});

test("a path token stops at prose punctuation and at a colon that is not a position", () => {
  expect(paths("(src/app.ts), then src/b.ts.")).toEqual([
    { path: "src/app.ts" },
    { path: "src/b.ts" },
  ]);
  expect(paths("src/app.ts:12, next")).toEqual([{ path: "src/app.ts", line: 12 }]);
  // `:12x` is not a line number, so the suffix is not consumed and the token stays a path.
  expect(paths("src/app.ts:12x")).toEqual([{ path: "src/app.ts" }]);
  expect(paths("ratio 12:30")).toEqual([]);
});

test("URLs are links and their path segments are not offered as local paths", () => {
  const links = detectLinks("see https://example.com/docs/app.ts:12 now");
  expect(links.map((link) => ({ raw: link.raw, kind: link.kind }))).toEqual([
    { raw: "https://example.com/docs/app.ts:12", kind: "url" },
  ]);
  expect(pathCandidates("see https://example.com/docs/app.ts:12 now")).toEqual([]);
  expect(pathCandidates("https://example.com/a, (see also src/a.ts)")).toEqual(["src/a.ts"]);
});

test("words without a slash or an extension are not candidates", () => {
  expect(pathCandidates("and/or either or both")).toEqual(["and/or"]);
  expect(pathCandidates("the ratio is 1.5 and the word is hello")).toEqual(["1.5"]);
  // Both of those are offered and then dropped by `files.resolve` (they do not exist) — the point
  // of resolving rather than trusting detection. A name with no slash and no dot is not offered.
  expect(pathCandidates("a word like README stays text")).toEqual([]);
});

test("the plugin links path-shaped text and skips code spans and existing links", () => {
  const tree: MarkdownNode = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "see src/app.ts" }] },
      { type: "paragraph", children: [{ type: "inlineCode", value: "src/app.ts" }] },
      {
        type: "paragraph",
        children: [
          { type: "link", url: "https://x.dev", children: [{ type: "text", value: "x" }] },
        ],
      },
    ],
  };
  localLinkTransform(tree);
  const paragraphs = tree.children ?? [];
  expect(paragraphs[0]?.children).toEqual([
    { type: "text", value: "see " },
    {
      type: "link",
      url: fileLinkHref({ path: "src/app.ts" }),
      title: null,
      children: [{ type: "text", value: "src/app.ts" }],
    },
  ]);
  // Inline code is untouched, and a link is never nested inside a link.
  expect(paragraphs[1]?.children).toEqual([{ type: "inlineCode", value: "src/app.ts" }]);
  expect(paragraphs[2]?.children).toEqual([
    { type: "link", url: "https://x.dev", children: [{ type: "text", value: "x" }] },
  ]);
});

test("the plugin links a path-shaped token whether or not it exists", () => {
  // Resolution is the anchor's job (`local-links.tsx`), which renders nothing clickable for a
  // candidate the workspace does not hold; the tree transform stays a pure function of the text.
  const tree: MarkdownNode = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: "see src/foo.ts" }] }],
  };
  localLinkTransform(tree);
  expect(tree.children?.[0]?.children).toEqual([
    { type: "text", value: "see " },
    {
      type: "link",
      url: fileLinkHref({ path: "src/foo.ts" }),
      title: null,
      children: [{ type: "text", value: "src/foo.ts" }],
    },
  ]);
});

test("a file link URL round-trips its path and position", () => {
  for (const target of [
    { path: "src/a.ts" },
    { path: "src/a.ts", line: 12 },
    { path: "dir with space/a.ts", line: 3, column: 4 },
  ]) {
    expect(parseFileLinkHref(fileLinkHref(target))).toEqual(target);
  }
  expect(parseFileLinkHref("https://example.com/")).toBeUndefined();
  expect(parseFileLinkHref("#corral-file?path=")).toBeUndefined();
  expect(parseFileLinkHref("#corral-file?path=a.ts&line=0")).toEqual({ path: "a.ts" });
});

/** Total length preserved and every token exactly the text it points at. */
test("property: tokens are well formed, ordered and never overlap", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      const links = detectLinks(text);
      let previousEnd = 0;
      for (const link of links) {
        expect(link.start).toBeGreaterThanOrEqual(previousEnd);
        expect(link.end).toBeGreaterThan(link.start);
        expect(link.end).toBeLessThanOrEqual(text.length);
        expect(link.raw).toBe(text.slice(link.start, link.end));
        previousEnd = link.end;
      }
    }),
    { numRuns: 300 },
  );
});

/**
 * The streaming property: text arrives in chunks and the lane re-scans the whole accumulated text,
 * so a token that a prefix completed must not change when more text arrives. Only a token touching
 * the end of the prefix may grow — that is the token still being typed.
 */
test("property: appending text never rewrites a token that ended before the end", () => {
  const token = fc.oneof(
    fc.constantFrom(
      "src/app.ts",
      "src/app.ts:12",
      "/home/me/file.ts",
      "./a/b.md",
      "https://example.com/x",
      "README.md",
    ),
    fc.string({ maxLength: 12 }),
  );
  fc.assert(
    fc.property(
      fc.array(token, { maxLength: 6 }),
      fc.array(token, { maxLength: 4 }),
      (before, after) => {
        const prefix = before.join(" ");
        const whole = `${prefix} ${after.join(" ")}`;
        // A token with at least one character of separation after it is finished; the last token of
        // the prefix may still be growing, so it is not compared.
        const settled = (text: string) =>
          detectLinks(text).filter((link) => link.end + 2 <= prefix.length);
        const stable = settled(prefix);
        const grown = settled(whole);
        expect(grown).toEqual(stable);
      },
    ),
    { numRuns: 200 },
  );
});

test("property: odd input never throws and yields only plausible candidates", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      expect(() => detectLinks(text)).not.toThrow();
      for (const candidate of pathCandidates(text)) {
        expect(candidate).not.toBe("");
        expect(candidate).not.toContain("\0");
      }
    }),
    { numRuns: 300 },
  );
});

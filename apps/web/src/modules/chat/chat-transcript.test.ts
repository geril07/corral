import { expect, test } from "vite-plus/test";
import { chatTranscriptStore, insertQuote, quoteBlock } from "./chat-transcript.ts";

test("a quote is one blockquote line per selected line, then the comment's line", () => {
  expect(quoteBlock("Waits on the condition.\n\nThe timeout was the race.")).toBe(
    "> Waits on the condition.\n>\n> The timeout was the race.\n\n",
  );
  // A selection that starts and ends on blank lines does not add empty quotes.
  expect(quoteBlock("\n  Read it.  \n\n")).toBe(">   Read it.\n\n");
  expect(quoteBlock("   ")).toBe("");
});

test("a quote lands at the composer's caret and leaves the caret below it", () => {
  const inserted = insertQuote("Please fix this", undefined, "The test is flaky.");
  expect(inserted.text).toBe("Please fix this\n> The test is flaky.\n\n");
  expect(inserted.caret).toBe(inserted.text.length);

  const middle = insertQuote("a  b", { start: 1, end: 3 }, "quoted");
  expect(middle.text).toBe("a\n> quoted\n\nb");
  // The caret is the line after the quote, where the user's comment goes.
  expect(middle.text.slice(middle.caret)).toBe("b");
});

test("a quote replaces the composer's own selection instead of stacking", () => {
  expect(insertQuote("keep REPLACE keep", { start: 5, end: 12 }, "x").text).toBe(
    "keep \n> x\n\n keep",
  );
  expect(insertQuote("", undefined, "x")).toEqual({ text: "> x\n\n", caret: 5 });
});

test("a session's store keeps its folds and its reading row, and another session's does not", () => {
  const mine = chatTranscriptStore();
  expect([...mine.toggle("turn:u1")]).toEqual(["turn:u1"]);
  expect([...mine.toggle("group:t1")]).toEqual(["turn:u1", "group:t1"]);
  expect([...mine.toggle("turn:u1")]).toEqual(["group:t1"]);

  mine.remember({ key: "turn:u2", index: 4 }, false);
  expect(mine.read()).toEqual({
    anchor: { key: "turn:u2", index: 4 },
    atEnd: false,
    expanded: new Set(["group:t1"]),
  });

  // The store answers new snapshots, so a reader holding an old one never sees it change.
  const before = mine.read();
  mine.remember({ key: "turn:u3", index: 9 }, true);
  expect(before.anchor).toEqual({ key: "turn:u2", index: 4 });
  expect(before.atEnd).toBe(false);

  expect(chatTranscriptStore().read()).toEqual({
    anchor: undefined,
    atEnd: false,
    expanded: new Set(),
  });
});

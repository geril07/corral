import { expect, test } from "vite-plus/test";
import type { ChatContextUsage } from "@corral/protocol/chat";
import {
  contextDetail,
  contextLabel,
  contextPercentage,
  contextPercentageText,
  formatTokens,
} from "./chat-context.ts";

const usage = (usedTokens: number, maxTokens: number | null): ChatContextUsage => ({
  usedTokens,
  maxTokens,
});

test("a reading past the window still fills the ring at 100, and no window leaves it empty", () => {
  expect(contextPercentage(usage(45_000, 200_000))).toBe(23);
  expect(contextPercentage(usage(210_000, 200_000))).toBe(100);
  expect(contextPercentage(usage(45_000, null))).toBeNull();
});

test("token counts read in the composer's compact form", () => {
  expect([950, 3_200, 45_000, 1_200_000].map(formatTokens)).toEqual(["950", "3.2k", "45k", "1.2m"]);
});

test("the tooltip and the accessible name carry the same reading, with or without a window", () => {
  const known = usage(45_000, 200_000);
  expect(contextPercentageText(known)).toBe("23%");
  expect(contextLabel(known)).toBe("Context window 23% used");
  expect(contextDetail(known)).toBe("Context window · 23% · 45k/200k tokens");

  const unknown = usage(45_000, null);
  expect(contextPercentageText(unknown)).toBeNull();
  expect(contextLabel(unknown)).toBe("Context window 45k tokens used");
  expect(contextDetail(unknown)).toBe("Context window · 45k tokens");

  // Under ten percent the tenth is worth showing; T3's meter makes the same cut.
  expect(contextPercentageText(usage(4_600, 200_000))).toBe("2.3%");
});

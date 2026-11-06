import { expect, test } from "vite-plus/test";
import { draftLeftAfterSend } from "./chat-draft.ts";

test("an accepted send removes the submitted draft and keeps text typed after it", () => {
  expect(draftLeftAfterSend("Fix the test", "Fix the test")).toBe("");
  expect(draftLeftAfterSend("Fix the test and run lint", "Fix the test")).toBe(" and run lint");
  expect(draftLeftAfterSend("Fix the test ", "Fix the test")).toBe(" ");
  expect(draftLeftAfterSend("  Fix the test  ", "  Fix the test  ")).toBe("");
  expect(draftLeftAfterSend("  Fix the test  now", "  Fix the test  ")).toBe("now");
});

test("text composed inside the submitted draft away from its end survives", () => {
  expect(draftLeftAfterSend("ab가cd", "abcd")).toBe("가");
});

test("a draft replaced or edited inside the sent text keeps its whole text", () => {
  expect(draftLeftAfterSend("Fix this test", "Fix the test")).toBeNull();
  expect(draftLeftAfterSend("Fix", "Fix the test")).toBeNull();
  expect(draftLeftAfterSend("Send something else", "Fix the test")).toBeNull();
});

import { expect, test } from "vite-plus/test";
import { AGENTS, describeSessionState } from "./session-state.ts";

test("agents are listed in the order the picker numbers them", () => {
  expect(AGENTS).toEqual(["claude", "codex", "pi", "opencode"]);
});

test("a running session has nothing to say; a stopped agent resumes, an unresumable one starts over", () => {
  expect(describeSessionState({ kind: "claude", state: "running" })).toEqual({
    badge: undefined,
    note: undefined,
  });
  expect(describeSessionState({ kind: "claude", state: "stopped" }).note).toContain("resumes");
  expect(describeSessionState({ kind: "shell", state: "stopped" }).note).toContain("fresh shell");
  expect(describeSessionState({ kind: "codex", state: "unresumable" })).toMatchObject({
    badge: "unresumable",
    note: expect.stringContaining("new conversation"),
  });
});

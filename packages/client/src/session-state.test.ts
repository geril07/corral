import { expect, test } from "vite-plus/test";
import { AGENTS, describeSessionState } from "./session-state.ts";

test("agents are listed in the order the picker numbers them", () => {
  expect(AGENTS).toEqual(["claude", "codex", "pi", "opencode"]);
});

test("a running session has nothing to say", () => {
  expect(describeSessionState({ kind: "claude", state: "running", status: null })).toEqual({
    badge: undefined,
    action: undefined,
    note: undefined,
  });
});

test("a stopped shell restarts fresh, a stopped agent resumes", () => {
  expect(describeSessionState({ kind: "shell", state: "stopped", status: null })).toEqual({
    badge: "stopped",
    action: "Restart",
    note: "Starting it again opens a fresh shell in the task's workspace.",
  });
  expect(describeSessionState({ kind: "claude", state: "stopped", status: null })).toEqual({
    badge: "stopped",
    action: "Restart",
    note: "Starting it again resumes the agent's conversation.",
  });
});

test("a failed start is named failed and offers the same restart", () => {
  expect(
    describeSessionState({
      kind: "claude",
      state: "stopped",
      status: { state: "error", updatedAt: 1, message: "claude did not answer" },
      launchError: "claude did not answer within 15 s",
    }),
  ).toEqual({
    badge: "failed",
    action: "Restart",
    note: "Starting it again resumes the agent's conversation.",
  });

  // A launch that failed before any status existed is still a failed start.
  expect(
    describeSessionState({
      kind: "claude",
      state: "stopped",
      status: null,
      launchError: "no environment variable TOKEN",
    }).badge,
  ).toBe("failed");
});

test("an unresumable session offers a new conversation and says why", () => {
  expect(describeSessionState({ kind: "codex", state: "unresumable", status: null })).toEqual({
    badge: "unresumable",
    action: "Start a new conversation",
    note: "The agent's conversation was never identified, so starting it again will start a new conversation.",
  });
});

import { AgentKind } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { AGENTS } from "./agents.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("each agent starts and resumes with the flags its --help documents", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  expect(AGENTS.claude.startArgs(id)).toEqual(["--session-id", id]);
  expect(AGENTS.claude.resumeArgs(id)).toEqual(["--resume", id]);
  expect(AGENTS.pi.startArgs(id)).toEqual(["--session-id", id]);
  expect(AGENTS.pi.resumeArgs(id)).toEqual(["--session-id", id]);
  expect(AGENTS.opencode.startArgs(id)).toEqual(["--session", id]);
  expect(AGENTS.opencode.resumeArgs(id)).toEqual(["--session", id]);
  expect(AGENTS.codex.startArgs(null)).toEqual([]);
  expect(AGENTS.codex.resumeArgs(id)).toEqual(["resume", id]);
});

test("the ids we choose have the shape each agent accepts; Codex gets none", () => {
  expect(AGENTS.claude.newSessionId()).toMatch(UUID);
  expect(AGENTS.pi.newSessionId()).toMatch(UUID);
  expect(AGENTS.opencode.newSessionId()).toMatch(/^ses_[0-9A-Za-z]{26}$/);
  expect(AGENTS.codex.newSessionId()).toBeNull();
});

test("every agent kind has an adapter that runs the command named after it", () => {
  for (const kind of AgentKind.options) expect(AGENTS[kind].command).toBe(kind);
});

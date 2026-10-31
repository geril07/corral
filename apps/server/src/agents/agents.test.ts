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

test("each agent passes the initial prompt as one argument that reads as a prompt, not as a flag or a subcommand", () => {
  const plain = "fix the failing test";
  const awkward = `-restore the "old" table\nand say why`;
  // A first word that names one of the agent's own subcommands (`claude mcp`, `codex review`).
  const subcommands = ["review the diff", "mcp", " -- update"];

  for (const prompt of [plain, awkward, ...subcommands]) {
    // Both positionals would dispatch this word as a subcommand, so Claude Code gets a leading
    // space (its `--` still leaves the word as the first operand) and Codex always gets `--`.
    expect(AGENTS.claude.promptArgs(prompt)).toEqual([` ${prompt}`]);
    expect(AGENTS.codex.promptArgs(prompt)).toEqual(["--", prompt]);
  }

  for (const prompt of [plain, ...subcommands]) {
    expect(AGENTS.pi.promptArgs(prompt)).toEqual([prompt]);
    expect(AGENTS.opencode.promptArgs(prompt)).toEqual(["--prompt", prompt]);
  }
  expect(AGENTS.pi.promptArgs(awkward)).toEqual(["--", awkward]);
  expect(AGENTS.opencode.promptArgs(awkward)).toEqual([`--prompt=${awkward}`]);
});

test("a pi prompt starting with @ stays a message instead of a file to include", () => {
  const prompt = "@README.md is stale\nupdate it";
  // One leading space is what keeps pi from reading the first word as `@path`.
  expect(AGENTS.pi.promptArgs(prompt)).toEqual([` ${prompt}`]);
});

test("every agent kind has an adapter that runs the command named after it", () => {
  for (const kind of AgentKind.options) expect(AGENTS[kind].command).toBe(kind);
});

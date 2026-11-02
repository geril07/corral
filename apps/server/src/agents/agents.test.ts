import { AgentKind } from "@corral/protocol/rpc";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { writeRollout } from "../../test/rollouts.ts";
import { uuidV7Time } from "./codex-sessions.ts";
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

test("codex has a conversation only once a rollout exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-codex-rollout-"));
  try {
    const env = { CODEX_HOME: root };
    expect(AGENTS.codex.hasConversation?.("thread-1", env)).toBe(false);
    writeRollout(root, { id: "thread-1", cwd: root });
    expect(AGENTS.codex.hasConversation?.("thread-1", env)).toBe(true);
    expect(AGENTS.codex.hasConversation?.("thread-2", env)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a UUIDv7 thread id is looked up under its own day; another id falls back to the walk", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-codex-rollout-"));
  try {
    const env = { CODEX_HOME: root };
    // The first 48 bits are the creation time; the rollout is written in that local day.
    const thread = "01a19990-1b7f-7671-a71f-0e9fce80da74";
    const createdAt = uuidV7Time(thread)!;
    expect(new Date(createdAt).toISOString()).toBe("2026-11-02T00:02:00.703Z");
    expect(AGENTS.codex.hasConversation?.(thread, env)).toBe(false);
    writeRollout(root, { id: thread, cwd: root, startedAt: new Date(createdAt) });
    expect(AGENTS.codex.hasConversation?.(thread, env)).toBe(true);
    // An id that is not UUIDv7 (a fork, an older server) still finds its rollout.
    writeRollout(root, { id: "rollout-legacy", cwd: root });
    expect(AGENTS.codex.hasConversation?.("rollout-legacy", env)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  // The word the prompt starts with decides: a flag-shaped word, or the name of one of the agent's
  // own subcommands (`claude mcp`, `codex review`). `-- update` is the literal the review probed.
  const cases: [prompt: string, argv: Record<AgentKind, string[]>][] = [
    [
      plain,
      { claude: [` ${plain}`], codex: ["--", plain], pi: [plain], opencode: ["--prompt", plain] },
    ],
    [
      awkward,
      {
        claude: [` ${awkward}`],
        codex: ["--", awkward],
        pi: ["--", awkward],
        opencode: [`--prompt=${awkward}`],
      },
    ],
    [
      "review the diff",
      {
        claude: [" review the diff"],
        codex: ["--", "review the diff"],
        pi: ["review the diff"],
        opencode: ["--prompt", "review the diff"],
      },
    ],
    ["mcp", { claude: [" mcp"], codex: ["--", "mcp"], pi: ["mcp"], opencode: ["--prompt", "mcp"] }],
    [
      " -- update",
      {
        claude: ["  -- update"],
        codex: ["--", " -- update"],
        pi: [" -- update"],
        opencode: ["--prompt", " -- update"],
      },
    ],
    [
      "-- update",
      {
        claude: [" -- update"],
        codex: ["--", "-- update"],
        pi: ["--", "-- update"],
        opencode: ["--prompt=-- update"],
      },
    ],
  ];

  // Codex always gets `--`, where clap reads every later word as the positional. Claude Code always
  // gets a leading space: its `--` still leaves the word as the first operand, which it dispatches.
  for (const [prompt, argv] of cases) {
    for (const kind of AgentKind.options)
      expect(AGENTS[kind].promptArgs(prompt)).toEqual(argv[kind]);
  }
});

test("a pi prompt starting with @ stays a message instead of a file to include", () => {
  const prompt = "@README.md is stale\nupdate it";
  // One leading space is what keeps pi from reading the first word as `@path`.
  expect(AGENTS.pi.promptArgs(prompt)).toEqual([` ${prompt}`]);
});

test("every agent kind has an adapter that runs the command named after it", () => {
  for (const kind of AgentKind.options) expect(AGENTS[kind].command).toBe(kind);
});

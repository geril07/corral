import type { AgentKind } from "@corral/protocol";
import { defaultClientConfig } from "@corral/protocol/config";
import { expect, test } from "vite-plus/test";
import { parseConfigFile } from "./config-file.ts";

const DATA_DIR = "/data";
const REPO = "/repos/app";
// This build ships a driver for every agent, so a test that needs the fallback narrows the set.
const parse = (text: string, hasDriver?: (kind: AgentKind) => boolean) =>
  parseConfigFile(text, DATA_DIR, hasDriver ?? (() => true));

const CLAUDE_PROFILE = `
[profiles.gateway]
name = "Claude via gateway"
agent = "claude"
model = "claude-sonnet-4-5"
`;

test("an empty file offers every agent and launches each by its own name", () => {
  const { config, problems } = parse("");

  expect(problems).toEqual([]);
  expect(config.agents).toEqual(defaultClientConfig(DATA_DIR).agents);
  expect(config.agents.pi).toEqual({
    enabled: { value: true, source: "default" },
    command: { value: "pi", source: "default" },
  });
});

test("[agents.<kind>] sets enabled and command, each with the global source", () => {
  const { config, problems } = parse(`
[agents.pi]
enabled = false
command = "/opt/pi/bin/pi"

[agents.codex]
enabled = true
`);

  expect(problems).toEqual([]);
  expect(config.agents.pi).toEqual({
    enabled: { value: false, source: "global" },
    command: { value: "/opt/pi/bin/pi", source: "global" },
  });
  expect(config.agents.codex).toEqual({
    enabled: { value: true, source: "global" },
    command: { value: "codex", source: "default" },
  });
  expect(config.agents.claude).toEqual(defaultClientConfig(DATA_DIR).agents.claude);
});

test("an invalid agent entry drops only itself, not the other key beside it", () => {
  const relative = parse('[agents.pi]\ncommand = "bin/pi"\nenabled = false\n');
  expect(relative.config.agents.pi).toEqual({
    enabled: { value: false, source: "global" },
    command: { value: "pi", source: "default" },
  });
  expect(relative.problems).toEqual([
    {
      severity: "error",
      path: "agents.pi.command",
      message: "the command must be an absolute path",
    },
  ]);

  const wrongType = parse('[agents.codex]\nenabled = "no"\n');
  expect(wrongType.config.agents.codex.enabled).toEqual({ value: true, source: "default" });
  expect(wrongType.problems).toEqual([
    {
      severity: "error",
      path: "agents.codex.enabled",
      message: "expected true or false, got a string",
    },
  ]);

  const unknownKey = parse('[agents.opencode]\nmodel = "x"\n');
  expect(unknownKey.problems).toEqual([
    { severity: "error", path: "agents.opencode.model", message: 'unknown key "model"' },
  ]);

  const unknownKind = parse("[agents.grok]\nenabled = false\n");
  expect(unknownKind.config.agents).toEqual(defaultClientConfig(DATA_DIR).agents);
  expect(unknownKind.problems).toHaveLength(1);
  expect(unknownKind.problems[0]).toMatchObject({
    severity: "error",
    path: "agents.grok",
    message: expect.stringContaining("unknown agent"),
  });

  const notATable = parse("agents = 5\n");
  expect(notATable.problems).toEqual([
    { severity: "error", path: "agents", message: "expected a table, got a number" },
  ]);
});

test("a disabled agent is not a task default, a naming runner or a usable profile", () => {
  const { config, profiles, problems } = parse(`${CLAUDE_PROFILE}
[agents.claude]
enabled = false

[tasks]
agent = "claude"
profile = "gateway"

[naming]
agent = "claude"
`);

  expect(config.tasks.agent).toEqual({ value: null, source: "default" });
  expect(profiles).toEqual([]);
  expect(problems.map((problem) => problem.path)).toEqual([
    "profiles.gateway",
    "tasks.agent",
    "tasks.profile",
    "naming.agent",
  ]);
  expect(problems[0]?.message).toContain("disabled in [agents]");
});

test("view = chat is accepted where the agent has a chat driver", () => {
  const { config, problems } = parse(`
[tasks]
agent = "pi"
view = "chat"
`);

  expect(problems).toEqual([]);
  expect(config.tasks.view).toEqual({ value: "chat", source: "global" });
});

test("a chat view for an agent without a driver opens in the terminal with a warning", () => {
  const { config, problems } = parse(
    `
[tasks]
agent = "codex"
view = "chat"
`,
    (kind) => kind !== "codex",
  );

  expect(config.tasks.view).toEqual({ value: "terminal", source: "global" });
  expect(problems).toEqual([
    {
      severity: "warning",
      path: "tasks.view",
      message: "the codex agent has no chat driver, so this view opens in the terminal",
    },
  ]);
});

test("a project whose own agent cannot show chat warns there, and keeps the global chat view", () => {
  const { config, problems } = parse(
    `
[tasks]
agent = "pi"
view = "chat"

[projects."${REPO}"]
agent = "codex"
`,
    (kind) => kind !== "codex",
  );

  expect(config.tasks.view).toEqual({ value: "chat", source: "global" });
  expect(config.projects[REPO]?.view).toEqual({ value: "terminal", source: "global" });
  expect(problems).toEqual([
    {
      severity: "warning",
      path: `projects."${REPO}"`,
      message: "the codex agent has no chat driver, so this view opens in the terminal",
    },
  ]);
});

test("a project that inherits an unusable chat view is covered by the [tasks] warning once", () => {
  const { config, problems } = parse(
    `
[tasks]
agent = "codex"
view = "chat"

[projects."${REPO}"]
workspace = "main-worktree"
`,
    (kind) => kind !== "codex",
  );

  expect(config.projects[REPO]?.view).toEqual({ value: "terminal", source: "global" });
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ severity: "warning", path: "tasks.view" });
});

test("a project's chat view applies to that project when its agent has a driver", () => {
  const { config, problems } = parse(`
[projects."${REPO}"]
agent = "pi"
view = "chat"
`);

  expect(problems).toEqual([]);
  expect(config.projects[REPO]?.view).toEqual({ value: "chat", source: "project" });
  expect(config.tasks.view).toEqual({ value: "terminal", source: "default" });
});

test("a chat view with no agent configured stays chat for the agent the composer picks", () => {
  const { config, problems } = parse('[tasks]\nview = "chat"\n');

  expect(problems).toEqual([]);
  expect(config.tasks.view).toEqual({ value: "chat", source: "global" });
});

import {
  DEFAULT_NAMING_TIMEOUT_SECONDS,
  defaultClientConfig,
  namingConfigured,
} from "@corral/protocol/config";
import { expect, test } from "vite-plus/test";
import { parseConfigFile } from "./config-file.ts";

const DATA_DIR = "/data";
const WORKTREES = "/data/worktrees";
const parse = (text: string) => parseConfigFile(text, DATA_DIR);
const defaults = () => defaultClientConfig(WORKTREES);
const REPO = "/repos/app";

const PROFILE = `
[profiles.gateway]
name = "Claude via gateway"
agent = "claude"
model = "claude-sonnet-4-5"
`;

test("an empty file is every built-in default, worktree root below the data directory", () => {
  const { config, problems } = parse("");

  expect(problems).toEqual([]);
  expect(config).toEqual(defaults());
  expect(config.tasks.worktreeRoot).toEqual({ value: WORKTREES, source: "default" });
  expect(namingConfigured(config.naming)).toBe(false);
});

test("every [tasks] key applies over its default and says it came from the global section", () => {
  const { config, problems } = parse(`
[tasks]
agent = "codex"
model = "gpt-5-codex"
workspace = "new-worktree"
worktree-root = "~/corral-worktrees"
branch-prefix = "corral/"
slug-mode = "generated"
view = "terminal"
`);

  expect(problems).toEqual([]);
  expect(config.tasks).toEqual({
    agent: { value: "codex", source: "global" },
    profile: { value: null, source: "default" },
    model: { value: "gpt-5-codex", source: "global" },
    workspace: { value: "new-worktree", source: "global" },
    worktreeRoot: { value: "~/corral-worktrees", source: "global" },
    branchPrefix: { value: "corral/", source: "global" },
    slugMode: { value: "generated", source: "global" },
    view: { value: "terminal", source: "global" },
  });
});

test("a profile is a [tasks] default too, and the agent stays as the fallback it overrides", () => {
  const { config, problems } = parse(`${PROFILE}
[tasks]
profile = "gateway"
agent = "claude"
`);

  expect(problems).toEqual([]);
  expect(config.tasks.profile).toEqual({ value: "gateway", source: "global" });
  expect(config.tasks.agent).toEqual({ value: "claude", source: "global" });
});

const rejectedTasks: [file: string, path: string, message: string][] = [
  ['[tasks]\nagent = "grok"\n', "tasks.agent", "must be one of claude, codex, pi, opencode"],
  ['[tasks]\nprofile = "missing"\n', "tasks.profile", 'no valid profile with id "missing"'],
  ['[tasks]\nmodel = "not a model!"\n', "tasks.model", "not a valid native model id"],
  [
    '[tasks]\nworkspace = "worktree"\n',
    "tasks.workspace",
    "must be one of main-worktree, new-worktree",
  ],
  [
    '[tasks]\nworktree-root = "relative/root"\n',
    "tasks.worktree-root",
    "must be an absolute path or start with ~/",
  ],
  ['[tasks]\nbranch-prefix = "bad prefix"\n', "tasks.branch-prefix", "may not hold whitespace"],
  ['[tasks]\nbranch-prefix = "a..b"\n', "tasks.branch-prefix", "may not hold"],
  ['[tasks]\nbranch-prefix = "/lead"\n', "tasks.branch-prefix", "may not start with /, . or -"],
  ['[tasks]\nslug-mode = "random"\n', "tasks.slug-mode", "must be one of title, generated"],
  ['[tasks]\nview = "chat"\n', "tasks.view", "arrives with stage B"],
  ['[tasks]\nview = "board"\n', "tasks.view", "must be one of terminal, chat"],
  ["[tasks]\nagent = 5\n", "tasks.agent", "expected a string, got a number"],
  ["[tasks]\nworkspace = 5\n", "tasks.workspace", "expected a string, got a number"],
  ["[tasks]\nworktree-root = 5\n", "tasks.worktree-root", "expected a string, got a number"],
  ["[tasks]\nbranch-prefix = 5\n", "tasks.branch-prefix", "expected a string, got a number"],
  ["[tasks]\nslug-mode = 5\n", "tasks.slug-mode", "expected a string, got a number"],
  ["[tasks]\nview = 5\n", "tasks.view", "expected a string, got a number"],
  ["[tasks]\nmodel = 5\n", "tasks.model", "expected a string, got a number"],
  ["[tasks]\nprofile = 5\n", "tasks.profile", "expected a string, got a number"],
  ['[tasks]\ncolour = "red"\n', "tasks.colour", 'unknown key "colour"'],
  ["tasks = 5\n", "tasks", "expected a table, got a number"],
];
test.for(rejectedTasks)("%s is rejected at %s", ([file, path, message]) => {
  const { config, problems } = parse(file);

  expect(config.projects).toEqual({});
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ severity: "error", path });
  expect(problems[0]?.message).toContain(message);
});

test("a model its agent has no flag for is dropped while the agent applies", () => {
  const { config, problems } = parse('[tasks]\nagent = "opencode"\nmodel = "gpt-5"\n');

  expect(config.tasks.agent).toEqual({ value: "opencode", source: "global" });
  expect(config.tasks.model).toEqual({ value: null, source: "default" });
  expect(problems).toEqual([
    {
      severity: "error",
      path: "tasks.model",
      message: "opencode has no model flag on its launch command",
    },
  ]);
});

test("a naming model its agent has no flag for is dropped while the agent applies", () => {
  const { config, problems } = parse('[naming]\nagent = "opencode"\nmodel = "gpt-5"\n');

  expect(config.naming.agent).toEqual({ value: "opencode", source: "global" });
  expect(config.naming.model).toEqual({ value: null, source: "default" });
  expect(problems.map((problem) => problem.path)).toEqual(["naming.model"]);
});

test("a rejected [tasks] entry drops only itself", () => {
  const { config, problems } = parse(`
[tasks]
agent = "codex"
workspace = "new-worktree"
model = "not a model!"
`);

  expect(config.tasks.agent).toEqual({ value: "codex", source: "global" });
  expect(config.tasks.workspace).toEqual({ value: "new-worktree", source: "global" });
  expect(config.tasks.model).toEqual({ value: null, source: "default" });
  expect(problems.map((problem) => problem.path)).toEqual(["tasks.model"]);
});

test("a [naming] agent and model make naming configured, and global values are marked", () => {
  const { config, problems } = parse(`
[naming]
agent = "claude"
model = "claude-haiku-4-5"
timeout-seconds = 3
`);

  expect(problems).toEqual([]);
  expect(config.naming).toEqual({
    profile: { value: null, source: "default" },
    agent: { value: "claude", source: "global" },
    model: { value: "claude-haiku-4-5", source: "global" },
    timeoutSeconds: { value: 3, source: "global" },
  });
  expect(namingConfigured(config.naming)).toBe(true);
});

test("a [naming] profile is enough to configure naming", () => {
  const { config, problems } = parse(`${PROFILE}
[naming]
profile = "gateway"
`);

  expect(problems).toEqual([]);
  expect(config.naming.profile).toEqual({ value: "gateway", source: "global" });
  expect(config.naming.agent).toEqual({ value: null, source: "default" });
  expect(config.naming.timeoutSeconds).toEqual({
    value: DEFAULT_NAMING_TIMEOUT_SECONDS,
    source: "default",
  });
  expect(namingConfigured(config.naming)).toBe(true);
});

test("a [naming] table with only a timeout still means no generation", () => {
  const { config, problems } = parse("[naming]\ntimeout-seconds = 2\n");

  expect(problems).toEqual([]);
  expect(config.naming.timeoutSeconds).toEqual({ value: 2, source: "global" });
  expect(namingConfigured(config.naming)).toBe(false);
});

const rejectedNaming: [file: string, path: string, message: string][] = [
  ['[naming]\nmodel = "claude-haiku-4-5"\n', "naming.model", "needs a profile or an agent"],
  ['[naming]\nagent = "grok"\n', "naming.agent", "must be one of"],
  ['[naming]\nprofile = "missing"\n', "naming.profile", 'no valid profile with id "missing"'],
  ["[naming]\ntimeout-seconds = 0\n", "naming.timeout-seconds", "at least 1"],
  ["[naming]\ntimeout-seconds = 1.5\n", "naming.timeout-seconds", "whole number of seconds"],
  ['[naming]\ntimeout-seconds = "8"\n', "naming.timeout-seconds", "whole number of seconds"],
  ['[naming]\nvoice = "cheap"\n', "naming.voice", 'unknown key "voice"'],
  ["naming = 5\n", "naming", "expected a table, got a number"],
];
test.for(rejectedNaming)("%s is rejected at %s", ([file, path, message]) => {
  const { config, problems } = parse(file);

  expect(config.naming).toEqual(defaults().naming);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ severity: "error", path });
  expect(problems[0]?.message).toContain(message);
});

test("a [naming] with an invalid agent still reports the orphaned model", () => {
  const { config, problems } = parse('[naming]\nagent = "grok"\nmodel = "claude-haiku-4-5"\n');

  expect(config.naming).toEqual(defaults().naming);
  expect(problems.map((problem) => problem.path)).toEqual(["naming.agent", "naming.model"]);
});

test("resolution runs built-in default, then [tasks], then the project's table", () => {
  const { config, problems } = parse(`
[tasks]
agent = "codex"
workspace = "new-worktree"
branch-prefix = "corral/"
worktree-root = "/srv/worktrees"

[projects."${REPO}"]
branch-prefix = "app/"
`);

  expect(problems).toEqual([]);
  expect(config.tasks.agent).toEqual({ value: "codex", source: "global" });
  expect(config.projects[REPO]).toEqual({
    agent: { value: "codex", source: "global" },
    profile: { value: null, source: "default" },
    model: { value: null, source: "default" },
    workspace: { value: "new-worktree", source: "global" },
    worktreeRoot: { value: "/srv/worktrees", source: "global" },
    branchPrefix: { value: "app/", source: "project" },
    slugMode: { value: "title", source: "default" },
    view: { value: "terminal", source: "default" },
  });
  // The global task defaults are untouched by a project override.
  expect(config.tasks.branchPrefix).toEqual({ value: "corral/", source: "global" });
});

test("one project's override does not leak into another project or the global defaults", () => {
  const { config, problems } = parse(`
[projects."/repos/one"]
workspace = "new-worktree"

[projects."/repos/two"]
view = "terminal"
`);

  expect(problems).toEqual([]);
  expect(config.projects["/repos/one"]?.workspace).toEqual({
    value: "new-worktree",
    source: "project",
  });
  expect(config.projects["/repos/two"]?.workspace).toEqual({
    value: "main-worktree",
    source: "default",
  });
  expect(config.tasks.workspace).toEqual({ value: "main-worktree", source: "default" });
});

test("a project's invalid entry drops only that entry", () => {
  const { config, problems } = parse(`
[tasks]
agent = "codex"

[projects."${REPO}"]
workspace = "somewhere"
model = "gpt-5-codex"
`);

  expect(config.projects[REPO]?.workspace).toEqual({ value: "main-worktree", source: "default" });
  expect(config.projects[REPO]?.model).toEqual({ value: "gpt-5-codex", source: "project" });
  expect(config.projects[REPO]?.agent).toEqual({ value: "codex", source: "global" });
  expect(problems).toEqual([
    {
      severity: "error",
      path: `projects."${REPO}".workspace`,
      message: "must be one of main-worktree, new-worktree",
    },
  ]);
});

const rejectedProjects: [file: string, path: string, message: string][] = [
  [
    '[projects."repos/app"]\nagent = "codex"\n',
    'projects."repos/app"',
    "must be an absolute repository path",
  ],
  [
    '[projects."/repos/app/"]\nagent = "codex"\n',
    'projects."/repos/app/"',
    "must match the added path exactly",
  ],
  [
    '[projects."/repos/../app"]\nagent = "codex"\n',
    'projects."/repos/../app"',
    "must match the added path exactly",
  ],
  ['[projects]\n"/repos/app" = 5\n', 'projects."/repos/app"', "expected a table, got a number"],
  ["projects = 5\n", "projects", "expected a table, got a number"],
];
test.for(rejectedProjects)("%s is rejected at %s", ([file, path, message]) => {
  const { config, problems } = parse(file);

  expect(config.projects).toEqual({});
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ severity: "error", path });
  expect(problems[0]?.message).toContain(message);
});

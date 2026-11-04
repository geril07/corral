import {
  DEFAULT_NAMING_TIMEOUT_SECONDS,
  defaultClientConfig,
  namingConfigured,
} from "@corral/protocol/config";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { parseConfigFile } from "./config-file.ts";

const DATA_DIR = "/data";
const WORKTREES = "/data/worktrees";
const parse = (text: string) => parseConfigFile(text, DATA_DIR);
const defaults = () => defaultClientConfig(DATA_DIR);
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

test("a ~-relative worktree root is kept as written, and climbing out of home is a problem", () => {
  const home = parse('[tasks]\nworktree-root = "~"\n');
  expect(home.problems).toEqual([]);
  expect(home.config.tasks.worktreeRoot).toEqual({ value: "~", source: "global" });

  const doubled = parse('[tasks]\nworktree-root = "~//corral"\n');
  expect(doubled.problems).toEqual([]);
  expect(doubled.config.tasks.worktreeRoot).toEqual({ value: "~//corral", source: "global" });

  const climbing = parse('[tasks]\nworktree-root = "~/../wt"\n');
  expect(climbing.config.tasks.worktreeRoot.source).toBe("default");
  expect(climbing.problems).toEqual([
    {
      severity: "error",
      path: "tasks.worktree-root",
      message: 'a ~-relative worktree root may not hold ".."',
    },
  ]);
});

test("the profile's agent decides both the agent and the model check", () => {
  // The profile launches claude, so an explicit opencode agent would make a launch fail with
  // LaunchProfileKindMismatchError; it is reported and dropped, the model fits claude.
  const claude = parse(`${PROFILE}
[tasks]
agent = "opencode"
profile = "gateway"
model = "claude-sonnet-4-5"
`);
  expect(claude.config.tasks.agent).toEqual({ value: null, source: "default" });
  expect(claude.config.tasks.profile).toEqual({ value: "gateway", source: "global" });
  expect(claude.config.tasks.model).toEqual({ value: "claude-sonnet-4-5", source: "global" });
  expect(claude.problems).toEqual([
    {
      severity: "error",
      path: "tasks.agent",
      message: 'the profile "gateway" launches claude, not opencode',
    },
  ]);

  const opencode = parse(`
[profiles.oc]
name = "OpenCode team"
agent = "opencode"

[tasks]
agent = "claude"
profile = "oc"
model = "gpt-5"
`);
  expect(opencode.config.tasks.agent).toEqual({ value: null, source: "default" });
  expect(opencode.config.tasks.model.source).toBe("default");
  expect(opencode.problems).toEqual([
    {
      severity: "error",
      path: "tasks.agent",
      message: 'the profile "oc" launches opencode, not claude',
    },
    {
      severity: "error",
      path: "tasks.model",
      message: "opencode has no model flag on its launch command; a profile for it is env-only",
    },
  ]);
});

test("a project's agent that contradicts its profile is reported there too", () => {
  const { config, problems } = parse(`${PROFILE}
[projects."${REPO}"]
profile = "gateway"
agent = "codex"
`);

  expect(config.projects[REPO]?.agent).toEqual({ value: null, source: "default" });
  expect(config.projects[REPO]?.profile).toEqual({ value: "gateway", source: "project" });
  expect(problems).toEqual([
    {
      severity: "error",
      path: `projects."${REPO}".agent`,
      message: 'the profile "gateway" launches claude, not codex',
    },
  ]);
});

test("a profile from another layer that contradicts the project's agent is reported there", () => {
  const projectProfile = parse(`${PROFILE}
[tasks]
agent = "codex"

[projects."${REPO}"]
profile = "gateway"
`);
  expect(projectProfile.config.tasks.agent).toEqual({ value: "codex", source: "global" });
  expect(projectProfile.config.projects[REPO]?.agent).toEqual({
    value: null,
    source: "default",
  });
  expect(projectProfile.config.projects[REPO]?.profile).toEqual({
    value: "gateway",
    source: "project",
  });
  expect(projectProfile.problems).toEqual([
    {
      severity: "error",
      path: `projects."${REPO}"`,
      message:
        'the profile "gateway" launches claude, but this project resolves to the codex agent',
    },
  ]);

  // The other direction: the profile is global, the contradicting agent is the project's.
  const projectAgent = parse(`${PROFILE}
[tasks]
profile = "gateway"

[projects."${REPO}"]
agent = "codex"
`);
  expect(projectAgent.config.projects[REPO]?.agent).toEqual({
    value: null,
    source: "default",
  });
  expect(projectAgent.config.projects[REPO]?.profile).toEqual({
    value: "gateway",
    source: "global",
  });
  expect(projectAgent.problems).toEqual([
    {
      severity: "error",
      path: `projects."${REPO}"`,
      message:
        'the profile "gateway" launches claude, but this project resolves to the codex agent',
    },
  ]);
});

test("a naming profile that launches opencode is refused, since it cannot save no session", () => {
  const { config, problems } = parse(`
[profiles.oc]
name = "OpenCode team"
agent = "opencode"

[naming]
profile = "oc"
model = "gpt-5"
`);

  expect(config.naming.profile).toEqual({ value: null, source: "default" });
  expect(config.naming.model).toEqual({ value: null, source: "default" });
  expect(problems).toEqual([
    {
      severity: "error",
      path: "naming.profile",
      message: "opencode cannot generate names: its non-interactive mode always saves a session",
    },
  ]);
});

test("a naming agent that contradicts its profile is reported and dropped", () => {
  const { config, problems } = parse(`${PROFILE}
[naming]
profile = "gateway"
agent = "codex"
`);

  expect(config.naming.agent).toEqual({ value: null, source: "default" });
  expect(config.naming.profile).toEqual({ value: "gateway", source: "global" });
  expect(problems).toEqual([
    {
      severity: "error",
      path: "naming.agent",
      message: 'the profile "gateway" launches claude, not codex',
    },
  ]);
});

test("a naming model is checked against the winning profile's agent", () => {
  const { config, problems } = parse(`${PROFILE}
[naming]
profile = "gateway"
model = "claude-haiku-4-5"
`);

  expect(problems).toEqual([]);
  expect(config.naming.profile).toEqual({ value: "gateway", source: "global" });
  expect(config.naming.model).toEqual({ value: "claude-haiku-4-5", source: "global" });
});

test("a model its agent has no flag for is dropped while the agent applies", () => {
  const { config, problems } = parse('[tasks]\nagent = "opencode"\nmodel = "gpt-5"\n');

  expect(config.tasks.agent).toEqual({ value: "opencode", source: "global" });
  expect(config.tasks.model).toEqual({ value: null, source: "default" });
  expect(problems).toEqual([
    {
      severity: "error",
      path: "tasks.model",
      message: "opencode has no model flag on its launch command; a profile for it is env-only",
    },
  ]);
});

test("an opencode naming agent is dropped with the reason, so naming stays off", () => {
  const { config, problems } = parse('[naming]\nagent = "opencode"\nmodel = "gpt-5"\n');

  expect(config.naming.agent).toEqual({ value: null, source: "default" });
  expect(config.naming.model).toEqual({ value: null, source: "default" });
  expect(problems).toEqual([
    {
      severity: "error",
      path: "naming.agent",
      message: "opencode cannot generate names: its non-interactive mode always saves a session",
    },
  ]);
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

test("an invalid [naming] agent is reported instead of an orphaned model", () => {
  const { config, problems } = parse('[naming]\nagent = "grok"\nmodel = "claude-haiku-4-5"\n');

  expect(config.naming).toEqual(defaults().naming);
  expect(problems).toEqual([
    {
      severity: "error",
      path: "naming.agent",
      message: "must be one of claude, codex, pi, opencode",
    },
  ]);
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
    view: { value: "chat", source: "default" },
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

test("a project path that exists but cannot be resolved is a problem, not a literal key", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-config-"));
  const loop = join(dir, "loop");
  try {
    // realpathSync fails with ELOOP, which is not "the path is not there yet".
    symlinkSync(join(dir, "other"), loop);
    symlinkSync(loop, join(dir, "other"));

    const { config, problems } = parse(`[projects."${loop}"]\nagent = "codex"\n`);

    expect(config.projects).toEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: "error", path: `projects."${loop}"` });
    expect(problems[0]?.message).toContain("cannot resolve the project path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import {
  AgentKind,
  ClientConfig,
  ConfigState,
  DEFAULT_BINDINGS,
  defaultClientConfig,
} from "@corral/protocol/config";
import { symlinkSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { initRepo } from "../../test/git-repo.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { launchesOf } from "../../test/session-helpers.ts";

const server = useServer();
const agents = useFakeAgents();
const configFile = () => join(server.configDir, "config.toml");
/** The defaults of this server's data directory, including its worktree root. */
const defaults = () => defaultClientConfig(server.dataDir);

test("config.watch does not expose literal environment values or malformed TOML text", async () => {
  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  const secret = "watch-private-secret";
  await writeFile(
    configFile(),
    `[profiles.p]\nname = "P"\nagent = "pi"\nenv = [{ targetName = "TOKEN", value = "${secret}" }]\n`,
  );
  const valid = await watcher.next("the private profile");
  expect(valid.profiles[0]?.literalEnvNames).toEqual(["TOKEN"]);
  expect(JSON.stringify(valid)).not.toContain(secret);
  await writeFile(configFile(), `[profiles.p]\nenv = [{ value = "${secret}" broken }]`);
  const invalid = await watcher.next("the invalid private profile");
  expect(invalid.problems).not.toEqual([]);
  expect(JSON.stringify(invalid)).not.toContain(secret);
});
/** The host facts the fake agents on `PATH` give: all found, and every agent has a chat driver. */
const availability = () =>
  AgentKind.options.map((kind) => ({
    kind,
    found: true,
    chatDriver: true,
  }));

/** Subscribes and consumes the state the server yields on subscription. */
async function openWatcher() {
  const api = await server.rpc();
  const updates = await api.config.watch();
  const read = async (description: string): Promise<ConfigState> => {
    const state = ConfigState.parse((await within(updates.next(), description)).value);
    expect(ClientConfig.safeParse(state.config).success).toBe(true);
    return state;
  };
  return { initial: await read("the initial config"), next: read };
}

test("yields the defaults when there is no file and no config directory", async () => {
  const watcher = await openWatcher();

  expect(watcher.initial).toEqual({
    path: configFile(),
    exists: false,
    config: defaults(),
    profiles: [],
    agents: availability(),
    problems: [],
  });
});

test("picks up a config file created later, together with its directory", async () => {
  const watcher = await openWatcher();

  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), '[keys.bindings]\nnew-agent = "z"\n');

  const state = await watcher.next("the config of the new file");
  expect(state).toMatchObject({ path: configFile(), exists: true, problems: [] });
  expect(state.config.keys.bindings).toEqual({ ...DEFAULT_BINDINGS, "new-agent": "z" });
});

test("reports an absent file in an existing config directory, then the file", async () => {
  await mkdir(server.configDir, { recursive: true });
  const watcher = await openWatcher();
  expect(watcher.initial.exists).toBe(false);

  await writeFile(configFile(), "");

  const state = await watcher.next("the empty config file");
  expect(state.exists).toBe(true);
  expect(state.config).toEqual(defaults());
  expect(state.problems).toEqual([]);
});

test("an empty file flips only existence, and removing it pushes that back", async () => {
  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), "");

  const created = await watcher.next("the created empty file");
  expect(created.exists).toBe(true);
  expect(created.config).toEqual(defaults());
  expect(created.problems).toEqual([]);

  await rm(configFile());

  const removed = await watcher.next("the defaults after removing the empty file");
  expect(removed.exists).toBe(false);
  expect(removed.config).toEqual(defaults());
  expect(removed.problems).toEqual([]);
});

test("pushes an edit", async () => {
  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), '[keys.bindings]\nboard = "z"\n');
  expect((await watcher.next("the first config")).config.keys.bindings["board"]).toBe("z");

  await writeFile(configFile(), '[keys.bindings]\nboard = "y"\n');

  expect((await watcher.next("the edited config")).config.keys.bindings["board"]).toBe("y");
});

test("pushes an atomic replace: a temp file renamed over the config", async () => {
  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), '[keys]\nprefix = "alt+b"\n');
  expect((await watcher.next("the first config")).config.keys.prefix).toBe("alt+b");

  const scratch = join(server.configDir, "config.toml.tmp");
  await writeFile(scratch, '[keys]\nprefix = "alt+c"\n');
  await rename(scratch, configFile());

  expect((await watcher.next("the replaced config")).config.keys.prefix).toBe("alt+c");
});

test("an invalid edit is pushed with its problems and keeps the valid entries", async () => {
  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });

  await writeFile(configFile(), '[keys.bindings]\nnew-agent = "hyper+q"\nboard = "z"\n');
  const partial = await watcher.next("the partly invalid config");
  expect(partial.config.keys.bindings["board"]).toBe("z");
  expect(partial.config.keys.bindings["new-agent"]).toBe(DEFAULT_BINDINGS["new-agent"]);
  expect(partial.problems).toEqual([
    {
      severity: "error",
      path: "keys.bindings.new-agent",
      message: 'unknown modifier "hyper" in "hyper+q"',
    },
  ]);

  await writeFile(configFile(), "[keys\nprefix");
  const broken = await watcher.next("the unparsable config");
  expect(broken.config).toEqual(defaults());
  expect(broken.problems).toHaveLength(1);
  expect(broken.problems[0]).toMatchObject({ severity: "error", path: "" });
  expect(broken.problems[0]?.message).toMatch(/^invalid TOML at line 1, column \d+: /);
});

test("an unreadable config file is reported instead of crashing the server", async () => {
  const watcher = await openWatcher();
  await mkdir(join(server.configDir, "config.toml"), { recursive: true });

  const state = await watcher.next("the unreadable config");
  expect(state.exists).toBe(true);
  expect(state.config).toEqual(defaults());
  expect(state.problems).toEqual([
    { severity: "error", path: "", message: expect.stringContaining("cannot read the file") },
  ]);

  await rm(join(server.configDir, "config.toml"), { recursive: true });
  await writeFile(configFile(), '[keys.bindings]\nnew-agent = "z"\n');

  expect((await watcher.next("the readable config")).config.keys.bindings["new-agent"]).toBe("z");
});

test("deleting the file goes back to the defaults", async () => {
  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), '[keys]\nprefix = "alt+b"\n');
  expect((await watcher.next("the config")).config.keys.prefix).toBe("alt+b");

  await rm(configFile());

  expect(await watcher.next("the defaults after the delete")).toEqual({
    path: configFile(),
    exists: false,
    config: defaults(),
    profiles: [],
    agents: availability(),
    problems: [],
  });
});

test("a project key resolves a symlink to the path the server stored", async () => {
  const repo = initRepo(join(server.scratchDir, "real"));
  const link = join(server.scratchDir, "link");
  symlinkSync(repo, link);
  const api = await server.rpc();
  const project = await api.projects.add({ path: link });
  expect(project.path).toBe(repo);

  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), `[projects."${link}"]\nbranch-prefix = "linked/"\n`);

  const state = await watcher.next("the config with a symlinked project key");
  expect(state.problems).toEqual([]);
  expect(state.config.projects[repo]?.branchPrefix).toEqual({
    value: "linked/",
    source: "project",
  });
  expect(state.config.projects[link]).toBeUndefined();
});

test("two project keys that resolve to one repository are reported, not merged", async () => {
  const repo = initRepo(join(server.scratchDir, "real"));
  const first = join(server.scratchDir, "first");
  const second = join(server.scratchDir, "second");
  symlinkSync(repo, first);
  symlinkSync(repo, second);

  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    configFile(),
    `[projects."${first}"]\nbranch-prefix = "first/"\n\n[projects."${second}"]\nbranch-prefix = "second/"\n`,
  );

  const state = await watcher.next("the config with two keys for one repository");
  expect(state.config.projects[repo]?.branchPrefix).toEqual({
    value: "first/",
    source: "project",
  });
  expect(state.problems).toEqual([
    {
      severity: "error",
      path: `projects."${second}"`,
      message: "another project table already resolves to this path",
    },
  ]);
});

test("task creation takes the worktree root and branch prefix from the config, per project", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const root = join(server.scratchDir, "custom-worktrees");
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });

  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    configFile(),
    `[tasks]\nworktree-root = "${root}"\n\n[projects."${project.path}"]\nbranch-prefix = "proj/"\n`,
  );
  const state = await watcher.next("the config with a project branch prefix");
  expect(state.problems).toEqual([]);

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Config task",
    workspace: { type: "new-branch" },
  });

  expect(task.branch).toBe("proj/config-task");
  expect(task.workspacePath).toBe(join(root, "app", "config-task"));
});

test("a task created from a prompt starts in the configured root, under the project's prefix", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const root = join(server.scratchDir, "prompt-worktrees");
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });

  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    configFile(),
    `[tasks]\nworktree-root = "${root}"\nbranch-prefix = "corral/"\n\n[projects."${project.path}"]\nbranch-prefix = "proj/"\n`,
  );
  const state = await watcher.next("the config with a task root and a project prefix");
  expect(state.problems).toEqual([]);
  // The root comes from `[tasks]`, the prefix from the project table: the layers add up.
  expect(state.config.tasks.worktreeRoot.value).toBe(root);
  expect(state.config.projects[project.path]?.branchPrefix).toMatchObject({
    value: "proj/",
    source: "project",
  });

  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Fix the flaky login test",
    agent: { kind: "claude", view: "terminal" },
    workspace: { type: "new-branch" },
  });

  expect(task).toMatchObject({
    title: "Fix the flaky login test",
    titleSource: "seed",
    branch: "proj/fix-the-flaky-login-test",
    workspacePath: join(root, "app", "fix-the-flaky-login-test"),
  });
  const [launch] = await launchesOf(agents, "claude", 1);
  expect(launch).toMatchObject({
    cwd: task.workspacePath,
    argv: ["--session-id", expect.any(String), " Fix the flaky login test"],
  });
});

test("a new subscription asks the filesystem again, so a newly installed command is found", async () => {
  const command = join(server.scratchDir, "late-pi");
  const watcher = await openWatcher();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), `[agents.pi]\ncommand = "${command}"\n`);

  const configured = await watcher.next("the configured command");
  expect(configured.agents.find((agent) => agent.kind === "pi")?.found).toBe(false);

  // The config file is untouched: only the executable appears.
  await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const after = await openWatcher();
  expect(after.initial.agents.find((agent) => agent.kind === "pi")?.found).toBe(true);
});

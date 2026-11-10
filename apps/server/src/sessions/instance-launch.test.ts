import { ConfigState } from "@corral/protocol/config";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { FAKE_BIN, useFakeAgents } from "../../test/fake-agents.ts";
import { addTask } from "../../test/project-fixture.ts";
import { launchesOf, sessionsOf } from "../../test/session-helpers.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };
const configFile = () => join(server.configDir, "config.toml");
const LITERAL_ONE = "sk-instance-literal-one-71c4";
const LITERAL_TWO = "sk-instance-literal-two-9d2e";

afterEach(() => vi.restoreAllMocks());

/** A fake-pi executable of its own, so the launch journal says which instance's command ran. */
async function wrapper(name: string, marker: string): Promise<string> {
  const path = join(server.scratchDir, name);
  await writeFile(
    path,
    `#!/bin/sh\nINSTANCE_PROBE=${marker} exec "${join(FAKE_BIN, "pi")}" "$@"\n`,
  );
  await chmod(path, 0o755);
  return path;
}

function configFor(command: string, args: string, literal: string, extra = ""): string {
  return `
[profiles.one]
name = "One"
agent = "pi"
command = "${command}"
args = [${args}]
env = [{ targetName = "INSTANCE_TOKEN", value = "${literal}" }]
${extra}
`;
}

async function writeConfig(
  text: string,
  until: (state: ConfigState) => boolean,
): Promise<ConfigState> {
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), text);
  return watchUntil(until);
}

async function removeConfig(until: (state: ConfigState) => boolean): Promise<ConfigState> {
  await rm(configFile(), { force: true });
  return watchUntil(until);
}

async function watchUntil(until: (state: ConfigState) => boolean): Promise<ConfigState> {
  const api = await server.rpc();
  const updates = await api.config.watch();
  try {
    return await within(
      (async () => {
        for await (const raw of updates) {
          const state = ConfigState.parse(raw);
          if (until(state)) return state;
        }
        throw new Error("config.watch ended before the expected state");
      })(),
      "the config change",
    );
  } finally {
    await updates.return?.();
  }
}

function databaseContents(): string {
  const db = new DatabaseSync(join(server.dataDir, "corral.db"));
  try {
    return JSON.stringify({
      sessions: db.prepare("SELECT * FROM sessions").all(),
      launchSpecs: db.prepare("SELECT * FROM session_launch_specs").all(),
    });
  } finally {
    db.close();
  }
}

test("two instances of one agent launch their own executable, argv and environment, and a scratch primary starts in its recorded cwd", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "INSTANCE_TOKEN,INSTANCE_PROBE");
  const one = await wrapper("pi-one", "one");
  const two = await wrapper("pi-two", "two");
  await writeConfig(
    `
[profiles.one]
name = "One"
agent = "pi"
command = "${one}"
args = ["--no-skills", "--extension", "/tmp/ext-one"]
env = [{ targetName = "INSTANCE_TOKEN", value = "${LITERAL_ONE}" }]

[profiles.two]
name = "Two"
agent = "pi"
command = "${two}"
args = ["--verbose"]
env = [{ targetName = "INSTANCE_TOKEN", value = "${LITERAL_TWO}" }]
`,
    (state) => state.profiles.length === 2,
  );
  const logs: unknown[][] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args));
  vi.spyOn(console, "warn").mockImplementation((...args) => logs.push(args));
  vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args));

  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: null,
    prompt: "Instance launch",
    agent: { kind: "pi", profileId: "one", view: "terminal" },
    workspace: { type: "scratch" },
  });
  const [first] = await launchesOf(agents, "pi", 1);
  const primary = (await sessionsOf(api)).find((session) => session.id === task.primarySessionId)!;
  expect(first!.argv).toEqual([
    "--no-skills",
    "--extension",
    "/tmp/ext-one",
    "--session-id",
    primary.agentSessionId,
    "Instance launch",
  ]);
  expect(first!.envSentinels).toEqual({ INSTANCE_TOKEN: LITERAL_ONE, INSTANCE_PROBE: "one" });
  expect(first!.cwd).toBe(task.workspacePath);

  // An auxiliary terminal in the same scratch workspace is not a session and keeps its own launch.
  const loose = await api.terminals.create({ cwd: task.workspacePath, size: SIZE });
  const second = await api.sessions.start({
    taskId: task.id,
    kind: "pi",
    size: SIZE,
    profileId: "two",
  });
  const secondLaunch = (await launchesOf(agents, "pi", 2))[1]!;
  expect(secondLaunch.argv).toEqual(["--verbose", "--session-id", second.agentSessionId]);
  expect(secondLaunch.envSentinels).toEqual({ INSTANCE_TOKEN: LITERAL_TWO, INSTANCE_PROBE: "two" });
  expect(secondLaunch.cwd).toBe(task.workspacePath);
  expect((await api.terminals.list()).find((terminal) => terminal.id === loose.id)).toMatchObject({
    cwd: task.workspacePath,
    sessionId: null,
    taskId: null,
  });

  // Neither literal value reaches a session, the config feed or a log.
  const watched = await api.sessions.watch();
  const snapshot = await within(watched.next(), "the sessions");
  await watched.return?.();
  const publicPayloads = JSON.stringify([primary, second, snapshot.value]);
  const config = await api.config.watch();
  const configState = await within(config.next(), "the config");
  await config.return?.();
  for (const secret of [LITERAL_ONE, LITERAL_TWO]) {
    expect(publicPayloads).not.toContain(secret);
    expect(JSON.stringify(configState.value)).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(secret);
  }
  // The server keeps them, privately, where a restart can read them.
  const stored = databaseContents();
  expect(stored).toContain(LITERAL_ONE);
  expect(stored).toContain(LITERAL_TWO);
  expect(JSON.stringify(JSON.parse(stored).sessions)).not.toContain(LITERAL_ONE);
  expect(JSON.stringify(JSON.parse(stored).sessions)).not.toContain(LITERAL_TWO);
});

test("restarting after editing the instance resumes the captured executable, argv and literal value — also after a server restart", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "INSTANCE_TOKEN,INSTANCE_PROBE");
  const one = await wrapper("pi-one", "one");
  const two = await wrapper("pi-two", "two");
  const original = await writeConfig(configFor(one, '"--no-skills"', LITERAL_ONE), (state) =>
    state.profiles.some((profile) => profile.id === "one"),
  );
  const revision = original.profiles[0]!.revision;
  const { api, task } = await addTask(server, "Captured launch");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "pi",
    size: SIZE,
    profileId: "one",
  });
  await launchesOf(agents, "pi", 1);
  await api.sessions.stop({ id: session.id });

  // The same named instance is now another binary with another argv and another literal value.
  await writeConfig(configFor(two, '"--verbose"', LITERAL_TWO), (state) => {
    const profile = state.profiles.find((candidate) => candidate.id === "one");
    return profile !== undefined && profile.revision !== revision;
  });
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  const second = (await launchesOf(agents, "pi", 2))[1]!;
  expect(second.argv).toEqual(["--no-skills", "--session-id", session.agentSessionId]);
  expect(second.envSentinels).toEqual({ INSTANCE_TOKEN: LITERAL_ONE, INSTANCE_PROBE: "one" });
  expect(restarted.launch).toEqual(session.launch);
  expect(JSON.stringify(restarted)).not.toContain(LITERAL_ONE);
  expect(JSON.stringify(restarted)).not.toContain(LITERAL_TWO);

  // A new server reads the private spec from SQLite, not the edited config.
  await server.restart();
  const third = (await launchesOf(agents, "pi", 3))[2]!;
  expect(third.argv).toEqual(["--no-skills", "--session-id", session.agentSessionId]);
  expect(third.envSentinels).toEqual({ INSTANCE_TOKEN: LITERAL_ONE, INSTANCE_PROBE: "one" });
  const restored = (await sessionsOf(await server.rpc())).find((entry) => entry.id === session.id)!;
  expect(restored).toMatchObject({ state: "running", launch: session.launch });
});

test("a disabled or deleted instance refuses a new launch, while an existing session still restarts", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "INSTANCE_TOKEN,INSTANCE_PROBE");
  const one = await wrapper("pi-one", "one");
  await writeConfig(configFor(one, '"--no-skills"', LITERAL_ONE), (state) =>
    state.profiles.some((profile) => profile.id === "one"),
  );
  const { api, task } = await addTask(server, "Keep resumable");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "pi",
    size: SIZE,
    profileId: "one",
  });
  await launchesOf(agents, "pi", 1);
  await api.sessions.stop({ id: session.id });

  await writeConfig(configFor(one, '"--no-skills"', LITERAL_ONE, "enabled = false\n"), (state) =>
    state.profiles.some((profile) => profile.id === "one" && profile.enabled === false),
  );
  await expect(
    api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE, profileId: "one" }),
  ).rejects.toMatchObject({
    code: "LAUNCH_FAILED",
    data: { kind: "pi", message: expect.stringContaining("disabled") },
  });
  const afterDisable = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(afterDisable.state).toBe("running");
  expect((await launchesOf(agents, "pi", 2))[1]!.envSentinels).toEqual({
    INSTANCE_TOKEN: LITERAL_ONE,
    INSTANCE_PROBE: "one",
  });
  await api.sessions.stop({ id: session.id });

  await removeConfig((state) => state.profiles.length === 0);
  await expect(
    api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE, profileId: "one" }),
  ).rejects.toMatchObject({ code: "LAUNCH_PROFILE_UNKNOWN", data: { id: "one" } });
  const afterDelete = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(afterDelete.state).toBe("running");
  expect((await launchesOf(agents, "pi", 3))[2]!.argv).toEqual([
    "--no-skills",
    "--session-id",
    session.agentSessionId,
  ]);
});

test("instance arguments are refused by runtimes that own their argv, instead of being dropped", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "INSTANCE_TOKEN");
  await writeConfig(
    `
[profiles.pi-owned]
name = "Pi owns session flags"
agent = "pi"
args = ["--session-id", "stolen"]

[profiles.oc-flags]
name = "OpenCode flags"
agent = "opencode"
args = ["--no-skills"]

[profiles.claude-flags]
name = "Claude flags"
agent = "claude"
args = ["--verbose"]
`,
    (state) => state.profiles.length === 3,
  );
  const { api, task } = await addTask(server, "Refused argv");

  await expect(
    api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE, profileId: "pi-owned" }),
  ).rejects.toMatchObject({
    code: "LAUNCH_FAILED",
    data: { kind: "pi", message: expect.stringContaining("Pi arguments") },
  });
  await expect(
    api.sessions.start({ taskId: task.id, kind: "opencode", size: SIZE, profileId: "oc-flags" }),
  ).rejects.toMatchObject({
    code: "LAUNCH_FAILED",
    data: { kind: "opencode", message: expect.stringContaining("extra launch arguments") },
  });
  await expect(
    api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE, profileId: "claude-flags" }),
  ).rejects.toMatchObject({
    code: "LAUNCH_FAILED",
    data: { kind: "claude", message: expect.stringContaining("extra launch arguments") },
  });
  expect(await agents.launches()).toEqual([]);
  expect(await sessionsOf(api)).toEqual([]);
});

test("a pi chat launch puts the instance's own flags before the driver's Corral-owned argv", async () => {
  await writeConfig(
    '[profiles.pi-chat]\nname = "Pi chat"\nagent = "pi"\nargs = ["--no-skills"]\n',
    (state) => state.profiles.length === 1,
  );
  const { api, task } = await addTask(server, "Pi chat flags");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "pi",
    size: SIZE,
    profileId: "pi-chat",
    view: "chat",
  });
  const [launch] = await launchesOf(agents, "pi", 1);
  expect(launch!.argv.slice(0, 4)).toEqual(["--no-skills", "--mode", "rpc", "--session-id"]);
  expect(launch!.argv.at(-1)).toBe(session.agentSessionId);
});

import { ConfigState } from "@corral/protocol/config";
import {
  capabilityProtocols,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  ProtocolMismatchReason,
  protocolUrl,
} from "@corral/protocol/handshake";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { WebSocket as WsWebSocket } from "ws";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { claudeTranscriptExists } from "../../test/claude-transcripts.ts";
import { addTask } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { frontendArgs, launchesOf, sessionsOf, tuiLaunchesOf } from "../../test/session-helpers.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };
const configFile = () => join(server.configDir, "config.toml");
const SENTINEL_TOKEN = "sk-profile-secret-sentinel-2f6d";

afterEach(() => vi.restoreAllMocks());

async function writeConfig(
  text: string,
  until: (state: ConfigState) => boolean,
): Promise<ConfigState> {
  await mkdir(server.configDir, { recursive: true });
  await writeFile(configFile(), text);
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

function claudeProfile(model = "claude-sonnet-4-5", source = "LAUNCH_ANTHROPIC_TOKEN") {
  return `
[profiles.claude-gateway]
name = "Claude gateway"
agent = "claude"
model = "${model}"
env = [{ targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "${source}" }]
`;
}

function databaseContents(): string {
  const db = new DatabaseSync(join(server.dataDir, "corral.db"));
  try {
    return JSON.stringify(db.prepare("SELECT * FROM sessions").all());
  } finally {
    db.close();
  }
}

test("a Claude profile puts its model and referenced token into the launch, and nowhere public", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "ANTHROPIC_AUTH_TOKEN");
  vi.stubEnv("LAUNCH_ANTHROPIC_TOKEN", SENTINEL_TOKEN);
  const consoleCalls: unknown[][] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => consoleCalls.push(args));
  vi.spyOn(console, "warn").mockImplementation((...args) => consoleCalls.push(args));
  vi.spyOn(console, "error").mockImplementation((...args) => consoleCalls.push(args));
  const state = await writeConfig(claudeProfile(), (config) => config.profiles.length === 1);
  expect(state.profiles[0]).toMatchObject({
    id: "claude-gateway",
    env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "LAUNCH_ANTHROPIC_TOKEN" }],
  });
  expect(JSON.stringify(state)).not.toContain(SENTINEL_TOKEN);

  const { api, task } = await addTask(server, "Gateway");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "claude",
    size: SIZE,
    profileId: "claude-gateway",
  });
  const client = await server.attach(session.terminalId!);
  await client.waitForScreen("fake claude ready");
  const [launch] = await launchesOf(agents, "claude", 1);

  expect(launch!.argv).toEqual([
    "--model",
    "claude-sonnet-4-5",
    "--session-id",
    session.agentSessionId,
  ]);
  expect(launch!.envSentinels).toEqual({ ANTHROPIC_AUTH_TOKEN: SENTINEL_TOKEN });
  expect(session.launch).toMatchObject({
    kind: "claude",
    profile: {
      id: "claude-gateway",
      name: "Claude gateway",
      revision: expect.stringMatching(/^[0-9a-f]{12}$/),
    },
    model: "claude-sonnet-4-5",
    provider: null,
    env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "LAUNCH_ANTHROPIC_TOKEN" }],
  });
  expect(session.launchError).toBeNull();
  expect(JSON.stringify(session)).not.toContain(SENTINEL_TOKEN);

  expect(launch!.argv.join("\n")).not.toContain(SENTINEL_TOKEN);
  expect(databaseContents()).not.toContain(SENTINEL_TOKEN);
  expect(await readFile(join(server.dataDir, "corral.db"), "utf8").catch(() => "")).not.toContain(
    SENTINEL_TOKEN,
  );
  expect(JSON.stringify(consoleCalls)).not.toContain(SENTINEL_TOKEN);
});

test("a profile chooses a Codex model and native provider, and resume keeps both", async () => {
  await writeConfig(
    '[profiles.codex]\nname = "Codex"\nagent = "codex"\nmodel = "gpt-5-codex"\nprovider = "openai"\n',
    (config) => config.profiles.length === 1,
  );
  const { api, task } = await addTask(server, "Codex choice");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "codex",
    size: SIZE,
    profileId: "codex",
  });
  const [launch] = await launchesOf(agents, "codex", 1);
  expect(frontendArgs(launch!.argv)).toEqual(["-m", "gpt-5-codex", "-c", "model_provider=openai"]);
  await expect
    .poll(
      async () => (await sessionsOf(api)).find((entry) => entry.id === session.id)?.agentSessionId,
      {
        timeout: 10_000,
      },
    )
    .toBe(launch!.rolloutId);

  await api.sessions.stop({ id: session.id });
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(frontendArgs((await launchesOf(agents, "codex", 2))[1]!.argv)).toEqual([
    "-m",
    "gpt-5-codex",
    "-c",
    "model_provider=openai",
    "resume",
    launch!.rolloutId,
  ]);
  expect(restarted.launch).toEqual(session.launch);
});

test("a pi profile passes provider and model together, and settling/resuming keeps them", async () => {
  await writeConfig(
    '[profiles.pi-work]\nname = "pi work"\nagent = "pi"\nmodel = "anthropic/claude-sonnet-4:high"\nprovider = "anthropic"\n',
    (config) => config.profiles.length === 1,
  );
  const { api, task } = await addTask(server, "pi choice");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "pi",
    size: SIZE,
    profileId: "pi-work",
  });
  const first = (await launchesOf(agents, "pi", 1))[0]!;
  expect(first.argv).toEqual([
    "--provider",
    "anthropic",
    "--model",
    "anthropic/claude-sonnet-4:high",
    "--session-id",
    session.agentSessionId,
  ]);

  await api.tasks.setState({ id: task.id, state: "settled" });
  expect((await sessionsOf(api))[0]).toMatchObject({ id: session.id, state: "stopped" });
  await api.tasks.setState({ id: task.id, state: "active" });
  expect((await launchesOf(agents, "pi", 2))[1]!.argv).toEqual([
    "--provider",
    "anthropic",
    "--model",
    "anthropic/claude-sonnet-4:high",
    "--session-id",
    session.agentSessionId,
  ]);
});

test("an OpenCode profile is env-only, and its TUI attaches to the run's server instead of loading the plugin", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "OPENCODE_TEST_TOKEN");
  vi.stubEnv("LAUNCH_OPENCODE_TOKEN", SENTINEL_TOKEN);
  await writeConfig(
    `[profiles.oc]\nname = "OpenCode"\nagent = "opencode"\nenv = [{ targetName = "OPENCODE_TEST_TOKEN", fromEnv = "LAUNCH_OPENCODE_TOKEN" }]\n`,
    (config) => config.profiles.length === 1,
  );
  const { api, task } = await addTask(server, "OpenCode choice");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "opencode",
    size: SIZE,
    profileId: "oc",
  });
  const [launch] = await tuiLaunchesOf(agents, "opencode", 1);

  expect(launch!.argv).toEqual([
    "--server",
    expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    "--session",
    session.agentSessionId,
  ]);
  expect(launch!.envSentinels).toEqual({ OPENCODE_TEST_TOKEN: SENTINEL_TOKEN });
  expect(launch!.opencode).toMatchObject({ pluginPresent: false });

  await expect(
    api.sessions.start({
      taskId: task.id,
      kind: "opencode",
      size: SIZE,
      profileId: "oc",
      model: "gpt-5",
    }),
  ).rejects.toMatchObject({ code: "LAUNCH_MODEL_UNSUPPORTED", data: { kind: "opencode" } });
  expect(await tuiLaunchesOf(agents, "opencode", 1)).toHaveLength(1);
});

test("a model can be chosen without a profile; a shell or opencode refuses it", async () => {
  const { api, task } = await addTask(server, "Model only");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "claude",
    size: SIZE,
    model: "claude-opus-4-1",
  });
  const [launch] = await launchesOf(agents, "claude", 1);
  expect(launch!.argv).toEqual([
    "--model",
    "claude-opus-4-1",
    "--session-id",
    session.agentSessionId,
  ]);
  expect(session.launch).toMatchObject({
    kind: "claude",
    profile: null,
    model: "claude-opus-4-1",
    provider: null,
    env: [],
  });

  await expect(
    api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE, model: "any" }),
  ).rejects.toMatchObject({ code: "LAUNCH_MODEL_UNSUPPORTED", data: { kind: "shell" } });
  await expect(
    api.sessions.start({ taskId: task.id, kind: "codex", size: SIZE, model: "bad model" }),
  ).rejects.toMatchObject({ code: "LAUNCH_MODEL_INVALID", data: { kind: "codex" } });
  expect(await agents.launches()).toHaveLength(1);
});

test("a session with no profile or model keeps the unchanged default launch", async () => {
  const { api, task } = await addTask(server, "Default");
  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });

  expect((await launchesOf(agents, "claude", 1))[0]!.argv).toEqual([
    "--session-id",
    session.agentSessionId,
  ]);
  expect(session.launch).toBeNull();
  expect(session.launchError).toBeNull();
});

test("an invalid whole profile is not selectable, a model/provider mismatch is refused", async () => {
  await writeConfig(
    '[profiles.broken]\nname = "Broken"\nagent = "claude"\nmodel = "not a model"\nenv = [{ targetName = "TOKEN", fromEnv = "SERVER" }]\n[profiles.ok]\nname = "OK"\nagent = "pi"\n',
    (config) => config.profiles.some((profile) => profile.id === "ok"),
  );
  const { api, task } = await addTask(server, "Invalid profile");

  await expect(
    api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE, profileId: "broken" }),
  ).rejects.toMatchObject({ code: "LAUNCH_PROFILE_UNKNOWN", data: { id: "broken" } });
  await expect(
    api.sessions.start({ taskId: task.id, kind: "codex", size: SIZE, profileId: "ok" }),
  ).rejects.toMatchObject({
    code: "LAUNCH_PROFILE_KIND_MISMATCH",
    data: { id: "ok", kind: "codex" },
  });
  expect(await agents.launches()).toEqual([]);
});

test("a missing environment reference fails visibly and spawns nothing", async () => {
  await writeConfig(claudeProfile("claude-sonnet-4-5", "LAUNCH_ABSENT_TOKEN"), (config) =>
    config.profiles.some((profile) => profile.id === "claude-gateway"),
  );
  const { api, task } = await addTask(server, "Missing token");

  await expect(
    api.sessions.start({
      taskId: task.id,
      kind: "claude",
      size: SIZE,
      profileId: "claude-gateway",
    }),
  ).rejects.toMatchObject({
    code: "LAUNCH_ENV_MISSING",
    data: { profileId: "claude-gateway", name: "LAUNCH_ABSENT_TOKEN" },
  });
  expect(await agents.launches()).toEqual([]);
  expect(await sessionsOf(api)).toEqual([]);
});

test("a restore that loses a reference becomes stopped with a visible, valueless reason", async () => {
  const variable = "LAUNCH_RESTORE_TOKEN";
  const previous = process.env[variable];
  process.env[variable] = SENTINEL_TOKEN;
  try {
    await writeConfig(claudeProfile("claude-sonnet-4-5", variable), (config) =>
      config.profiles.some((profile) => profile.id === "claude-gateway"),
    );
    const { api, task } = await addTask(server, "Lost ref");
    const session = await api.sessions.start({
      taskId: task.id,
      kind: "claude",
      size: SIZE,
      profileId: "claude-gateway",
    });
    await launchesOf(agents, "claude", 1);

    delete process.env[variable];
    await server.restart();

    const restored = (await sessionsOf(await server.rpc()))[0]!;
    expect(restored).toMatchObject({ id: session.id, state: "stopped", terminalId: null });
    expect(restored.launchError).toContain(variable);
    expect(restored.launchError).not.toContain(SENTINEL_TOKEN);
    expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("editing or deleting a profile and restarting keeps the snapshot and re-resolves values", async () => {
  const variable = "LAUNCH_IMMUTABLE_TOKEN";
  const previous = process.env[variable];
  process.env[variable] = "value-one";
  try {
    vi.stubEnv("FAKE_AGENT_LOG_ENV", "ANTHROPIC_AUTH_TOKEN");
    await writeConfig(claudeProfile("claude-sonnet-4-5", variable), (config) =>
      config.profiles.some((profile) => profile.id === "claude-gateway"),
    );
    const { api, task } = await addTask(server, "Immutable");
    const session = await api.sessions.start({
      taskId: task.id,
      kind: "claude",
      size: SIZE,
      profileId: "claude-gateway",
    });
    const client = await server.attach(session.terminalId!);
    await client.waitForScreen("fake claude ready");
    client.type("hello\n");
    await client.waitForScreen("fake claude got: hello");
    await launchesOf(agents, "claude", 1);
    expect(claudeTranscriptExists(agents.claudeConfigDir, session.agentSessionId!)).toBe(true);

    // The file now describes another model; the running conversation must not change.
    await writeConfig(claudeProfile("claude-other-model", variable), (config) =>
      config.profiles.some((profile) => profile.model === "claude-other-model"),
    );
    process.env[variable] = "value-two";
    await server.restart();

    const restored = (await sessionsOf(await server.rpc()))[0]!;
    expect(restored.launch).toEqual(session.launch);
    const second = (await launchesOf(agents, "claude", 2))[1]!;
    expect(second.argv).toEqual([
      "--model",
      "claude-sonnet-4-5",
      "--resume",
      session.agentSessionId,
    ]);
    expect(second.envSentinels).toEqual({ ANTHROPIC_AUTH_TOKEN: "value-two" });

    // Deleting the profile does not make the session unlaunchable either.
    await rm(configFile());
    await server.restart();
    expect((await launchesOf(agents, "claude", 3))[2]!.argv).toEqual([
      "--model",
      "claude-sonnet-4-5",
      "--resume",
      session.agentSessionId,
    ]);
    expect((await sessionsOf(await server.rpc()))[0]!.launch).toEqual(session.launch);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("a profile cannot move an agent's config home, and Codex discovery stays where the launch sees it", async () => {
  vi.stubEnv("LAUNCH_OPENAI_KEY", "test-openai-key");
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "OPENAI_API_KEY");
  const state = await writeConfig(
    `
[profiles.moved]
name = "Moved Codex home"
agent = "codex"
env = [{ targetName = "CODEX_HOME", fromEnv = "SOME_OTHER_HOME" }]

[profiles.codex]
name = "Codex"
agent = "codex"
model = "gpt-5-codex"
env = [{ targetName = "OPENAI_API_KEY", fromEnv = "LAUNCH_OPENAI_KEY" }]
`,
    (config) =>
      config.profiles.some((profile) => profile.id === "codex") &&
      config.problems.some((problem) => problem.path === "profiles.moved"),
  );
  expect(state.profiles.map((profile) => profile.id)).toEqual(["codex"]);
  expect(state.problems).toEqual([
    { severity: "error", path: "profiles.moved", message: "env may not set a reserved variable" },
  ]);

  const { api, task } = await addTask(server, "Same env");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "codex",
    size: SIZE,
    profileId: "codex",
  });
  const [launch] = await launchesOf(agents, "codex", 1);
  expect(launch!.envSentinels).toEqual({ OPENAI_API_KEY: "test-openai-key" });
  await expect
    .poll(
      async () => (await sessionsOf(api)).find((entry) => entry.id === session.id)?.agentSessionId,
      {
        timeout: 10_000,
      },
    )
    .toBe(launch!.rolloutId);

  await api.sessions.stop({ id: session.id });
  await api.sessions.restart({ id: session.id, size: SIZE });
  expect(frontendArgs((await launchesOf(agents, "codex", 2))[1]!.argv)).toEqual([
    "-m",
    "gpt-5-codex",
    "resume",
    launch!.rolloutId,
  ]);
});

test("a failed manual restart returns the typed error and leaves a visible reason", async () => {
  const variable = "LAUNCH_MANUAL_TOKEN";
  const previous = process.env[variable];
  process.env[variable] = SENTINEL_TOKEN;
  try {
    await writeConfig(claudeProfile("claude-sonnet-4-5", variable), (config) =>
      config.profiles.some((profile) => profile.id === "claude-gateway"),
    );
    const { api, task } = await addTask(server, "Manual restart");
    const session = await api.sessions.start({
      taskId: task.id,
      kind: "claude",
      size: SIZE,
      profileId: "claude-gateway",
    });
    await launchesOf(agents, "claude", 1);
    await api.sessions.stop({ id: session.id });
    delete process.env[variable];

    await expect(api.sessions.restart({ id: session.id, size: SIZE })).rejects.toMatchObject({
      code: "LAUNCH_ENV_MISSING",
      data: { profileId: "claude-gateway", name: variable },
    });
    const stopped = (await sessionsOf(api))[0]!;
    expect(stopped).toMatchObject({ id: session.id, state: "stopped", terminalId: null });
    expect(stopped.launchError).toContain(variable);
    expect(stopped.launchError).not.toContain(SENTINEL_TOKEN);
    expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("profileId plus a model override keeps the profile identity, provider and environment", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "OPENAI_API_KEY");
  vi.stubEnv("LAUNCH_OPENAI_KEY", "test-openai-key");
  const state = await writeConfig(
    `
[profiles.codex-work]
name = "Codex work"
agent = "codex"
model = "gpt-5-codex"
provider = "work"
env = [{ targetName = "OPENAI_API_KEY", fromEnv = "LAUNCH_OPENAI_KEY" }]
`,
    (config) => config.profiles.some((profile) => profile.id === "codex-work"),
  );
  const profile = state.profiles[0]!;
  const { api, task } = await addTask(server, "Override");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "codex",
    size: SIZE,
    profileId: "codex-work",
    model: "gpt-5-codex-mini",
  });
  const [launch] = await launchesOf(agents, "codex", 1);

  expect(frontendArgs(launch!.argv)).toEqual([
    "-m",
    "gpt-5-codex-mini",
    "-c",
    "model_provider=work",
  ]);
  expect(launch!.envSentinels).toEqual({ OPENAI_API_KEY: "test-openai-key" });
  expect(session.launch).toEqual({
    kind: "codex",
    profile: { id: "codex-work", name: "Codex work", revision: profile.revision },
    model: "gpt-5-codex-mini",
    provider: "work",
    env: [{ targetName: "OPENAI_API_KEY", fromEnv: "LAUNCH_OPENAI_KEY" }],
  });
});

test("a reserved target in a saved snapshot is refused at spawn, not trusted", async () => {
  const variable = "LAUNCH_PI_SESSION_DIR";
  process.env[variable] = "/tmp/corral-pi-sessions";
  try {
    await writeConfig(
      '[profiles.claude]\nname = "Claude"\nagent = "claude"\nmodel = "claude-sonnet-4-5"\n',
      (config) => config.profiles.some((profile) => profile.id === "claude"),
    );
    const { api, task } = await addTask(server, "Reserved snapshot");
    const session = await api.sessions.start({
      taskId: task.id,
      kind: "claude",
      size: SIZE,
      profileId: "claude",
    });
    await launchesOf(agents, "claude", 1);

    const tampered = {
      ...session.launch!,
      env: [{ targetName: "PI_CODING_AGENT_SESSION_DIR", fromEnv: variable }],
    };
    const db = new DatabaseSync(join(server.dataDir, "corral.db"));
    try {
      db.prepare("UPDATE sessions SET launch_spec = ? WHERE id = ?").run(
        JSON.stringify(tampered),
        session.id,
      );
    } finally {
      db.close();
    }
    await server.restart();

    const restored = (await sessionsOf(await server.rpc()))[0]!;
    expect(restored).toMatchObject({ id: session.id, state: "stopped", terminalId: null });
    expect(restored.launchError).toBe("the saved launch sets a reserved environment variable");
    expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);

    const after = await server.rpc();
    await expect(after.sessions.restart({ id: session.id, size: SIZE })).rejects.toMatchObject({
      code: "LAUNCH_ENV_RESERVED",
      data: { name: "PI_CODING_AGENT_SESSION_DIR" },
    });
    expect((await sessionsOf(after))[0]!.launchError).toBe(
      "the saved launch sets a reserved environment variable",
    );
  } finally {
    delete process.env[variable];
  }
});

test("a profile revision pins the definition the caller saw; a changed profile spawns nothing", async () => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "OPENAI_API_KEY");
  vi.stubEnv("LAUNCH_OPENAI_KEY_A", "key-a");
  vi.stubEnv("LAUNCH_OPENAI_KEY_B", "key-b");
  const before = await writeConfig(
    `
[profiles.codex-work]
name = "Codex work"
agent = "codex"
model = "gpt-5-codex"
provider = "work-a"
env = [{ targetName = "OPENAI_API_KEY", fromEnv = "LAUNCH_OPENAI_KEY_A" }]
`,
    (config) => config.profiles.some((profile) => profile.id === "codex-work"),
  );
  const revisionA = before.profiles[0]!.revision;
  const changed = await writeConfig(
    `
[profiles.codex-work]
name = "Codex work"
agent = "codex"
model = "gpt-5-codex-mini"
provider = "work-b"
env = [{ targetName = "OPENAI_API_KEY", fromEnv = "LAUNCH_OPENAI_KEY_B" }]
`,
    (config) => config.profiles.some((profile) => profile.revision !== revisionA),
  );
  const profileB = changed.profiles[0]!;
  const { api, task } = await addTask(server, "Pinned revision");

  await expect(
    api.sessions.start({
      taskId: task.id,
      kind: "codex",
      size: SIZE,
      profileId: "codex-work",
      expectedProfileRevision: revisionA,
    }),
  ).rejects.toMatchObject({
    code: "LAUNCH_PROFILE_CHANGED",
    data: { id: "codex-work" },
  });
  expect(await agents.launches()).toEqual([]);
  expect(await sessionsOf(api)).toEqual([]);

  const session = await api.sessions.start({
    taskId: task.id,
    kind: "codex",
    size: SIZE,
    profileId: "codex-work",
    expectedProfileRevision: profileB.revision,
  });
  const [launch] = await launchesOf(agents, "codex", 1);
  expect(frontendArgs(launch!.argv)).toEqual([
    "-m",
    "gpt-5-codex-mini",
    "-c",
    "model_provider=work-b",
  ]);
  expect(launch!.envSentinels).toEqual({ OPENAI_API_KEY: "key-b" });
  expect(session.launch).toEqual({
    kind: "codex",
    profile: { id: "codex-work", name: "Codex work", revision: profileB.revision },
    model: "gpt-5-codex-mini",
    provider: "work-b",
    env: [{ targetName: "OPENAI_API_KEY", fromEnv: "LAUNCH_OPENAI_KEY_B" }],
  });

  await expect(
    api.sessions.start({
      taskId: task.id,
      kind: "codex",
      size: SIZE,
      profileId: "gone",
      expectedProfileRevision: profileB.revision,
    }),
  ).rejects.toMatchObject({ code: "LAUNCH_PROFILE_UNKNOWN", data: { id: "gone" } });
  await expect(
    api.sessions.start({
      taskId: task.id,
      kind: "claude",
      size: SIZE,
      expectedProfileRevision: profileB.revision,
    }),
  ).rejects.toMatchObject({ code: "LAUNCH_PROFILE_REVISION_UNSUPPORTED" });
  expect(await launchesOf(agents, "codex", 1)).toHaveLength(1);
});

test("an old protocol 4 client is refused before any profiled session or spawn", async () => {
  await writeConfig(claudeProfile(), (config) =>
    config.profiles.some((profile) => profile.id === "claude-gateway"),
  );
  const { api, task } = await addTask(server, "Old client");
  void task;

  const old = new WsWebSocket(
    `${server.url}/rpc?protocol=4`,
    capabilityProtocols(server.capability),
  );
  const closed = await within(
    new Promise<{ code: number; reason: string }>((resolve) =>
      old.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") })),
    ),
    "the protocol 4 close",
  );
  expect(closed.code).toBe(PROTOCOL_MISMATCH_CLOSE_CODE);
  expect(ProtocolMismatchReason.parse(JSON.parse(closed.reason))).toEqual({
    serverProtocolVersion: PROTOCOL_VERSION,
  });
  expect(PROTOCOL_VERSION).toBe(10);
  expect(await agents.launches()).toEqual([]);
  expect(await sessionsOf(api)).toEqual([]);

  const current = new WsWebSocket(
    protocolUrl(server.url, "/rpc"),
    capabilityProtocols(server.capability),
  );
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        current.once("open", () => resolve());
        current.once("error", reject);
      }),
      "the current protocol handshake",
    );
  } finally {
    current.close();
  }
});

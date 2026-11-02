import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigState } from "@corral/protocol/config";
import type { ChatSessionState } from "@corral/protocol/chat";
import type { Session } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { FAKE_BIN, useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { launchesOf, sessionsOf } from "../../test/session-helpers.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

/** Writes the server's config file and restarts it, so the state is read from disk once. */
async function writeConfig(text: string): Promise<void> {
  await mkdir(server.configDir, { recursive: true });
  await writeFile(join(server.configDir, "config.toml"), text);
  await server.restart();
}

/** The primary session of the task `tasks.create` returned, as the session watch lists it. */
async function primarySession(sessionId: string | null): Promise<Session> {
  const api = await server.rpc();
  const session = (await sessionsOf(api)).find((candidate) => candidate.id === sessionId);
  expect(session, "the task's primary session").toBeDefined();
  return session!;
}

test("a custom command is used for a launch, so no PATH lookup can find the agent", async () => {
  // Only the interpreter and the tools the test needs: the fake agents' directory is not on
  // PATH, so a launch that ignored `command` would fail with AGENT_NOT_FOUND.
  vi.stubEnv("PATH", `${dirname(process.execPath)}:/usr/bin:/bin`);
  await writeConfig(`[agents.pi]\ncommand = "${join(FAKE_BIN, "pi")}"\n`);

  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Name the files",
    agent: { kind: "pi" },
    workspace: { type: "main-worktree" },
  });

  const session = await primarySession(task.primarySessionId);
  expect(session).toMatchObject({ kind: "pi", state: "running" });
  const [terminalLaunch] = await launchesOf(agents, "pi", 1);
  expect(terminalLaunch?.argv.some((argument) => argument.trim() === "Name the files")).toBe(true);

  // The chat launch reads the same effective command; with the fake bin off PATH it can only run
  // through the override.
  const chatTask = await api.tasks.create({
    projectId: project.id,
    prompt: "Chat with the custom command",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  const chatSession = await primarySession(chatTask.primarySessionId);
  expect(chatSession).toMatchObject({ kind: "pi", view: "chat", state: "running" });
  const launches = await launchesOf(agents, "pi", 2);
  expect(launches.some((launch) => launch.argv.includes("rpc"))).toBe(true);

  // Settings' "found" uses the same effective command, not the agent's name on PATH.
  const config = await api.config.watch();
  const first = await within(config.next(), "the config");
  await config.return?.();
  const state = ConfigState.parse(first.value);
  expect(state.agents.find((agent) => agent.kind === "pi")?.found).toBe(true);
});

test("the custom command is used for a naming run too", async () => {
  vi.stubEnv("PATH", `${dirname(process.execPath)}:/usr/bin:/bin`);
  await writeConfig(
    `[agents.pi]\ncommand = "${join(FAKE_BIN, "pi")}"\n[naming]\nagent = "pi"\ntimeout-seconds = 1\n`,
  );
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Name this task",
    workspace: { type: "main-worktree" },
  });
  // The fake pi prints no name, so the seed title stays; the launch itself is the assertion.
  expect(task.title).toBe("Name this task");
  const [naming] = await launchesOf(agents, "pi", 1);
  expect(naming?.argv).toContain("-p");
  expect(naming?.argv).toContain("--no-session");
  expect(naming?.argv).toContain("--no-tools");
});

test("a disabled agent is refused and never launched", async () => {
  await writeConfig("[agents.claude]\nenabled = false\n");
  const { project } = await addProject(server);
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    title: "No agent",
    workspace: { type: "main-worktree" },
  });
  await expect(
    api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE }),
  ).rejects.toMatchObject({ code: "AGENT_DISABLED", data: { kind: "claude" } });

  // A task created with a disabled agent keeps its session, stopped, with the reason — the
  // composer never offers the agent, so this is the RPC path only.
  const refused = await api.tasks.create({
    projectId: project.id,
    prompt: "Try anyway",
    agent: { kind: "claude" },
    workspace: { type: "main-worktree" },
  });
  const session = await primarySession(refused.primarySessionId);
  expect(session.state).toBe("stopped");
  expect(session.launchError).toContain("disabled");
  expect((await agents.launches()).filter((launch) => launch.agent === "claude")).toHaveLength(0);
});

test("a task opens in its project's chat view for every agent with a driver", async () => {
  const { project } = await addProject(server);
  await writeConfig(`[projects."${project.path}"]\nview = "chat"\n`);
  const api = await server.rpc();

  const chatTask = await api.tasks.create({
    projectId: project.id,
    prompt: "Say hello",
    agent: { kind: "pi" },
    workspace: { type: "main-worktree" },
  });
  const chatSession = await primarySession(chatTask.primarySessionId);
  expect(chatSession).toMatchObject({ kind: "pi", view: "chat", state: "running" });
  // A chat session has no terminal; the fake pi's RPC mode is its live frontend.
  expect(chatSession.terminalId).toBeNull();
  const [chatLaunch] = await launchesOf(agents, "pi", 1);
  expect(chatLaunch?.argv).toContain("rpc");

  // Every shipped agent now has a driver, so a chat view is usable for each; the no-driver
  // fallback is covered where the driver set can be narrowed (`config-agents.test.ts`).
  const codexTask = await api.tasks.create({
    projectId: project.id,
    prompt: "Say hello too",
    agent: { kind: "codex" },
    workspace: { type: "main-worktree" },
  });
  const codexSession = await primarySession(codexTask.primarySessionId);
  expect(codexSession).toMatchObject({ kind: "codex", view: "chat", state: "running" });

  // No config warning: the file named no agent, so the composer (or this request) chooses one.
  const config = await api.config.watch();
  const first = await within(config.next(), "the config");
  await config.return?.();
  expect(ConfigState.parse(first.value).problems).toEqual([]);
});

test("the model and level lists come from the fake pi and a switch reaches it", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Model please",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  const session = await primarySession(task.primarySessionId);

  const updates = await api.chat.watch({ sessionId: session.id });
  /** The first snapshot or state event that satisfies `predicate`. */
  const untilState = (
    predicate: (state: ChatSessionState) => boolean,
    description: string,
  ): Promise<ChatSessionState> =>
    within(
      (async (): Promise<ChatSessionState> => {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- a stream is read one message at a time
          const message = await updates.next();
          if (message.done) throw new Error("the chat watch ended");
          const value = message.value;
          if (value.type === "snapshot") {
            if (predicate(value.snapshot.state)) return value.snapshot.state;
          } else if (value.event.type === "state" && predicate(value.event.state)) {
            return value.event.state;
          }
        }
      })(),
      description,
    );

  try {
    const state = await untilState(
      (candidate) => candidate.models.length > 0 && candidate.reasoningLevels.length > 0,
      "the model state",
    );
    expect(state.models.map((model) => model.id)).toEqual(["stub-1", "stub-2"]);
    expect(state.reasoningLevels).toEqual(["off", "low", "medium", "high"]);

    // A level the first model takes, so the switch below has one the second model does not.
    await api.chat.setReasoning({ sessionId: session.id, level: "low" });
    await untilState((candidate) => candidate.reasoning === "low", "the first level");

    await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-2" } });
    const switched = await untilState(
      (candidate) => candidate.model?.id === "stub-2" && candidate.reasoningLevels.includes("max"),
      "the new model's level list",
    );
    expect(switched.model).toEqual({ provider: "stub", id: "stub-2", name: "Stub Two" });
    // The list is the new model's, and the level pi clamped to is what the driver read back.
    expect(switched.reasoningLevels).toEqual(["off", "medium", "high", "max"]);
    expect(switched.reasoning).toBe("medium");

    // A level the new model does not take is refused by pi and reported as such.
    await expect(
      api.chat.setReasoning({ sessionId: session.id, level: "low" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
    await api.chat.setReasoning({ sessionId: session.id, level: "high" });
    await untilState((candidate) => candidate.reasoning === "high", "the new level");
  } finally {
    await updates.return?.();
  }
});

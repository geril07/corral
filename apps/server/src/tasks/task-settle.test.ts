import type { Session } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addTask } from "../../test/project-fixture.ts";
import { useServer } from "../../test/server-fixture.ts";
import { launchesOf, processExists, sessionsOf } from "../../test/session-helpers.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

/** A Claude session with a conversation, so that resuming it passes `--resume`. */
async function startTalkingClaude(
  api: Awaited<ReturnType<typeof server.rpc>>,
  taskId: string,
): Promise<Session> {
  const session = await api.sessions.start({ taskId, kind: "claude", size: SIZE });
  const client = await server.attach(session.terminalId!);
  await client.waitForScreen("fake claude ready");
  client.type("hello\n");
  await client.waitForScreen("fake claude got: hello");
  return session;
}

test("settling stops the running sessions and leaves a stopped one alone; unsettling starts only the ones that ran", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const { api, task } = await addTask(server, "Done");
  const shell = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const claude = await startTalkingClaude(api, task.id);
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  const [claudeLaunch] = await launchesOf(agents, "claude", 1);
  const [piLaunch] = await launchesOf(agents, "pi", 1);
  const stopped = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 2);
  await api.sessions.stop({ id: stopped.id });

  const settled = await api.tasks.setState({ id: task.id, state: "settled" });

  expect(settled).toEqual({ ...task, state: "settled" });
  expect(
    (await sessionsOf(api)).map((s) => [s.id, s.state, s.terminalId, s.agentSessionId]),
  ).toEqual([
    [shell.id, "stopped", null, null],
    [claude.id, "stopped", null, claude.agentSessionId],
    [pi.id, "stopped", null, pi.agentSessionId],
    [stopped.id, "stopped", null, stopped.agentSessionId],
  ]);
  expect(await api.terminals.list()).toEqual([]);
  await expect.poll(() => processExists(claudeLaunch!.pid)).toBe(false);
  await expect.poll(() => processExists(piLaunch!.pid)).toBe(false);

  const active = await api.tasks.setState({ id: task.id, state: "active" });

  expect(active).toEqual(task);
  const sessions = await sessionsOf(api);
  expect(sessions.map((s) => [s.id, s.state, s.terminalId !== null])).toEqual([
    [shell.id, "running", true],
    [claude.id, "running", true],
    [pi.id, "running", true],
    [stopped.id, "stopped", false],
  ]);
  const terminals = await api.terminals.list();
  expect(terminals.find((t) => t.sessionId === shell.id)).toMatchObject({
    command: "/bin/sh",
    args: [],
  });
  expect((await launchesOf(agents, "claude", 2))[1]!.argv).toEqual([
    "--resume",
    claude.agentSessionId,
  ]);
  expect((await launchesOf(agents, "pi", 3))[2]!.argv).toEqual(["--session-id", pi.agentSessionId]);
});

test("setting the state a task already has does nothing", async () => {
  const { api, task } = await addTask(server, "Same");
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);

  expect(await api.tasks.setState({ id: task.id, state: "active" })).toEqual(task);
  expect(await sessionsOf(api)).toEqual([pi]);

  await api.tasks.setState({ id: task.id, state: "settled" });
  // A session the user restarts by hand in a settled task survives a second settle.
  const restarted = await api.sessions.restart({ id: pi.id, size: SIZE });
  await launchesOf(agents, "pi", 2);
  expect((await api.tasks.setState({ id: task.id, state: "settled" })).state).toBe("settled");
  expect(await sessionsOf(api)).toEqual([restarted]);
  expect(await launchesOf(agents, "pi", 2)).toHaveLength(2);
});

test("a settled task's sessions are not restored after a server restart, and unsettling afterwards resumes the ones that ran", async () => {
  const { api, task } = await addTask(server, "Sleeping");
  const claude = await startTalkingClaude(api, task.id);
  const stopped = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);
  await api.sessions.stop({ id: stopped.id });
  await api.tasks.setState({ id: task.id, state: "settled" });

  await server.restart();

  const afterRestart = await server.rpc();
  expect((await sessionsOf(afterRestart)).map((s) => [s.id, s.state, s.terminalId])).toEqual([
    [claude.id, "stopped", null],
    [stopped.id, "stopped", null],
  ]);
  expect(await afterRestart.terminals.list()).toEqual([]);
  expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);

  await afterRestart.tasks.setState({ id: task.id, state: "active" });

  expect((await sessionsOf(afterRestart)).map((s) => [s.id, s.state])).toEqual([
    [claude.id, "running"],
    [stopped.id, "stopped"],
  ]);
  expect((await launchesOf(agents, "claude", 2))[1]!.argv).toEqual([
    "--resume",
    claude.agentSessionId,
  ]);
  expect(await launchesOf(agents, "pi", 1)).toHaveLength(1);
});

test("a session that was running in a task settled before the server died is stopped on restart and remembered", async () => {
  const { api, task } = await addTask(server, "Crash");
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);
  // The user restarts a session by hand in a settled task; it runs until the server goes down.
  await api.tasks.setState({ id: task.id, state: "settled" });
  await api.sessions.restart({ id: pi.id, size: SIZE });
  await launchesOf(agents, "pi", 2);

  await server.restart();

  const afterRestart = await server.rpc();
  expect((await sessionsOf(afterRestart)).map((s) => [s.state, s.terminalId])).toEqual([
    ["stopped", null],
  ]);
  await afterRestart.tasks.setState({ id: task.id, state: "active" });
  expect((await sessionsOf(afterRestart)).map((s) => s.state)).toEqual(["running"]);
  expect((await launchesOf(agents, "pi", 3))[2]!.argv).toEqual(["--session-id", pi.agentSessionId]);
});

test("a settled task can be removed, sessions and all", async () => {
  const { api, task } = await addTask(server, "Gone", "main-worktree");
  await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await api.tasks.setState({ id: task.id, state: "settled" });

  await api.tasks.remove({ id: task.id });

  expect(await sessionsOf(api)).toEqual([]);
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);
});

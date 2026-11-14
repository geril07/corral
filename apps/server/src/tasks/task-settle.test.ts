import { Task, type Session } from "@corral/protocol/rpc";
import { rm } from "node:fs/promises";
import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addTask } from "../../test/project-fixture.ts";
import { useServer } from "../../test/server-fixture.ts";
import { launchesOf, processExists, sessionsOf } from "../../test/session-helpers.ts";
import { SessionStore } from "../sessions/session-store.ts";
import { openDatabase } from "../storage/database.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

type Api = Awaited<ReturnType<typeof server.rpc>>;

/** The task's state in the watched feed, which is what the sidebar, board and header read. */
async function taskStateOf(api: Api, taskId: string): Promise<Task["state"] | undefined> {
  const updates = await api.tasks.watch();
  const first = await updates.next();
  await updates.return?.();
  return z
    .array(Task)
    .parse(first.value)
    .find((task) => task.id === taskId)?.state;
}

/** A Claude session with a conversation, so that resuming it passes `--resume`. */
async function startTalkingClaude(api: Api, taskId: string): Promise<Session> {
  const session = await api.sessions.start({ taskId, kind: "claude", size: SIZE });
  const client = await server.attach(session.terminalId!);
  await client.waitForScreen("fake claude ready");
  client.type("hello\n");
  await client.waitForScreen("fake claude got: hello");
  return session;
}

test("settling keeps every running session and its process; unsettling starts nothing", async () => {
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
  const terminalsBefore = await api.terminals.list();

  const settled = await api.tasks.setState({ id: task.id, state: "settled" });

  expect(settled).toEqual({ ...task, state: "settled" });
  expect(await taskStateOf(api, task.id)).toBe("settled");
  // Settle is metadata: every session that ran still does, with the terminal it had.
  expect(
    (await sessionsOf(api)).map((s) => [s.id, s.state, s.terminalId, s.agentSessionId]),
  ).toEqual([
    [shell.id, "running", shell.terminalId, null],
    [claude.id, "running", claude.terminalId, claude.agentSessionId],
    [pi.id, "running", pi.terminalId, pi.agentSessionId],
    [stopped.id, "stopped", null, stopped.agentSessionId],
  ]);
  expect(await api.terminals.list()).toEqual(terminalsBefore);
  expect(processExists(claudeLaunch!.pid)).toBe(true);
  expect(processExists(piLaunch!.pid)).toBe(true);
  expect(await launchesOf(agents, "pi", 2)).toHaveLength(2);

  const active = await api.tasks.setState({ id: task.id, state: "active" });

  expect(active).toEqual(task);
  // Un-settling starts nothing: the same sessions, terminals and processes are still there.
  expect(
    (await sessionsOf(api)).map((s) => [s.id, s.state, s.terminalId, s.agentSessionId]),
  ).toEqual([
    [shell.id, "running", shell.terminalId, null],
    [claude.id, "running", claude.terminalId, claude.agentSessionId],
    [pi.id, "running", pi.terminalId, pi.agentSessionId],
    [stopped.id, "stopped", null, stopped.agentSessionId],
  ]);
  expect(await api.terminals.list()).toEqual(terminalsBefore);
  expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);
  expect(await launchesOf(agents, "pi", 2)).toHaveLength(2);
});

test("starting a shell or an agent in a settled task makes it active and starts it", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const { api, task } = await addTask(server, "Settled start");
  const existing = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  await api.tasks.setState({ id: task.id, state: "settled" });

  const started = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });

  expect(started).toMatchObject({
    kind: "claude",
    state: "running",
    terminalId: expect.any(String),
  });
  expect(await taskStateOf(api, task.id)).toBe("active");
  expect(await sessionsOf(api)).toEqual([
    expect.objectContaining({ id: existing.id, state: "running", terminalId: existing.terminalId }),
    expect.objectContaining({ id: started.id, state: "running" }),
  ]);
  expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);
});

test("restarting a stopped session in a settled task makes it active and starts only that session", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const { api, task } = await addTask(server, "Wake");
  const shell = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);
  await api.sessions.stop({ id: pi.id });

  await api.tasks.setState({ id: task.id, state: "settled" });

  const restarted = await api.sessions.restart({ id: pi.id, size: SIZE });

  expect(restarted.state).toBe("running");
  expect(await taskStateOf(api, task.id)).toBe("active");
  expect(await sessionsOf(api)).toEqual([
    expect.objectContaining({ id: shell.id, state: "running", terminalId: shell.terminalId }),
    expect.objectContaining({ id: pi.id, state: "running", terminalId: expect.any(String) }),
  ]);
  // The running sibling was not restarted: settle never stopped it, so nothing resumes it.
  expect(await api.terminals.list()).toEqual([
    expect.objectContaining({ sessionId: shell.id }),
    expect.objectContaining({ sessionId: pi.id }),
  ]);
  expect(await launchesOf(agents, "pi", 2)).toHaveLength(2);
});

test("a failed restart of a settled task leaves it active and the session stopped", async () => {
  const { api, task } = await addTask(server, "Lost workspace");
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);
  await api.sessions.stop({ id: pi.id });

  await api.tasks.setState({ id: task.id, state: "settled" });
  await rm(task.workspacePath, { recursive: true, force: true });

  await expect(api.sessions.restart({ id: pi.id, size: SIZE })).rejects.toMatchObject({
    code: "LAUNCH_FAILED",
  });

  expect(await taskStateOf(api, task.id)).toBe("active");
  const [stopped] = await sessionsOf(api);
  expect(stopped).toMatchObject({ id: pi.id, state: "stopped", terminalId: null });
  expect(stopped!.launchError).toContain(task.workspacePath);
  expect(await launchesOf(agents, "pi", 1)).toHaveLength(1);
});

test("setView on a running session of a settled task opens the other view and starts nothing new", async () => {
  const { api, task } = await addTask(server, "View switch");
  const claude = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  await launchesOf(agents, "claude", 1);
  await api.tasks.setState({ id: task.id, state: "settled" });

  const changed = await api.sessions.setView({ id: claude.id, view: "chat", size: SIZE });

  // A view switch is navigation, not new work: the shelf state and the agent conversation stay.
  expect(changed).toMatchObject({
    id: claude.id,
    view: "chat",
    state: "running",
    agentSessionId: claude.agentSessionId,
  });
  expect(await taskStateOf(api, task.id)).toBe("settled");
  expect(await launchesOf(agents, "claude", 2)).toHaveLength(2);
  await api.sessions.stop({ id: claude.id });
});

test("setView on a stopped session of a settled task records the view and starts nothing", async () => {
  const { api, task } = await addTask(server, "View only");
  const claude = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  await launchesOf(agents, "claude", 1);
  await api.sessions.stop({ id: claude.id });
  await api.tasks.setState({ id: task.id, state: "settled" });

  const changed = await api.sessions.setView({ id: claude.id, view: "chat", size: SIZE });

  expect(changed).toMatchObject({
    id: claude.id,
    view: "chat",
    state: "stopped",
    terminalId: null,
  });
  expect(await taskStateOf(api, task.id)).toBe("settled");
  expect(await api.terminals.list()).toEqual([]);
  expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);
});

test("setting the state a task already has does nothing", async () => {
  const { api, task } = await addTask(server, "Same");
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);

  expect(await api.tasks.setState({ id: task.id, state: "active" })).toEqual(task);
  expect(await sessionsOf(api)).toEqual([pi]);

  await api.tasks.setState({ id: task.id, state: "settled" });
  expect((await api.tasks.setState({ id: task.id, state: "settled" })).state).toBe("settled");
  expect(await sessionsOf(api)).toEqual([
    expect.objectContaining({ id: pi.id, state: "running", terminalId: pi.terminalId }),
  ]);
  expect(await launchesOf(agents, "pi", 1)).toHaveLength(1);
});

test("a settled task's running sessions restart with the server and the task stays settled", async () => {
  const { api, task } = await addTask(server, "Sleeping");
  const claude = await startTalkingClaude(api, task.id);
  const stopped = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);
  await api.sessions.stop({ id: stopped.id });
  await api.tasks.setState({ id: task.id, state: "settled" });

  await server.restart();

  const afterRestart = await server.rpc();
  // The restore rule is the ordinary one: what ran, runs again; what the user stopped stays so.
  expect((await sessionsOf(afterRestart)).map((s) => [s.id, s.state, s.terminalId])).toEqual([
    [claude.id, "running", expect.any(String)],
    [stopped.id, "stopped", null],
  ]);
  expect(await taskStateOf(afterRestart, task.id)).toBe("settled");
  expect((await launchesOf(agents, "claude", 2))[1]!.argv).toEqual([
    "--resume",
    claude.agentSessionId,
  ]);
  expect(await launchesOf(agents, "pi", 1)).toHaveLength(1);
});

test("a settled task can be removed, sessions and all", async () => {
  const { api, task } = await addTask(server, "Gone", "main-worktree");
  await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await api.tasks.setState({ id: task.id, state: "settled" });

  await api.tasks.remove({ id: task.id });

  expect(await sessionsOf(api)).toEqual([]);
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);
  // The removed rows leave no session behind in the store either.
  const db = openDatabase(server.dataDir);
  try {
    expect(new SessionStore(db).list()).toEqual([]);
  } finally {
    db.close();
  }
});

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
import { TaskStore } from "./task-store.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

/** The task's state in the watched feed, which is what the sidebar, board and header read. */
async function taskStateOf(
  api: Awaited<ReturnType<typeof server.rpc>>,
  taskId: string,
): Promise<Task["state"] | undefined> {
  const updates = await api.tasks.watch();
  const first = await updates.next();
  await updates.return?.();
  return z
    .array(Task)
    .parse(first.value)
    .find((task) => task.id === taskId)?.state;
}

/** The sessions settle remembered for the task, read straight from the store. */
function resumableIds(taskId: string): string[] {
  const db = openDatabase(server.dataDir);
  try {
    return new SessionStore(db).listResumableOnUnsettle(taskId).map((session) => session.id);
  } finally {
    db.close();
  }
}

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

test("restarting a stopped session in a settled task makes it active and resumes the remembered sessions once", async () => {
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
    expect.objectContaining({ id: shell.id, state: "running", terminalId: expect.any(String) }),
    expect.objectContaining({ id: pi.id, state: "running", terminalId: expect.any(String) }),
  ]);
  // The remembered shell resumed once; the target was started by the restart itself.
  expect((await api.terminals.list()).filter((each) => each.sessionId === shell.id)).toHaveLength(
    1,
  );
  expect(await launchesOf(agents, "pi", 2)).toHaveLength(2);
  expect(resumableIds(task.id)).toEqual([]);

  // The remembered flags were consumed, so setting the already-active state starts nothing.
  expect((await api.tasks.setState({ id: task.id, state: "active" })).state).toBe("active");
  expect((await api.terminals.list()).filter((each) => each.sessionId === shell.id)).toHaveLength(
    1,
  );
  expect(await launchesOf(agents, "pi", 2)).toHaveLength(2);
});

test("restarting the session that ran before the task was settled resumes it once", async () => {
  const { api, task } = await addTask(server, "Wake itself");
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);

  await api.tasks.setState({ id: task.id, state: "settled" });
  expect(resumableIds(task.id)).toEqual([pi.id]);

  const restarted = await api.sessions.restart({ id: pi.id, size: SIZE });

  expect(restarted.state).toBe("running");
  expect(await taskStateOf(api, task.id)).toBe("active");
  expect(resumableIds(task.id)).toEqual([]);
  expect(await sessionsOf(api)).toEqual([
    expect.objectContaining({ id: pi.id, state: "running", terminalId: expect.any(String) }),
  ]);
  expect((await launchesOf(agents, "pi", 2))[1]!.argv).toEqual(["--session-id", pi.agentSessionId]);
});

test("a failed restart of a settled task leaves it active, the session stopped, and no stale resume", async () => {
  const { api, task } = await addTask(server, "Lost workspace");
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);

  await api.tasks.setState({ id: task.id, state: "settled" });
  expect(resumableIds(task.id)).toEqual([pi.id]);
  await rm(task.workspacePath, { recursive: true, force: true });

  await expect(api.sessions.restart({ id: pi.id, size: SIZE })).rejects.toMatchObject({
    code: "LAUNCH_FAILED",
  });

  expect(await taskStateOf(api, task.id)).toBe("active");
  expect(resumableIds(task.id)).toEqual([]);
  const [stopped] = await sessionsOf(api);
  expect(stopped).toMatchObject({ id: pi.id, state: "stopped", terminalId: null });
  expect(stopped!.launchError).toContain(task.workspacePath);
  expect(await launchesOf(agents, "pi", 1)).toHaveLength(1);
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
    expect.objectContaining({ id: pi.id, state: "stopped", terminalId: null }),
  ]);
  expect(await launchesOf(agents, "pi", 1)).toHaveLength(1);
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
  // A settle that wrote the task row and then died before stopping its sessions leaves this
  // shape: the row is settled while the process still runs.
  const db = openDatabase(server.dataDir);
  new TaskStore(db).setState(task.id, "settled");
  db.close();

  await server.restart();

  const afterRestart = await server.rpc();
  expect((await sessionsOf(afterRestart)).map((s) => [s.state, s.terminalId])).toEqual([
    ["stopped", null],
  ]);
  expect(resumableIds(task.id)).toEqual([pi.id]);
  await afterRestart.tasks.setState({ id: task.id, state: "active" });
  expect((await sessionsOf(afterRestart)).map((s) => s.state)).toEqual(["running"]);
  expect((await launchesOf(agents, "pi", 2))[1]!.argv).toEqual(["--session-id", pi.agentSessionId]);
});

test("a settled task can be removed, sessions and all", async () => {
  const { api, task } = await addTask(server, "Gone", "main-worktree");
  await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await api.tasks.setState({ id: task.id, state: "settled" });

  await api.tasks.remove({ id: task.id });

  expect(await sessionsOf(api)).toEqual([]);
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);
});

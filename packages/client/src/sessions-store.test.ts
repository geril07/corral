import { expect, test, vi } from "vite-plus/test";
import { taskStatus } from "./agent-status.ts";
import { buildBoard } from "./board.ts";
import { describeError } from "./rpc-errors.ts";
import { buildWorkspaceTree, currentEntry, resolveSelection } from "./workspace-tree.ts";
import { useFakeAgents } from "../../../apps/server/test/fake-agents.ts";
import { reportBody } from "../../../apps/server/test/osc7501.ts";
import { eventually, useServer } from "../test/server-fixture.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

async function clientWithTask() {
  const client = await server.connected();
  const { api } = client.connection;
  const project = await api.projects.add({ path: server.repo() });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Work",
    workspace: { type: "new-branch" },
  });
  return { client, api, task };
}

const treeOf = (client: Awaited<ReturnType<typeof clientWithTask>>["client"]) =>
  buildWorkspaceTree(
    client.projects.getSnapshot().projects,
    client.tasks.getSnapshot().tasks,
    client.sessions.getSnapshot().sessions,
    client.terminals.getSnapshot().terminals,
  );

test("the list starts unloaded, then follows start, stop, restart and remove", async () => {
  const client = await server.connected();
  expect(client.sessions.getSnapshot()).toEqual({ loaded: false, sessions: [] });
  await eventually(() => expect(client.sessions.getSnapshot().loaded).toBe(true));
  const { api, task } = await clientWithTask();

  const started = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  await eventually(() => expect(client.sessions.getSnapshot().sessions).toEqual([started]));
  expect(started).toMatchObject({ kind: "claude", state: "running" });

  // Claude only has a conversation to resume once a prompt was sent.
  const { stream, terminal } = await server.attachConnected(client, started.terminalId!);
  stream.input("hello\n");
  await eventually(() => expect(terminal.screen).toContain("fake claude got: hello"));

  const stopped = await api.sessions.stop({ id: started.id });
  await eventually(() => expect(client.sessions.getSnapshot().sessions).toEqual([stopped]));
  expect(stopped).toMatchObject({ state: "stopped", terminalId: null });

  const restarted = await api.sessions.restart({ id: started.id, size: SIZE });
  await eventually(() => expect(client.sessions.getSnapshot().sessions).toEqual([restarted]));
  expect(restarted).toMatchObject({ state: "running", agentSessionId: started.agentSessionId });
  await eventually(async () =>
    expect((await agents.launches()).at(-1)?.argv).toEqual(["--resume", started.agentSessionId]),
  );

  await api.sessions.remove({ id: started.id });
  await eventually(() => expect(client.sessions.getSnapshot().sessions).toEqual([]));
});

test("the tree puts a session under its task with its terminal, and a stopped one without", async () => {
  const { client, api, task } = await clientWithTask();
  const shell = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const agent = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await api.sessions.stop({ id: agent.id });

  await eventually(() => {
    const entries = treeOf(client).projects[0]?.active[0]?.sessions ?? [];
    expect(entries.map((entry) => [entry.session.kind, entry.session.state])).toEqual([
      ["shell", "running"],
      ["pi", "stopped"],
    ]);
    expect(entries.map((entry) => entry.terminal?.id)).toEqual([shell.terminalId, undefined]);
  });
  const tree = treeOf(client);
  expect(resolveSelection(tree, { taskId: task.id, entryId: agent.id })).toMatchObject({
    entryId: agent.id,
  });
  expect(currentEntry(tree, resolveSelection(tree, {}))).toMatchObject({ id: shell.id });
  expect(tree.loose).toEqual([]);

  await api.tasks.remove({ id: task.id });
  await eventually(() => {
    expect(client.sessions.getSnapshot().sessions).toEqual([]);
    expect(client.terminals.getSnapshot().terminals).toEqual([]);
  });
});

test("closing a session's terminal stops the session, and a process that ends by itself leaves it stopped", async () => {
  const { client, api, task } = await clientWithTask();
  const first = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  await api.terminals.close({ id: first.terminalId! });
  await eventually(() =>
    expect(client.sessions.getSnapshot().sessions).toMatchObject([
      { id: first.id, state: "stopped", terminalId: null },
    ]),
  );

  const agent = await api.sessions.start({ taskId: task.id, kind: "opencode", size: SIZE });
  const { stream } = await server.attachConnected(client, agent.terminalId!);
  stream.input("exit 0\n");
  await eventually(() =>
    expect(
      client.sessions.getSnapshot().sessions.find((session) => session.id === agent.id)?.state,
    ).toBe("stopped"),
  );
  // The exited terminal stays listed, so the tree can still show the session's last screen.
  const entry = treeOf(client).projects[0]?.active[0]?.sessions.find((e) => e.id === agent.id);
  expect(entry?.terminal?.exit).toEqual({ exitCode: 0 });
});

test("a missing agent and a stale session are explained", async () => {
  const { api, task } = await clientWithTask();
  vi.stubEnv("PATH", "/nonexistent");

  const missing = await api.sessions.start({ taskId: task.id, kind: "codex", size: SIZE }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(describeError(missing)).toBe("codex was not found on the server's PATH.");

  const stale = await api.sessions.stop({ id: "nope" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(describeError(stale)).toBe("This session no longer exists.");
});

test("what an agent reports reaches the session, the task's status and the board, and done outlives the agent", async () => {
  const { client, api, task } = await clientWithTask();
  const shell = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const agent = await api.sessions.start({ taskId: task.id, kind: "codex", size: SIZE });
  const { stream } = await server.attachConnected(client, agent.terminalId!);
  const statusOf = (id: string) =>
    client.sessions.getSnapshot().sessions.find((session) => session.id === id)?.status;
  expect(shell.status).toBeNull();

  const blocked = reportBody({ state: "blocked", kind: "permission", msg: "Run rm -rf build?" });
  stream.input(`osc ${blocked}\n`);
  await eventually(() =>
    expect(statusOf(agent.id)).toMatchObject({
      state: "blocked",
      kind: "permission",
      message: "Run rm -rf build?",
    }),
  );
  expect(statusOf(shell.id)).toBeNull();
  const tree = treeOf(client);
  const sessions = tree.projects[0]?.active[0]?.sessions.map((entry) => entry.session) ?? [];
  expect(taskStatus(sessions)).toMatchObject({
    sessionId: agent.id,
    status: { state: "blocked", message: "Run rm -rf build?" },
  });
  expect(buildBoard(tree)).toMatchObject([{ task: { id: task.id }, sessionId: agent.id }]);

  stream.input(`osc ${reportBody({ state: "done", msg: "All green" })}\n`);
  await eventually(() => expect(statusOf(agent.id)).toMatchObject({ state: "done" }));
  expect(buildBoard(treeOf(client))[0]?.status).toMatchObject({
    state: "done",
    message: "All green",
  });

  stream.input("exit 0\n");
  await eventually(() =>
    expect(
      client.sessions.getSnapshot().sessions.find((session) => session.id === agent.id)?.state,
    ).toBe("stopped"),
  );
  expect(statusOf(agent.id)).toMatchObject({ state: "done", message: "All green" });
  expect(buildBoard(treeOf(client))[0]?.status?.state).toBe("done");
});
